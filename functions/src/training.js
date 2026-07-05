// functions/src/training.js — Session B (Delta 03)
// Personnel lifecycle triggers, training sweep, attestation + external-cert
// completion paths, and the matrix projection.
// NOTE: trainingRecords carry denormalized { orgId, staffId } for
// collection-group queries (records live under orgs/{orgId}/personnel/{staffId}).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import {
  db, FieldValue, Timestamp, DAY, sha256,
  requireAuth, requireOrg, requireRole,
  actor, audit, auditDirect, queueNotification,
} from './util.js';

// ---------- cadence → expiry ----------
function computeExpiresAt(cadence, completedAtMs) {
  switch (cadence) {
    case 'once': return null;
    case 'annual': return Timestamp.fromMillis(completedAtMs + 365 * DAY);
    case 'biennial': return Timestamp.fromMillis(completedAtMs + 730 * DAY);
    default:
      // rrule cadences: conservative annual until per-rule computation lands (Session C polish)
      return Timestamp.fromMillis(completedAtMs + 365 * DAY);
  }
}

function requirementApplies(req, personnel) {
  const a = req.appliesTo ?? {};
  const roleOk =
    !a.roles || a.roles === 'all' ||
    (personnel.appRoles ?? []).some((r) => a.roles.includes(r));
  const catOk =
    !a.categories || a.categories === 'all' ||
    a.categories.includes(personnel.category);
  return roleOk && catOk;
}

// ---------- materialization core ----------
async function materializeForStaff(orgId, staffId, personnel) {
  const reqs = await db
    .collection(`orgs/${orgId}/trainingRequirements`)
    .where('active', '==', true)
    .get();

  const hireMs = personnel.hireDate?.toMillis?.() ?? Date.now();
  let assigned = 0;

  for (const reqDoc of reqs.docs) {
    const req = reqDoc.data();
    if (!requirementApplies(req, personnel)) continue;

    const recRef = db.doc(`orgs/${orgId}/personnel/${staffId}/trainingRecords/${reqDoc.id}`);
    const existing = await recRef.get();
    if (existing.exists) continue;

    const dueMs = req.dueWithinDaysOfHire
      ? hireMs + req.dueWithinDaysOfHire * DAY
      : Date.now() + 30 * DAY;

    await recRef.set({
      orgId, staffId,                       // denormalized for CG queries
      requirementId: reqDoc.id,
      requirementTitle: req.title,          // snapshot for matrix rendering
      sourceKind: req.source?.kind ?? 'attestation',
      status: 'due',
      assignedAt: FieldValue.serverTimestamp(),
      dueAt: Timestamp.fromMillis(dueMs),
      completedAt: null, expiresAt: null,
      evidenceId: null, exemption: null,
      lmsEnrollment: null,
    });
    assigned += 1;

    // LMS-sourced → auto-enroll in each course at its current published version.
    if (req.source?.kind === 'lms') {
      for (const courseId of req.source.courseIds ?? []) {
        const course = await db.doc(`orgs/${orgId}/courses/${courseId}`).get();
        if (!course.exists || (course.get('currentVersion') ?? 0) === 0) {
          await db.collection(`orgs/${orgId}/notifications`).add({
            toRole: 'admin', kind: 'courseUnpublished',
            courseId, requirementId: reqDoc.id,
            createdAt: FieldValue.serverTimestamp(), sentAt: null,
          });
          continue;
        }
        await db.doc(`orgs/${orgId}/enrollments/${staffId}_${courseId}`).set({
          staffId, staffUid: personnel.uid ?? null, courseId,
          courseVersion: course.get('currentVersion'),
          source: 'requirement', requirementId: reqDoc.id,
          status: 'assigned', progress: {},
          startedAt: null, completedAt: null, finalScore: null,
          assignedBy: 'system', assignedAt: FieldValue.serverTimestamp(),
        }, { merge: false });
      }
    }
  }

  if (assigned > 0) {
    await db.collection(`orgs/${orgId}/notifications`).add({
      toUid: personnel.uid ?? null,
      toRole: personnel.uid ? null : 'clinicalDirector',
      kind: 'trainingAssigned', staffId, count: assigned,
      createdAt: FieldValue.serverTimestamp(), sentAt: null,
    });
    await auditDirect(orgId, 'training.materialize', `orgs/${orgId}/personnel/${staffId}`, null, { assigned });
  }
  return assigned;
}

// ---------- triggers ----------
export const onPersonnelCreated = onDocumentCreated(
  'orgs/{orgId}/personnel/{staffId}',
  async (event) => {
    if (!event.data) return;
    await materializeForStaff(event.params.orgId, event.params.staffId, event.data.data());
  }
);

export const onPersonnelUpdated = onDocumentUpdated(
  'orgs/{orgId}/personnel/{staffId}',
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    const roleChanged =
      before.category !== after.category ||
      JSON.stringify(before.appRoles ?? []) !== JSON.stringify(after.appRoles ?? []);
    if (!roleChanged) return;

    const { orgId, staffId } = event.params;
    // Add newly-applicable requirements…
    await materializeForStaff(orgId, staffId, after);

    // …and exempt (never delete) records that no longer apply.
    const recs = await db.collection(`orgs/${orgId}/personnel/${staffId}/trainingRecords`).get();
    for (const rec of recs.docs) {
      if (rec.get('exemption')) continue;
      const req = await db.doc(`orgs/${orgId}/trainingRequirements/${rec.get('requirementId')}`).get();
      if (!req.exists) continue;
      if (!requirementApplies(req.data(), after) && rec.get('status') !== 'complete') {
        await rec.ref.update({
          status: 'exempt',
          exemption: { reason: 'role change', approvedBy: 'system', at: Timestamp.now() },
        });
      }
    }
    await auditDirect(orgId, 'training.roleChangeReconcile', `orgs/${orgId}/personnel/${staffId}`, null, null);
  }
);

// ---------- nightly training sweep ----------
export const trainingSweep = onSchedule(
  { schedule: '30 3 * * *', timeZone: 'Pacific/Honolulu' },
  async () => {
    const now = Date.now();
    const LEAD = 30 * DAY;

    // Denormalized orgId makes the collection-group query clean.
    const expiring = await db.collectionGroup('trainingRecords')
      .where('status', '==', 'complete')
      .where('expiresAt', '<=', Timestamp.fromMillis(now + LEAD))
      .limit(500).get();

    for (const rec of expiring.docs) {
      const r = rec.data();
      const dedupKey = `trn:${r.staffId}:${r.requirementId}:${r.expiresAt.toMillis()}`;
      const ledger = db.doc(`orgs/${r.orgId}/sweepLedger/${dedupKey}`);
      if ((await ledger.get()).exists) continue;

      const batch = db.batch();
      batch.set(ledger, { createdAt: FieldValue.serverTimestamp(), tier: 'renewal' });
      batch.update(rec.ref, { status: 'due', dueAt: r.expiresAt });
      batch.set(db.collection(`orgs/${r.orgId}/tasks`).doc(), {
        obligationId: null,
        title: `Renew: ${r.requirementTitle} — ${r.staffId}`,
        standardRefs: [], checkpointId: null, registerId: null,
        trainingRef: { staffId: r.staffId, requirementId: r.requirementId },
        dueAt: r.expiresAt,
        graceUntil: Timestamp.fromMillis(r.expiresAt.toMillis() + 14 * DAY),
        status: 'open', priority: 'normal',
        assignedUid: null, assignedRole: 'clinicalDirector',
        generatedAt: FieldValue.serverTimestamp(),
      });
      queueNotification(batch, r.orgId, {
        toRole: 'clinicalDirector', kind: 'trainingExpiring',
        staffId: r.staffId, requirementId: r.requirementId,
      });
      await batch.commit();

      // Re-enroll LMS-sourced renewals at the CURRENT published version.
      if (r.sourceKind === 'lms') {
        const req = await db.doc(`orgs/${r.orgId}/trainingRequirements/${r.requirementId}`).get();
        for (const courseId of req.get('source')?.courseIds ?? []) {
          const course = await db.doc(`orgs/${r.orgId}/courses/${courseId}`).get();
          if (!course.exists || (course.get('currentVersion') ?? 0) === 0) continue;
          await db.doc(`orgs/${r.orgId}/enrollments/${r.staffId}_${courseId}`).set({
            staffId: r.staffId, staffUid: null, courseId,
            courseVersion: course.get('currentVersion'),
            source: 'requirement', requirementId: r.requirementId,
            status: 'assigned', progress: {},
            startedAt: null, completedAt: null, finalScore: null,
            assignedBy: 'system', assignedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    }

    // Overdue past grace → expired + escalation.
    const overdue = await db.collectionGroup('trainingRecords')
      .where('status', '==', 'due')
      .where('dueAt', '<', Timestamp.fromMillis(now - 14 * DAY))
      .limit(500).get();
    for (const rec of overdue.docs) {
      const r = rec.data();
      await rec.ref.update({ status: 'expired' });
      await db.collection(`orgs/${r.orgId}/notifications`).add({
        toRole: 'admin', kind: 'trainingExpiring',
        staffId: r.staffId, requirementId: r.requirementId, escalated: true,
        createdAt: FieldValue.serverTimestamp(), sentAt: null,
      });
    }
  }
);

// ---------- completion path: attestation ----------
export const trainingAttest = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, staffId, requirementId } = req.data || {};
  requireOrg(auth, orgId);
  const who = actor(auth);

  return db.runTransaction(async (tx) => {
    const recRef = db.doc(`orgs/${orgId}/personnel/${staffId}/trainingRecords/${requirementId}`);
    const [recSnap, staffSnap, reqSnap] = await Promise.all([
      tx.get(recRef),
      tx.get(db.doc(`orgs/${orgId}/personnel/${staffId}`)),
      tx.get(db.doc(`orgs/${orgId}/trainingRequirements/${requirementId}`)),
    ]);
    if (!recSnap.exists || !reqSnap.exists) throw new HttpsError('not-found', 'Record or requirement missing.');
    // Attestation must be BY the person it certifies.
    if (staffSnap.get('uid') !== auth.uid) {
      throw new HttpsError('permission-denied', 'Attestation must be made by the staff member themself.');
    }
    const reqData = reqSnap.data();
    if (reqData.source?.kind !== 'attestation') {
      throw new HttpsError('failed-precondition', 'Requirement is not attestation-sourced.');
    }

    const docRef = db.doc(`orgs/${orgId}/documents/${reqData.source.documentId}`);
    const docSnap = await tx.get(docRef);
    if (!docSnap.exists) throw new HttpsError('failed-precondition', 'Bound document missing.');
    const versionId = docSnap.get('currentVersionId');
    if (!versionId) throw new HttpsError('failed-precondition', 'Document has no approved version.');
    const verSnap = await tx.get(db.doc(`orgs/${orgId}/documents/${reqData.source.documentId}/versions/${versionId}`));
    const versionSha = verSnap.get('sha256') ?? null;

    const now = Date.now();
    const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
    tx.set(evRef, {
      type: 'training',
      title: `Attestation: ${reqData.title} — ${staffSnap.get('displayName') ?? staffId}`,
      standardRefs: reqData.standardRefs ?? [],
      taskId: null, checkpointId: null, registerId: null,
      payload: {
        source: 'attestation',
        documentId: reqData.source.documentId,
        documentVersionId: versionId,
        versionSha256: versionSha,
        attestedBy: who,
        staffId, requirementId,
      },
      attachments: [], status: 'finalized',
      finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
      supersededBy: null, supersedes: null,
      createdBy: who, createdAt: FieldValue.serverTimestamp(),
    });

    tx.update(recRef, {
      status: 'complete',
      completedAt: FieldValue.serverTimestamp(),
      expiresAt: computeExpiresAt(reqData.cadence, now),
      evidenceId: evRef.id,
    });
    audit(tx, orgId, 'training.attest', recRef.path, null, { evidenceId: evRef.id }, who);
    return { evidenceId: evRef.id };
  });
});

// ---------- completion path: external certificate ----------
export const trainingApproveExternal = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, staffId, requirementId, evidenceId, cardExpiresAt } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  return db.runTransaction(async (tx) => {
    const evRef = db.doc(`orgs/${orgId}/evidence/${evidenceId}`);
    const recRef = db.doc(`orgs/${orgId}/personnel/${staffId}/trainingRecords/${requirementId}`);
    const [evSnap, recSnap] = await Promise.all([tx.get(evRef), tx.get(recRef)]);
    if (!evSnap.exists || !recSnap.exists) throw new HttpsError('not-found', 'Evidence or record missing.');
    if (evSnap.get('status') !== 'draft') throw new HttpsError('failed-precondition', 'Evidence is not a reviewable draft.');
    if ((evSnap.get('attachments') ?? []).length === 0) {
      throw new HttpsError('failed-precondition', 'External cert approval requires an uploaded attachment.');
    }

    const expiry = cardExpiresAt ? Timestamp.fromMillis(cardExpiresAt) : null;
    tx.update(evRef, {
      status: 'finalized',
      finalizedBy: who,
      finalizedAt: FieldValue.serverTimestamp(),
      'payload.reviewedBy': who,
      'payload.cardExpiresAt': expiry,
    });
    tx.update(recRef, {
      status: 'complete',
      completedAt: FieldValue.serverTimestamp(),
      expiresAt: expiry,           // card's own date governs, not cadence math
      evidenceId,
    });
    audit(tx, orgId, 'training.approveExternal', recRef.path, null, { evidenceId }, who);
    return { ok: true };
  });
});

// ---------- matrix projection ----------
// Serves staff/admin AND surveyors without exposing the personnel subtree.
export const trainingMatrix = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  const roles = auth.token.roles || [];
  const isSurveyor = roles.includes('surveyor');
  if (isSurveyor && !(auth.token.surveyorUntil > Date.now())) {
    throw new HttpsError('permission-denied', 'Surveyor access expired.');
  }
  if (!isSurveyor) requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  const [reqs, personnel] = await Promise.all([
    db.collection(`orgs/${orgId}/trainingRequirements`).where('active', '==', true).get(),
    db.collection(`orgs/${orgId}/personnel`).get(),
  ]);

  const rows = [];
  for (const p of personnel.docs) {
    const recs = await p.ref.collection('trainingRecords').get();
    const cells = {};
    for (const r of recs.docs) {
      const d = r.data();
      cells[d.requirementId] = {
        status: d.status,
        dueAt: d.dueAt ?? null,
        expiresAt: d.expiresAt ?? null,
        evidenceId: d.evidenceId ?? null,
        exemptReason: d.exemption?.reason ?? null,
      };
    }
    rows.push({
      staffId: p.id,
      displayName: p.get('displayName') ?? p.id,
      category: p.get('category') ?? null,
      cells,
    });
  }

  return {
    requirements: reqs.docs.map((d) => ({ id: d.id, title: d.get('title'), cadence: d.get('cadence') })),
    rows,
    generatedAt: Date.now(),
  };
});
