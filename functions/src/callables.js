// functions/src/callables.js
// OpsHub write choke points. Node 20 ESM, firebase-functions v2, firebase-admin v13.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { randomBytes } from 'node:crypto';
import {
  db, FieldValue, Timestamp, sha256,
  requireAuth, requireOrg, requireRole, STAFF_ROLES,
  actor, audit, resolveCheckpointByToken, queueNotification,
} from './util.js';

// Validate answers against a checklist template. Returns { answers, outOfRange }.
function validateAnswers(template, raw) {
  const answers = {};
  let outOfRange = false;
  for (const f of template.fields) {
    const v = raw?.[f.key];
    const missing = v === undefined || v === null || v === '';
    if (f.required && missing) {
      throw new HttpsError('invalid-argument', `Missing required field: ${f.label}`);
    }
    if (missing) continue;
    switch (f.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          throw new HttpsError('invalid-argument', `${f.label} must be a number.`);
        }
        if (f.range && (n < f.range.min || n > f.range.max)) outOfRange = true;
        answers[f.key] = n;
        break;
      }
      case 'bool':
        if (typeof v !== 'boolean') {
          throw new HttpsError('invalid-argument', `${f.label} must be true/false.`);
        }
        // A "false" on a pass/fail item is an out-of-range condition.
        if (f.range === null && v === false && f.failIsException) outOfRange = true;
        answers[f.key] = v;
        break;
      case 'select':
        if (!f.options?.includes(v)) {
          throw new HttpsError('invalid-argument', `${f.label}: invalid option.`);
        }
        answers[f.key] = v;
        break;
      case 'text':
        answers[f.key] = String(v).slice(0, 2000);
        break;
      default:
        throw new HttpsError('failed-precondition', `Unknown field type: ${f.type}`);
    }
  }
  return { answers, outOfRange };
}

// ---------------- scan.resolve ----------------
// Token -> checkpoint + open tasks + templates. Never expose token queries client-side.

export const scanResolve = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, token } = req.data || {};
  requireOrg(auth, orgId);
  if (!token) throw new HttpsError('invalid-argument', 'Missing token.');

  const cps = await db
    .collection(`orgs/${orgId}/checkpoints`)
    .where('qrToken', '==', token)
    .where('active', '==', true)
    .limit(1)
    .get();
  if (cps.empty) throw new HttpsError('not-found', 'Label retired or unknown. Report this label.');

  const cp = { id: cps.docs[0].id, ...cps.docs[0].data() };

  const now = Timestamp.now();
  const tasksSnap = await db
    .collection(`orgs/${orgId}/tasks`)
    .where('checkpointId', '==', cp.id)
    .where('status', '==', 'open')
    .where('dueAt', '<=', Timestamp.fromMillis(now.toMillis() + 36 * 3600 * 1000))
    .orderBy('dueAt')
    .limit(10)
    .get();

  const tasks = tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const templateIds = new Set(tasks.map((t) => t.checklistTemplateId).filter(Boolean));
  if (cp.allowAdhocLog && cp.adhocTemplateId) templateIds.add(cp.adhocTemplateId);
  const templates = {};
  await Promise.all(
    [...templateIds].map(async (tid) => {
      const t = await db.doc(`orgs/${orgId}/checklistTemplates/${tid}`).get();
      if (t.exists) templates[tid] = t.data();
    })
  );

  // Last completed at this point — useful "status at a glance" on the scan page.
  const last = await db
    .collection(`orgs/${orgId}/evidence`)
    .where('payload.scanContext.checkpointId', '==', cp.id)
    .orderBy('finalizedAt', 'desc')
    .limit(1)
    .get();

  return {
    checkpoint: { id: cp.id, label: cp.label, location: cp.location, allowAdhocLog: cp.allowAdhocLog, adhocTemplateId: cp.adhocTemplateId ?? null },
    openTasks: tasks,
    templates,
    lastEntry: last.empty ? null : { id: last.docs[0].id, finalizedAt: last.docs[0].get('finalizedAt'), title: last.docs[0].get('title') },
  };
});

// ---------------- shared scan-submit core ----------------

async function submitScanEvidence({ orgId, auth, checkpoint, template, templateId, taskId, rawAnswers, clientAt, geo, token }) {
  const who = actor(auth);
  const { answers, outOfRange } = validateAnswers(template, rawAnswers);

  return db.runTransaction(async (tx) => {
    let task = null;
    let taskRef = null;
    if (taskId) {
      taskRef = db.doc(`orgs/${orgId}/tasks/${taskId}`);
      const tSnap = await tx.get(taskRef);
      if (!tSnap.exists) throw new HttpsError('not-found', 'Task not found.');
      task = tSnap.data();
      if (task.status !== 'open' && task.status !== 'missed') {
        throw new HttpsError('failed-precondition', `Task is ${task.status}.`);
      }
      if (task.checkpointId !== checkpoint.id) {
        throw new HttpsError('failed-precondition', 'Task does not belong to this checkpoint.');
      }
    }

    const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
    const evidence = {
      type: template.evidenceType,
      title: task ? task.title : `${template.title} — ${checkpoint.label}`,
      standardRefs: task?.standardRefs ?? template.standardRefs ?? [],
      taskId: taskId ?? null,
      payload: {
        templateId,
        templateVersionHash: sha256(JSON.stringify(template.fields)),
        answers,
        outOfRange,
        scanContext: {
          checkpointId: checkpoint.id,
          qrTokenUsed: sha256(token),
          clientAt: clientAt ? Timestamp.fromMillis(clientAt) : null,
          geo: geo ?? null,
        },
      },
      attachments: [],
      status: 'finalized',            // authenticated submit IS the attestation
      finalizedBy: who,
      finalizedAt: FieldValue.serverTimestamp(),
      supersededBy: null,
      supersedes: null,
      createdBy: who,
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.set(evRef, evidence);

    if (taskRef) {
      // A 'missed' task stays missed; evidence links to it as late completion.
      const update = task.status === 'open'
        ? { status: 'complete', completedBy: who, evidenceId: evRef.id }
        : { completedBy: who, evidenceId: evRef.id, lateEvidence: true };
      tx.update(taskRef, update);
      audit(tx, orgId, 'task.completeFromScan', taskRef.path, { status: task.status }, update, who);
    }

    if (outOfRange && template.onOutOfRange) {
      const oor = template.onOutOfRange;
      if (oor.createFollowupTask) {
        const fuRef = db.collection(`orgs/${orgId}/tasks`).doc();
        tx.set(fuRef, {
          obligationId: null,
          title: `OUT OF RANGE: ${checkpoint.label} — investigate & document corrective action`,
          standardRefs: evidence.standardRefs,
          checkpointId: checkpoint.id,
          dueAt: Timestamp.fromMillis(Date.now() + 24 * 3600 * 1000),
          graceUntil: Timestamp.fromMillis(Date.now() + 48 * 3600 * 1000),
          status: 'open',
          assignedRole: oor.followupRole ?? 'clinicalDirector',
          sourceEvidenceId: evRef.id,
          generatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (oor.notifyRole) {
        tx.set(db.collection(`orgs/${orgId}/notifications`).doc(), {
          toRole: oor.notifyRole,
          kind: 'outOfRange',
          checkpointId: checkpoint.id,
          evidenceId: evRef.id,
          createdAt: FieldValue.serverTimestamp(),
          sentAt: null,               // Resend dispatcher picks this up
        });
      }
    }

    audit(tx, orgId, 'evidence.createFromScan', evRef.path, null, { outOfRange, templateId }, who);
    return { evidenceId: evRef.id, outOfRange };
  });
}

// ---------------- task.completeFromScan ----------------

export const taskCompleteFromScan = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, token, taskId, answers, clientAt, geo } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!token || !taskId) throw new HttpsError('invalid-argument', 'Missing token or taskId.');

  const cps = await db.collection(`orgs/${orgId}/checkpoints`)
    .where('qrToken', '==', token).where('active', '==', true).limit(1).get();
  if (cps.empty) throw new HttpsError('not-found', 'Unknown label.');
  const checkpoint = { id: cps.docs[0].id, ...cps.docs[0].data() };

  const task = await db.doc(`orgs/${orgId}/tasks/${taskId}`).get();
  if (!task.exists) throw new HttpsError('not-found', 'Task not found.');
  const templateId = task.get('checklistTemplateId');
  const tSnap = await db.doc(`orgs/${orgId}/checklistTemplates/${templateId}`).get();
  if (!tSnap.exists) throw new HttpsError('failed-precondition', 'Template missing.');

  return submitScanEvidence({
    orgId, auth, checkpoint, template: tSnap.data(), templateId,
    taskId, rawAnswers: answers, clientAt, geo, token,
  });
});

// ---------------- log.adhoc (scan with no open task) ----------------

export const logAdhoc = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, token, answers, clientAt, geo } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  const cps = await db.collection(`orgs/${orgId}/checkpoints`)
    .where('qrToken', '==', token).where('active', '==', true).limit(1).get();
  if (cps.empty) throw new HttpsError('not-found', 'Unknown label.');
  const checkpoint = { id: cps.docs[0].id, ...cps.docs[0].data() };
  if (!checkpoint.allowAdhocLog || !checkpoint.adhocTemplateId) {
    throw new HttpsError('failed-precondition', 'Ad-hoc logging not enabled at this point.');
  }
  const tSnap = await db.doc(`orgs/${orgId}/checklistTemplates/${checkpoint.adhocTemplateId}`).get();
  if (!tSnap.exists) throw new HttpsError('failed-precondition', 'Template missing.');

  return submitScanEvidence({
    orgId, auth, checkpoint, template: tSnap.data(), templateId: checkpoint.adhocTemplateId,
    taskId: null, rawAnswers: answers, clientAt, geo, token,
  });
});

// ---------------- evidence.finalize (non-scan drafts) ----------------

export const evidenceFinalize = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, evidenceId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/evidence/${evidenceId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Evidence not found.');
    const ev = snap.data();
    if (ev.status !== 'draft') throw new HttpsError('failed-precondition', `Already ${ev.status}.`);
    if (ev.createdBy.uid !== auth.uid && !(auth.token.roles || []).some((r) => ['owner', 'admin'].includes(r))) {
      throw new HttpsError('permission-denied', 'Only creator or admin may finalize.');
    }
    const update = { status: 'finalized', finalizedBy: who, finalizedAt: FieldValue.serverTimestamp() };
    tx.update(ref, update);
    audit(tx, orgId, 'evidence.finalize', ref.path, { status: 'draft' }, update, who);
    return { ok: true };
  });
});

// ---------------- evidence.supersede ----------------
// Creates a corrected copy in draft, links both directions. Original stays.

export const evidenceSupersede = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, evidenceId, reason } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!reason) throw new HttpsError('invalid-argument', 'Supersession requires a reason.');
  const who = actor(auth);
  const oldRef = db.doc(`orgs/${orgId}/evidence/${evidenceId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(oldRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Evidence not found.');
    const ev = snap.data();
    if (ev.status !== 'finalized') throw new HttpsError('failed-precondition', 'Only finalized evidence can be superseded.');

    const newRef = db.collection(`orgs/${orgId}/evidence`).doc();
    tx.set(newRef, {
      ...ev,
      status: 'draft',
      finalizedBy: null,
      finalizedAt: null,
      supersedes: oldRef.id,
      supersededBy: null,
      supersessionReason: reason,
      createdBy: who,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(oldRef, { status: 'superseded', supersededBy: newRef.id });
    audit(tx, orgId, 'evidence.supersede', oldRef.path, { status: 'finalized' }, { supersededBy: newRef.id, reason }, who);
    return { newEvidenceId: newRef.id };
  });
});

// ---------------- document.approveVersion ----------------

export const documentApproveVersion = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, docId, versionId, gbMinutesEvidenceId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);

  const docRef = db.doc(`orgs/${orgId}/documents/${docId}`);
  const verRef = db.doc(`orgs/${orgId}/documents/${docId}/versions/${versionId}`);

  return db.runTransaction(async (tx) => {
    const [d, v] = await Promise.all([tx.get(docRef), tx.get(verRef)]);
    if (!d.exists || !v.exists) throw new HttpsError('not-found', 'Document or version not found.');
    if (v.get('status') !== 'draft') throw new HttpsError('failed-precondition', 'Version is not a draft.');
    if (gbMinutesEvidenceId) {
      const m = await tx.get(db.doc(`orgs/${orgId}/evidence/${gbMinutesEvidenceId}`));
      if (!m.exists || m.get('status') !== 'finalized') {
        throw new HttpsError('failed-precondition', 'GB minutes evidence must exist and be finalized.');
      }
    }
    const prev = d.get('currentVersionId') ?? null;
    if (prev) tx.update(db.doc(`orgs/${orgId}/documents/${docId}/versions/${prev}`), { status: 'superseded' });
    tx.update(verRef, {
      status: 'approved',
      approval: { approvedBy: who, gbMinutesEvidenceId: gbMinutesEvidenceId ?? null },
      effectiveAt: FieldValue.serverTimestamp(),
    });
    tx.update(docRef, { currentVersionId: versionId });
    audit(tx, orgId, 'document.approveVersion', verRef.path, { previousVersion: prev }, { versionId }, who);
    return { ok: true };
  });
});

// ---------------- checkpoint.mint / checkpoint.rotateToken ----------------

export const checkpointMint = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, label, location, assetId, obligationIds, allowAdhocLog, adhocTemplateId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);

  const ref = db.collection(`orgs/${orgId}/checkpoints`).doc();
  const qrToken = randomBytes(16).toString('base64url');
  await ref.set({
    label, location: location ?? '', assetId: assetId ?? null,
    obligationIds: obligationIds ?? [],
    allowAdhocLog: !!allowAdhocLog, adhocTemplateId: adhocTemplateId ?? null,
    qrToken, tokenRotatedAt: FieldValue.serverTimestamp(),
    active: true, createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });
  return { checkpointId: ref.id, qrToken };
});

export const checkpointRotateToken = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, checkpointId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/checkpoints/${checkpointId}`);
  const qrToken = randomBytes(16).toString('base64url');

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Checkpoint not found.');
    tx.update(ref, { qrToken, tokenRotatedAt: FieldValue.serverTimestamp() });
    audit(tx, orgId, 'checkpoint.rotateToken', ref.path, null, { rotated: true }, who);
    return { qrToken };
  });
});

// ---------------- surveyor.grant / surveyor.revoke ----------------
// Time-boxed read access via custom claim. Requires getAuth() admin ops.

export const surveyorGrant = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid, days } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner']);
  const until = Date.now() + Math.min(days ?? 7, 30) * 24 * 3600 * 1000;
  await getAuth().setCustomUserClaims(uid, { orgId, roles: ['surveyor'], surveyorUntil: until });
  await db.collection(`orgs/${orgId}/auditLog`).add({
    actor: actor(auth), action: 'surveyor.grant', targetPath: `users/${uid}`,
    before: null, after: { surveyorUntil: until }, at: FieldValue.serverTimestamp(),
  });
  return { surveyorUntil: until };
});

export const surveyorRevoke = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner']);
  await getAuth().setCustomUserClaims(uid, { orgId, roles: [], surveyorUntil: 0 });
  await getAuth().revokeRefreshTokens(uid);
  await db.collection(`orgs/${orgId}/auditLog`).add({
    actor: actor(auth), action: 'surveyor.revoke', targetPath: `users/${uid}`,
    before: null, after: { revoked: true }, at: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});
