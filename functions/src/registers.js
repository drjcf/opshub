// functions/src/registers.js
// Register checks (working-document logs) + nightly expiration sweep.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  db, FieldValue, Timestamp, sha256, DAY, daysFromNow,
  requireAuth, requireOrg, requireRole, STAFF_ROLES,
  actor, audit, resolveCheckpointByToken, queueNotification,
} from './util.js';

// -------------------------------------------------------------------
// registerCheck.submit
// data: { orgId, token, taskId, registerVersionBefore,
//         verdicts: { [itemKey]: { verdict, newLot?, newExpiresAt?, newQty?, note? } },
//         clientAt?, geo? }
// -------------------------------------------------------------------

export const registerCheckSubmit = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, token, taskId, registerVersionBefore, verdicts, clientAt, geo } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!token || !taskId || !verdicts) {
    throw new HttpsError('invalid-argument', 'Missing token, taskId, or verdicts.');
  }
  const who = actor(auth);

  // Resolve checkpoint by token (outside tx; token->doc mapping is stable).
  const cps = await db.collection(`orgs/${orgId}/checkpoints`)
    .where('qrToken', '==', token).where('active', '==', true).limit(1).get();
  if (cps.empty) throw new HttpsError('not-found', 'Unknown or retired label.');
  const checkpoint = { id: cps.docs[0].id, ...cps.docs[0].data() };

  return db.runTransaction(async (tx) => {
    const taskRef = db.doc(`orgs/${orgId}/tasks/${taskId}`);
    const taskSnap = await tx.get(taskRef);
    if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found.');
    const task = taskSnap.data();
    if (task.status !== 'open' && task.status !== 'missed') {
      throw new HttpsError('failed-precondition', `Task is ${task.status}.`);
    }
    if (!task.registerId) throw new HttpsError('failed-precondition', 'Task has no register.');

    const regRef = db.doc(`orgs/${orgId}/registers/${task.registerId}`);
    const regSnap = await tx.get(regRef);
    if (!regSnap.exists) throw new HttpsError('not-found', 'Register not found.');
    const register = regSnap.data();

    if (register.version !== registerVersionBefore) {
      throw new HttpsError('aborted',
        'Register changed since form loaded. Refresh and re-verify.');
    }

    const now = Date.now();
    const leadMs = (register.leadTimeDays ?? 30) * DAY;
    const snapshotBefore = register.items.map((i) => ({ ...i }));
    const itemsAfter = [];
    const diff = [];
    const exceptions = [];
    let outOfRange = false;

    for (const item of register.items) {
      const expMs = item.expiresAt ? item.expiresAt.toMillis() : null;
      const isExpired = expMs !== null && expMs <= now;
      const isExpiringSoon = expMs !== null && !isExpired && expMs - now <= leadMs;
      const v = verdicts[item.key];

      // Flagged items REQUIRE an explicit verdict — no silent "all good".
      if ((isExpired || isExpiringSoon) && !v) {
        throw new HttpsError('failed-precondition',
          `"${item.name}" is ${isExpired ? 'EXPIRED' : 'expiring soon'} — explicit verdict required.`);
      }

      const verdict = v?.verdict ?? 'present';
      switch (verdict) {
        case 'present': {
          if (isExpired) {
            // Recorded truthfully; consequences fire. Never block the record.
            exceptions.push({ key: item.key, kind: 'expired' });
            outOfRange = true;
          } else if (isExpiringSoon) {
            exceptions.push({ key: item.key, kind: 'expiringSoon' });
          }
          if ((item.qty ?? 0) < (item.par ?? 0)) {
            exceptions.push({ key: item.key, kind: 'belowPar' });
            if (item.required) outOfRange = true;
          }
          itemsAfter.push(item);
          break;
        }
        case 'missing': {
          exceptions.push({ key: item.key, kind: 'missing' });
          if (item.required) outOfRange = true;
          itemsAfter.push(item); // still on the register; it SHOULD be there
          break;
        }
        case 'replaced': {
          if (!v.newLot || !v.newExpiresAt) {
            throw new HttpsError('invalid-argument',
              `Replacement of "${item.name}" requires newLot and newExpiresAt.`);
          }
          const newExp = Timestamp.fromMillis(v.newExpiresAt);
          if (newExp.toMillis() <= now) {
            throw new HttpsError('invalid-argument',
              `Replacement lot for "${item.name}" is already expired.`);
          }
          const updated = {
            ...item,
            lot: String(v.newLot),
            expiresAt: newExp,
            qty: v.newQty ?? item.qty,
          };
          itemsAfter.push(updated);
          diff.push({ key: item.key, change: 'replaced',
            from: { lot: item.lot, expiresAt: item.expiresAt },
            to: { lot: updated.lot, expiresAt: updated.expiresAt } });
          break;
        }
        case 'removed': {
          if (item.required) {
            throw new HttpsError('failed-precondition',
              `"${item.name}" is required and cannot be removed via check. Amend the register definition (admin).`);
          }
          diff.push({ key: item.key, change: 'removed', from: { lot: item.lot }, to: null });
          break;
        }
        default:
          throw new HttpsError('invalid-argument', `Unknown verdict "${verdict}" for ${item.key}.`);
      }
      if (v?.newQty !== undefined && verdict === 'present' && v.newQty !== item.qty) {
        const idx = itemsAfter.length - 1;
        itemsAfter[idx] = { ...itemsAfter[idx], qty: v.newQty };
        diff.push({ key: item.key, change: 'qtyChanged', from: item.qty, to: v.newQty });
      }
    }

    const newVersion = (register.version ?? 0) + 1;

    // Evidence artifact — the log page IS this document.
    const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
    tx.set(evRef, {
      type: 'checklist',
      title: task.title,
      standardRefs: task.standardRefs ?? [],
      taskId,
      checkpointId: checkpoint.id,          // top-level (Delta 02)
      registerId: task.registerId,          // top-level (Delta 02)
      payload: {
        registerId: task.registerId,
        registerVersionBefore,
        registerVersionAfter: newVersion,
        snapshotBefore,
        snapshotAfter: itemsAfter,
        diff,
        exceptions,
        outOfRange,
        scanContext: {
          checkpointId: checkpoint.id,
          qrTokenUsed: sha256(token),
          clientAt: clientAt ? Timestamp.fromMillis(clientAt) : null,
          geo: geo ?? null,
        },
      },
      attachments: [],
      status: 'finalized',
      finalizedBy: who,
      finalizedAt: FieldValue.serverTimestamp(),
      supersededBy: null, supersedes: null,
      createdBy: who, createdAt: FieldValue.serverTimestamp(),
    });

    // Apply working-state mutation — the ONLY write path to a register.
    tx.update(regRef, {
      items: itemsAfter,
      version: newVersion,
      lastCheckedAt: FieldValue.serverTimestamp(),
      lastCheckEvidenceId: evRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Close the task (missed stays missed; see Delta 01 policy).
    const tUpdate = task.status === 'open'
      ? { status: 'complete', completedBy: who, evidenceId: evRef.id }
      : { completedBy: who, evidenceId: evRef.id, lateEvidence: true };
    tx.update(taskRef, tUpdate);

    // Out-of-range consequences.
    if (outOfRange) {
      tx.set(db.collection(`orgs/${orgId}/tasks`).doc(), {
        obligationId: null,
        title: `OUT OF RANGE: ${register.title} — corrective action required`,
        standardRefs: task.standardRefs ?? [],
        checkpointId: checkpoint.id,
        registerId: task.registerId,
        dueAt: daysFromNow(1), graceUntil: daysFromNow(2),
        status: 'open', priority: 'urgent',
        assignedRole: 'clinicalDirector',
        sourceEvidenceId: evRef.id,
        generatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection(`orgs/${orgId}/notifications`).doc(), {
        toRole: 'admin', kind: 'outOfRange',
        registerId: task.registerId, evidenceId: evRef.id,
        createdAt: FieldValue.serverTimestamp(), sentAt: null,
      });
    }

    audit(tx, orgId, 'registerCheck.submit', regRef.path,
      { version: register.version }, { version: newVersion, diff: diff.length, outOfRange }, who);

    return { evidenceId: evRef.id, registerVersion: newVersion, exceptions, outOfRange };
  });
});

// -------------------------------------------------------------------
// expirationSweep — nightly per-org. Data-driven obligations from registers.
// Dedup key prevents one lot from spawning repeat tasks.
// -------------------------------------------------------------------

export const expirationSweep = onSchedule(
  { schedule: '15 3 * * *', timeZone: 'Pacific/Honolulu' }, // per-deployment tz; parameterize for licensees
  async () => {
    const orgs = await db.collection('orgs').where('status', '==', 'active').get();
    const now = Date.now();

    for (const orgDoc of orgs.docs) {
      const orgId = orgDoc.id;
      const registers = await db.collection(`orgs/${orgId}/registers`).get();

      for (const regDoc of registers.docs) {
        const reg = regDoc.data();
        const leadMs = (reg.leadTimeDays ?? 30) * DAY;
        const critMs = (reg.criticalDays ?? 7) * DAY;

        for (const item of reg.items ?? []) {
          if (!item.expiresAt) continue;
          const expMs = item.expiresAt.toMillis();
          const delta = expMs - now;

          let tier = null;
          if (delta <= 0) tier = 'expired';
          else if (delta <= critMs) tier = 'critical';
          else if (delta <= leadMs) tier = 'lead';
          if (!tier) continue;

          const dedupKey = `exp:${regDoc.id}:${item.key}:${item.lot ?? 'nolot'}:${tier}`;
          const ledgerRef = db.doc(`orgs/${orgId}/sweepLedger/${dedupKey}`);
          const seen = await ledgerRef.get();
          if (seen.exists) continue;

          const batch = db.batch();
          batch.set(ledgerRef, { createdAt: FieldValue.serverTimestamp(), tier });

          const expDate = new Date(expMs).toISOString().slice(0, 10);
          if (tier === 'expired') {
            batch.set(db.collection(`orgs/${orgId}/tasks`).doc(), {
              obligationId: null,
              title: `EXPIRED IN USE: ${item.name} lot ${item.lot ?? '—'} (${reg.title}) — remove and replace NOW`,
              standardRefs: [], registerId: regDoc.id,
              checkpointId: reg.checkpointId ?? null,
              dueAt: Timestamp.fromMillis(now), graceUntil: Timestamp.fromMillis(now + DAY),
              status: 'open', priority: 'urgent', assignedRole: 'clinicalDirector',
              generatedAt: FieldValue.serverTimestamp(),
            });
            batch.set(db.collection(`orgs/${orgId}/notifications`).doc(), {
              toRole: 'admin', kind: 'expiredInUse',
              registerId: regDoc.id, itemKey: item.key,
              createdAt: FieldValue.serverTimestamp(), sentAt: null,
            });
          } else {
            batch.set(db.collection(`orgs/${orgId}/tasks`).doc(), {
              obligationId: null,
              title: `Replace ${item.name} lot ${item.lot ?? '—'} — expires ${expDate} (${reg.title})`,
              standardRefs: [], registerId: regDoc.id,
              checkpointId: reg.checkpointId ?? null,
              dueAt: Timestamp.fromMillis(Math.min(expMs - critMs, expMs)),
              graceUntil: Timestamp.fromMillis(expMs),
              status: 'open',
              priority: tier === 'critical' ? 'urgent' : 'normal',
              assignedRole: 'clinicalDirector',
              generatedAt: FieldValue.serverTimestamp(),
            });
            if (tier === 'critical') {
              batch.set(db.collection(`orgs/${orgId}/notifications`).doc(), {
                toRole: 'clinicalDirector', kind: 'expiringCritical',
                registerId: regDoc.id, itemKey: item.key,
                createdAt: FieldValue.serverTimestamp(), sentAt: null,
              });
            }
          }
          await batch.commit();
        }
      }
    }
  }
);
