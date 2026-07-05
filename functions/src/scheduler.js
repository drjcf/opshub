// functions/src/scheduler.js
// materializeTasks: expands obligation cadences into concrete tasks.
// Runs hourly; horizon 48h; deterministic task IDs make it idempotent.
// Also flips open tasks past graceUntil to 'missed' (one-way; see policy).

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { RRule } from 'rrule';
import { db, FieldValue, Timestamp, sha256, auditDirect } from './util.js';

const HORIZON_MS = 48 * 3600 * 1000;

function expandOccurrences(cadence, from, to) {
  // cadence is an RRULE string, e.g. "FREQ=DAILY;BYHOUR=6;BYMINUTE=0"
  // dtstart anchored well in the past so BYHOUR/BYDAY govern.
  const rule = RRule.fromString(
    cadence.startsWith('DTSTART') ? cadence : `DTSTART:20250101T000000Z\nRRULE:${cadence}`
  );
  return rule.between(from, to, true);
}

export const materializeTasks = onSchedule(
  { schedule: 'every 60 minutes', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + HORIZON_MS);

    const orgs = await db.collection('orgs').where('status', '==', 'active').get();

    for (const orgDoc of orgs.docs) {
      const orgId = orgDoc.id;
      const obligations = await db
        .collection(`orgs/${orgId}/obligations`)
        .where('status', '==', 'active')
        .get();

      let created = 0;

      for (const obDoc of obligations.docs) {
        const ob = obDoc.data();
        if (!ob.cadence) continue; // one-time obligations are created with their task

        let occurrences;
        try {
          occurrences = expandOccurrences(ob.cadence, now, horizon);
        } catch (e) {
          await auditDirect(orgId, 'scheduler.badCadence', obDoc.ref.path, null, {
            error: String(e), cadence: ob.cadence,
          });
          continue;
        }

        for (const occ of occurrences) {
          // Deterministic ID = idempotency. Re-runs are no-ops.
          const taskId = `t_${sha256(`${obDoc.id}:${occ.toISOString()}`).slice(0, 24)}`;
          const taskRef = db.doc(`orgs/${orgId}/tasks/${taskId}`);
          const exists = await taskRef.get();
          if (exists.exists) continue;

          const dueAt = Timestamp.fromDate(occ);
          const graceMs = (ob.gracePeriodDays ?? 0) * 24 * 3600 * 1000;

          await taskRef.set({
            obligationId: obDoc.id,
            title: ob.title,
            standardRefs: ob.standardRefs ?? [],
            checkpointId: ob.checkpointId ?? null,
            registerId: ob.registerId ?? null,
            checklistTemplateId: ob.checklistTemplateId ?? null,
            requireScan: ob.requireScan ?? false,
            assignedRole: ob.assignedRole ?? 'staff',
            assignedUid: ob.assignedUid ?? null,
            dueAt,
            graceUntil: Timestamp.fromMillis(dueAt.toMillis() + graceMs),
            status: 'open',
            priority: 'normal',
            completedBy: null,
            evidenceId: null,
            generatedAt: FieldValue.serverTimestamp(),
          });
          created += 1;
        }
      }

      // Flip overdue-past-grace to missed. One direction only.
      const overdue = await db
        .collection(`orgs/${orgId}/tasks`)
        .where('status', '==', 'open')
        .where('graceUntil', '<', Timestamp.now())
        .limit(400)
        .get();

      if (!overdue.empty) {
        const batch = db.batch();
        for (const t of overdue.docs) {
          batch.update(t.ref, { status: 'missed', missedAt: FieldValue.serverTimestamp() });
        }
        await batch.commit();
        await auditDirect(orgId, 'scheduler.markMissed', `orgs/${orgId}/tasks`, null, {
          count: overdue.size,
        });
      }

      if (created > 0) {
        await auditDirect(orgId, 'scheduler.materialize', `orgs/${orgId}/tasks`, null, { created });
      }
    }
  }
);
