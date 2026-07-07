// functions/src/policies.js — controlled P&P + required-document registry.
// Extends the existing documents/versions backend (documentApproveVersion lives
// in callables.js). Policies are authored in-app OR linked to Drive/GCS; both
// are versioned, approved, mapped to standards, on a review cadence. The
// requirement registry drives a coverage dashboard against AAAHC's required set.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, auditDirect, queueNotification,
} from './util.js';

const MONTH = 30 * 24 * 3600 * 1000;
const DOC_TYPES = ['policy', 'procedure', 'plan', 'form', 'manual'];
const CATEGORIES = ['infection-control', 'governance', 'clinical', 'safety', 'hr', 'emergency', 'quality', 'medication', 'facility', 'other'];

// ---------------- policy.create ----------------
export const policyCreate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, title, docType, category, standardRefs, storageMode, reviewIntervalMonths, requirementId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!title) throw new HttpsError('invalid-argument', 'Title required.');
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/documents`).doc();
  await ref.set({
    title,
    docType: DOC_TYPES.includes(docType) ? docType : 'policy',
    category: CATEGORIES.includes(category) ? category : 'other',
    standardRefs: Array.isArray(standardRefs) ? standardRefs : [],
    storageMode: storageMode === 'linked' ? 'linked' : 'authored',
    currentVersionId: null,
    reviewIntervalMonths: Number(reviewIntervalMonths) || 12,
    lastReviewedAt: null, nextReviewDue: null,
    owner: who, status: 'active', requirementId: requirementId || null,
    createdBy: who, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  // Link the requirement slot to this doc if provided.
  if (requirementId) {
    await db.doc(`orgs/${orgId}/documentRequirements/${requirementId}`).set({ docId: ref.id }, { merge: true });
  }
  await auditDirect(orgId, 'policy.create', ref.path, null, { title, category }, who);
  return { docId: ref.id };
});

// ---------------- policy.saveVersion ----------------
// New draft version — authored body OR linked Drive/GCS pointer.
export const policySaveVersion = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, docId, versionLabel, storageMode, body, storagePath, driveFileId, driveLink, changeSummary } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const mode = storageMode === 'linked' ? 'linked' : 'authored';
  if (mode === 'authored' && !body) throw new HttpsError('invalid-argument', 'Authored version needs body text.');
  if (mode === 'linked' && !storagePath && !driveFileId && !driveLink) {
    throw new HttpsError('invalid-argument', 'Linked version needs a storagePath or Drive reference.');
  }
  const ref = db.collection(`orgs/${orgId}/documents/${docId}/versions`).doc();
  await ref.set({
    versionLabel: versionLabel || '1.0',
    status: 'draft', storageMode: mode,
    body: mode === 'authored' ? String(body) : null,
    storagePath: mode === 'linked' ? (storagePath || null) : null,
    driveFileId: mode === 'linked' ? (driveFileId || null) : null,
    driveLink: mode === 'linked' ? (driveLink || null) : null,
    changeSummary: changeSummary || '', approval: null,
    authoredBy: who, authoredAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`orgs/${orgId}/documents/${docId}`).set({ storageMode: mode, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await auditDirect(orgId, 'policy.saveVersion', ref.path, null, { docId, mode }, who);
  return { versionId: ref.id };
});

// ---------------- policy.list ----------------
export const policyList = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  const snap = await db.collection(`orgs/${orgId}/documents`).where('status', '==', 'active').get();
  const rows = await Promise.all(snap.docs.map(async (d) => {
    const doc = d.data();
    let cur = null;
    if (doc.currentVersionId) {
      const v = await db.doc(`orgs/${orgId}/documents/${d.id}/versions/${doc.currentVersionId}`).get();
      if (v.exists) cur = { id: v.id, versionLabel: v.get('versionLabel'), status: v.get('status'), storageMode: v.get('storageMode') };
    }
    const nextDue = doc.nextReviewDue ? (doc.nextReviewDue._seconds * 1000) : null;
    const reviewState = !doc.currentVersionId ? 'draft-only'
      : (nextDue && nextDue < Date.now()) ? 'review-due' : 'current';
    return {
      docId: d.id, title: doc.title, docType: doc.docType, category: doc.category,
      storageMode: doc.storageMode, standardRefs: (doc.standardRefs || []).map((r) => r.code).filter(Boolean),
      currentVersion: cur, reviewState, nextReviewMs: nextDue,
      reviewIntervalMonths: doc.reviewIntervalMonths, requirementId: doc.requirementId || null,
    };
  }));
  rows.sort((a, b) => a.title.localeCompare(b.title));
  return { rows };
});

// ---------------- policy.markReviewed ----------------
// "Reviewed, no change" — refreshes the review clock without a new version.
export const policyMarkReviewed = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, docId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/documents/${docId}`);
  const d = await ref.get();
  if (!d.exists) throw new HttpsError('not-found', 'Document not found.');
  const months = d.get('reviewIntervalMonths') || 12;
  await ref.set({
    lastReviewedAt: FieldValue.serverTimestamp(),
    nextReviewDue: Timestamp.fromMillis(Date.now() + months * MONTH),
  }, { merge: true });
  await auditDirect(orgId, 'policy.markReviewed', ref.path, null, { docId }, who);
  return { ok: true };
});

// ---------------- policy.retire ----------------
export const policyRetire = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, docId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/documents/${docId}`).set({ status: 'retired' }, { merge: true });
  await auditDirect(orgId, 'policy.retire', `orgs/${orgId}/documents/${docId}`, null, {}, who);
  return { ok: true };
});

// ---------------- requirement.seed ----------------
// Seed/update the required-document registry (the AAAHC-expected set).
export const requirementSeed = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, requirements } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  if (!Array.isArray(requirements)) throw new HttpsError('invalid-argument', 'requirements array required.');
  const who = actor(auth);
  let n = 0;
  const batch = db.batch();
  for (const r of requirements) {
    if (!r.key || !r.title) continue;
    batch.set(db.doc(`orgs/${orgId}/documentRequirements/${r.key}`), {
      key: r.key, title: r.title, description: r.description || '',
      category: r.category || 'other',
      standardRefs: Array.isArray(r.standardRefs) ? r.standardRefs : [],
      required: r.required !== false,
      reviewIntervalMonths: Number(r.reviewIntervalMonths) || 12,
    }, { merge: true });
    n++;
  }
  await batch.commit();
  await auditDirect(orgId, 'requirement.seed', `orgs/${orgId}/documentRequirements`, null, { seeded: n }, who);
  return { seeded: n };
});

// ---------------- requirement.coverage ----------------
// The dashboard: every requirement + its linked doc + met/unmet/review-due.
export const requirementCoverage = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  const [reqs, docs] = await Promise.all([
    db.collection(`orgs/${orgId}/documentRequirements`).get(),
    db.collection(`orgs/${orgId}/documents`).where('status', '==', 'active').get(),
  ]);
  const docById = {};
  for (const d of docs.docs) docById[d.id] = { id: d.id, ...d.data() };

  const rows = await Promise.all(reqs.docs.map(async (r) => {
    const req0 = r.data();
    const doc = req0.docId ? docById[req0.docId] : null;
    let status = 'unmet', versionStatus = null;
    if (doc && doc.currentVersionId) {
      const v = await db.doc(`orgs/${orgId}/documents/${doc.id}/versions/${doc.currentVersionId}`).get();
      versionStatus = v.exists ? v.get('status') : null;
      const nextDue = doc.nextReviewDue ? doc.nextReviewDue._seconds * 1000 : null;
      status = (nextDue && nextDue < Date.now()) ? 'review-due' : 'met';
    } else if (doc) {
      status = 'unmet'; // doc exists but no approved current version
    }
    return {
      key: r.id, title: req0.title, category: req0.category, required: req0.required !== false,
      standardRefs: (req0.standardRefs || []).map((x) => x.code).filter(Boolean),
      docId: doc?.id || null, docTitle: doc?.title || null, versionStatus, status,
    };
  }));

  const met = rows.filter((x) => x.status === 'met').length;
  const total = rows.filter((x) => x.required).length;
  rows.sort((a, b) => (a.status === b.status ? a.title.localeCompare(b.title) : a.status.localeCompare(b.status)));
  return { rows, met, total };
});

// ---------------- policyReviewSweep (scheduled) ----------------
// Flags documents past their review date; queues Today-board notifications.
export const policyReviewSweep = onSchedule('30 7 * * *', async () => {
  const orgs = await db.collection('orgs').get();
  for (const org of orgs.docs) {
    const orgId = org.id;
    const docs = await db.collection(`orgs/${orgId}/documents`)
      .where('status', '==', 'active').get();
    for (const d of docs.docs) {
      const nextDue = d.get('nextReviewDue');
      if (!nextDue) continue;
      if (nextDue.toMillis() >= Date.now()) continue;
      const ledgerId = `policy_${d.id}_${new Date().toISOString().slice(0, 7)}`; // once/month
      const ledgerRef = db.doc(`orgs/${orgId}/sweepLedger/${ledgerId}`);
      if ((await ledgerRef.get()).exists) continue;
      await ledgerRef.set({ at: FieldValue.serverTimestamp() });
      await queueNotification(db, orgId, {
        kind: 'policyReviewDue', docId: d.id,
        title: `Policy review due: ${d.get('title')}`,
      });
    }
  }
});
