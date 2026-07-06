// functions/src/incidents.js — incidents / occurrence reporting.
// Report → investigate → corrective action → close (immutable, as evidence).
// Closed incidents can feed a data point into a QI study. De-identified by
// schema — no PHI fields.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, audit, auditDirect,
} from './util.js';

const TYPES = ['adverse-event', 'near-miss', 'medication-error', 'equipment-failure', 'complaint', 'fall', 'infection', 'security', 'other'];
const SEVERITIES = ['no-harm', 'minor', 'moderate', 'severe', 'sentinel'];

// Sequential per-year reference number via a transactional counter.
async function nextRefNumber(orgId) {
  const year = new Date().getFullYear();
  const counterRef = db.doc(`orgs/${orgId}/counters/incidents-${year}`);
  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const n = (snap.exists ? snap.get('seq') : 0) + 1;
    tx.set(counterRef, { seq: n }, { merge: true });
    return n;
  });
  return `INC-${year}-${String(seq).padStart(4, '0')}`;
}

// ---------------- incident.report ----------------
export const incidentReport = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, type, severity, title, description, occurredAt, location, caseMarker, standardRefs } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!title || !description) throw new HttpsError('invalid-argument', 'Title and description required.');
  const who = actor(auth);

  const refNumber = await nextRefNumber(orgId);
  const ref = db.collection(`orgs/${orgId}/incidents`).doc();
  await ref.set({
    refNumber,
    type: TYPES.includes(type) ? type : 'other',
    severity: SEVERITIES.includes(severity) ? severity : 'no-harm',
    title, description,
    occurredAt: occurredAt ? Timestamp.fromMillis(new Date(occurredAt).getTime()) : FieldValue.serverTimestamp(),
    location: location || '', caseMarker: caseMarker || null,
    reportedBy: who, reportedAt: FieldValue.serverTimestamp(),
    status: 'reported',
    standardRefs: Array.isArray(standardRefs) ? standardRefs : [],
    investigation: null,
    closedBy: null, closedAt: null, outcome: null, qiStudyId: null, evidenceId: null,
  });
  await auditDirect(orgId, 'incident.report', ref.path, null, { refNumber, type, severity }, who);
  return { incidentId: ref.id, refNumber };
});

// ---------------- incident.setInvestigation ----------------
export const incidentSetInvestigation = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, incidentId, findings, rootCause, contributingFactors } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!findings || !rootCause) throw new HttpsError('invalid-argument', 'Findings and root cause required.');
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Incident not found.');
  if (snap.get('status') === 'closed') throw new HttpsError('failed-precondition', 'Incident is closed.');
  await ref.set({
    investigation: {
      findings, rootCause,
      contributingFactors: Array.isArray(contributingFactors) ? contributingFactors : [],
      investigatedBy: who, investigatedAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });
  await auditDirect(orgId, 'incident.setInvestigation', ref.path, null, { incidentId }, who);
  return { ok: true };
});

// ---------------- incident.addAction ----------------
export const incidentAddAction = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, incidentId, description, type, assignedTo, dueDate } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!description) throw new HttpsError('invalid-argument', 'Description required.');
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/incidents/${incidentId}/actions`).doc();
  await ref.set({
    description, type: type === 'preventive' ? 'preventive' : 'corrective',
    assignedTo: assignedTo || null,
    dueDate: dueDate ? Timestamp.fromMillis(new Date(dueDate).getTime()) : null,
    status: 'open', completedAt: null, result: null,
    createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'incident.addAction', ref.path, null, { description }, who);
  return { actionId: ref.id };
});

// ---------------- incident.updateAction ----------------
export const incidentUpdateAction = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, incidentId, actionId, status, result } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const patch = {};
  if (status) { patch.status = status; if (status === 'done') patch.completedAt = FieldValue.serverTimestamp(); }
  if (result != null) patch.result = result;
  await db.doc(`orgs/${orgId}/incidents/${incidentId}/actions/${actionId}`).set(patch, { merge: true });
  await auditDirect(orgId, 'incident.updateAction', `orgs/${orgId}/incidents/${incidentId}/actions/${actionId}`, null, { status }, who);
  return { ok: true };
});

// ---------------- incident.advanceStatus ----------------
export const incidentAdvanceStatus = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, incidentId, status } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!['reported', 'investigating', 'action'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Use incident.close to close.');
  }
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/incidents/${incidentId}`).set({ status }, { merge: true });
  await auditDirect(orgId, 'incident.advanceStatus', `orgs/${orgId}/incidents/${incidentId}`, null, { status }, who);
  return { ok: true, status };
});

// ---------------- incident.close ----------------
// Guard: investigation recorded, no open actions, outcome provided.
// Finalizes an incident report as immutable evidence.
export const incidentClose = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, incidentId, outcome } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!outcome) throw new HttpsError('invalid-argument', 'Outcome/resolution required.');
  const who = actor(auth);

  const ref = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
  const [snap, actions] = await Promise.all([ref.get(), ref.collection('actions').get()]);
  if (!snap.exists) throw new HttpsError('not-found', 'Incident not found.');
  if (snap.get('status') === 'closed') throw new HttpsError('failed-precondition', 'Already closed.');

  const problems = [];
  const inv = snap.get('investigation');
  if (!inv || !inv.findings || !inv.rootCause) problems.push('investigation incomplete (findings + root cause)');
  const openActions = actions.docs.filter((a) => ['open', 'in-progress'].includes(a.get('status')));
  if (openActions.length) problems.push(`${openActions.length} corrective action(s) still open`);
  if (problems.length) throw new HttpsError('failed-precondition', `Cannot close: ${problems.join('; ')}.`);

  const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
  await db.runTransaction(async (tx) => {
    tx.set(evRef, {
      type: 'incident',
      title: `Incident ${snap.get('refNumber')}: ${snap.get('title')}`,
      standardRefs: snap.get('standardRefs') || [],
      obligationId: null, taskId: null,
      payload: {
        incidentId, refNumber: snap.get('refNumber'), type: snap.get('type'),
        severity: snap.get('severity'), investigation: inv, outcome,
        actionCount: actions.size,
      },
      attachments: [], status: 'finalized',
      finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
      supersededBy: null, supersedes: null,
      createdBy: who, createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(ref, {
      status: 'closed', outcome,
      closedBy: who, closedAt: FieldValue.serverTimestamp(), evidenceId: evRef.id,
    }, { merge: true });
    audit(tx, orgId, 'incident.close', ref.path, null, { evidenceId: evRef.id }, who);
  });

  return { ok: true, evidenceId: evRef.id };
});

// ---------------- incident.feedToQI ----------------
// Push a measurement into a QI study, tagged as incident-derived.
export const incidentFeedToQI = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, incidentId, studyId, period, value, note } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!studyId || value == null) throw new HttpsError('invalid-argument', 'studyId and value required.');
  const who = actor(auth);

  const dpRef = db.collection(`orgs/${orgId}/qiStudies/${studyId}/dataPoints`).doc();
  await dpRef.set({
    period: period || new Date().toISOString().slice(0, 7),
    value: Number(value), numerator: null, denominator: null,
    note: note || `From incident ${incidentId}`,
    source: 'incident-derived', sourceRef: incidentId,
    enteredBy: who, enteredAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`orgs/${orgId}/incidents/${incidentId}`).set({ qiStudyId: studyId }, { merge: true });
  await auditDirect(orgId, 'incident.feedToQI', dpRef.path, null, { incidentId, studyId, value }, who);
  return { ok: true, pointId: dpRef.id };
});
