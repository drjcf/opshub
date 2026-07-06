// functions/src/qi.js — QA/QI studies (PDSA cycle).
// The quality-improvement spine: aim → collect → analyze → act → remeasure →
// close. Closure requires a complete loop (guard) and finalizes a study report
// as immutable evidence. Human-authored throughout (Liability Rule).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, audit, auditDirect,
} from './util.js';

const STATUSES = ['planning', 'collecting', 'analyzing', 'acting', 'remeasuring', 'closed'];

// Recompute a study's denormalized summary from its subcollections.
async function recomputeStudySummary(orgId, studyId) {
  const studyRef = db.doc(`orgs/${orgId}/qiStudies/${studyId}`);
  const [points, actions, studySnap] = await Promise.all([
    studyRef.collection('dataPoints').get(),
    studyRef.collection('actions').get(),
    studyRef.get(),
  ]);
  const dp = points.docs.map((d) => ({ value: d.get('value'), period: d.get('period'),
    ms: d.get('enteredAt')?._seconds ? d.get('enteredAt')._seconds * 1000 : 0 }));
  dp.sort((a, b) => a.ms - b.ms);
  const latest = dp[dp.length - 1] || null;
  const openActions = actions.docs.filter((a) => ['open', 'in-progress'].includes(a.get('status'))).length;

  const measure = studySnap.get('measure') || {};
  let goalMet = null;
  if (latest && measure.goal != null && measure.direction) {
    goalMet = measure.direction === 'decrease' ? latest.value <= measure.goal
      : measure.direction === 'increase' ? latest.value >= measure.goal
      : Math.abs(latest.value - measure.goal) < 1e-9;
  }

  const summary = {
    latestValue: latest?.value ?? null,
    latestPeriod: latest?.period ?? null,
    dataPointCount: dp.length,
    openActionCount: openActions,
    goalMet,
  };
  await db.doc(`orgs/${orgId}/qiStudies/${studyId}`).set({ summary }, { merge: true });
  return summary;
}

// ---------------- qi.createStudy ----------------
export const qiCreateStudy = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, title, category, aim, measure, population, frequency, standardRefs } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!title || !aim) throw new HttpsError('invalid-argument', 'Title and aim required.');
  const who = actor(auth);

  const ref = db.collection(`orgs/${orgId}/qiStudies`).doc();
  await ref.set({
    title, category: category || 'other', aim,
    measure: measure || {}, population: population || '',
    frequency: frequency || 'monthly',
    standardRefs: Array.isArray(standardRefs) ? standardRefs : [],
    status: 'planning', baseline: null,
    owner: who, startedAt: FieldValue.serverTimestamp(), closedAt: null,
    conclusion: null, outcome: null, evidenceId: null,
    summary: { latestValue: null, latestPeriod: null, dataPointCount: 0, openActionCount: 0, goalMet: null },
  });
  await auditDirect(orgId, 'qi.createStudy', ref.path, null, { title, category }, who);
  return { studyId: ref.id };
});

// ---------------- qi.addDataPoint ----------------
export const qiAddDataPoint = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, period, value, numerator, denominator, note, source, sourceRef } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!studyId || value == null) throw new HttpsError('invalid-argument', 'studyId and value required.');
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/qiStudies/${studyId}/dataPoints`).doc();
  await ref.set({
    period: period || new Date().toISOString().slice(0, 7),
    value: Number(value),
    numerator: numerator != null ? Number(numerator) : null,
    denominator: denominator != null ? Number(denominator) : null,
    note: note || '', source: source || 'manual', sourceRef: sourceRef || null,
    enteredBy: who, enteredAt: FieldValue.serverTimestamp(),
  });
  const summary = await recomputeStudySummary(orgId, studyId);
  await auditDirect(orgId, 'qi.addDataPoint', ref.path, null, { value, period }, who);
  return { pointId: ref.id, summary };
});

// ---------------- qi.setBaseline ----------------
export const qiSetBaseline = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, value, period, note } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/qiStudies/${studyId}`).set({
    baseline: { value: Number(value), period: period || '', note: note || '' },
  }, { merge: true });
  await auditDirect(orgId, 'qi.setBaseline', `orgs/${orgId}/qiStudies/${studyId}`, null, { value, period }, who);
  return { ok: true };
});

// ---------------- qi.addAction ----------------
export const qiAddAction = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, description, assignedTo, dueDate } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!description) throw new HttpsError('invalid-argument', 'Description required.');
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/qiStudies/${studyId}/actions`).doc();
  await ref.set({
    description, assignedTo: assignedTo || null,
    dueDate: dueDate ? Timestamp.fromMillis(new Date(dueDate).getTime()) : null,
    status: 'open', completedAt: null, result: null,
    createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });
  await recomputeStudySummary(orgId, studyId);
  await auditDirect(orgId, 'qi.addAction', ref.path, null, { description }, who);
  return { actionId: ref.id };
});

// ---------------- qi.updateAction ----------------
export const qiUpdateAction = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, actionId, status, result } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const patch = { };
  if (status) {
    patch.status = status;
    if (status === 'done') patch.completedAt = FieldValue.serverTimestamp();
  }
  if (result != null) patch.result = result;
  await db.doc(`orgs/${orgId}/qiStudies/${studyId}/actions/${actionId}`).set(patch, { merge: true });
  await recomputeStudySummary(orgId, studyId);
  await auditDirect(orgId, 'qi.updateAction', `orgs/${orgId}/qiStudies/${studyId}/actions/${actionId}`, null, { status }, who);
  return { ok: true };
});

// ---------------- qi.addAnalysis ----------------
export const qiAddAnalysis = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, phase, narrative, periodsCovered } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!narrative) throw new HttpsError('invalid-argument', 'Narrative required.');
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/qiStudies/${studyId}/analyses`).doc();
  await ref.set({
    phase: phase || 'interim', narrative,
    periodsCovered: Array.isArray(periodsCovered) ? periodsCovered : [],
    authoredBy: who, authoredAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'qi.addAnalysis', ref.path, null, { phase }, who);
  return { analysisId: ref.id };
});

// ---------------- qi.advanceStatus ----------------
export const qiAdvanceStatus = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, status } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!STATUSES.includes(status)) throw new HttpsError('invalid-argument', 'Bad status.');
  if (status === 'closed') throw new HttpsError('invalid-argument', 'Use qi.closeStudy to close.');
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/qiStudies/${studyId}`).set({ status }, { merge: true });
  await auditDirect(orgId, 'qi.advanceStatus', `orgs/${orgId}/qiStudies/${studyId}`, null, { status }, who);
  return { ok: true, status };
});

// ---------------- qi.closeStudy ----------------
// The loop-closing guard: refuses to close an incomplete cycle. On success,
// finalizes a study report as immutable evidence.
export const qiCloseStudy = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, studyId, conclusion, outcome } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!conclusion || !outcome) throw new HttpsError('invalid-argument', 'Conclusion and outcome required.');
  const who = actor(auth);

  const studyRef = db.doc(`orgs/${orgId}/qiStudies/${studyId}`);
  const [study, points, actions, analyses] = await Promise.all([
    studyRef.get(),
    studyRef.collection('dataPoints').get(),
    studyRef.collection('actions').get(),
    studyRef.collection('analyses').get(),
  ]);
  if (!study.exists) throw new HttpsError('not-found', 'Study not found.');

  // Loop-completion guard.
  const problems = [];
  if (!study.get('baseline')) problems.push('no baseline set');
  if (points.size < 2) problems.push('need at least 2 data points (baseline + remeasure)');
  if (!analyses.docs.some((a) => a.get('phase') === 'final')) problems.push('no final analysis authored');
  const openActions = actions.docs.filter((a) => ['open', 'in-progress'].includes(a.get('status')));
  if (openActions.length) problems.push(`${openActions.length} action(s) still open`);
  if (problems.length) {
    throw new HttpsError('failed-precondition', `Cannot close — incomplete cycle: ${problems.join('; ')}.`);
  }

  // Finalize a study report as evidence (immutable).
  const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
  await db.runTransaction(async (tx) => {
    tx.set(evRef, {
      type: 'qiStudy',
      title: `QI Study: ${study.get('title')}`,
      standardRefs: study.get('standardRefs') || [],
      obligationId: null, taskId: null,
      payload: {
        studyId, aim: study.get('aim'), measure: study.get('measure'),
        baseline: study.get('baseline'), conclusion, outcome,
        dataPointCount: points.size, actionCount: actions.size,
      },
      attachments: [], status: 'finalized',
      finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
      supersededBy: null, supersedes: null,
      createdBy: who, createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(studyRef, {
      status: 'closed', conclusion, outcome,
      closedAt: FieldValue.serverTimestamp(), evidenceId: evRef.id,
    }, { merge: true });
    audit(tx, orgId, 'qi.closeStudy', studyRef.path, null, { outcome, evidenceId: evRef.id }, who);
  });

  return { ok: true, evidenceId: evRef.id, outcome };
});
