// functions/src/manual.js — policy MANUAL structure: ordered sections
// (chapters) + document placement within them, yielding a numbered table of
// contents (1.1, 1.2, 2.1…). Sits on top of the documents backend (Delta 14).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, requireAuth, requireOrg, requireRole, actor, auditDirect,
} from './util.js';

// ---------------- manualSection.create ----------------
export const manualSectionCreate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, title, description } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!title) throw new HttpsError('invalid-argument', 'Section title required.');
  const who = actor(auth);

  // Append at the end: order = current max + 1.
  const existing = await db.collection(`orgs/${orgId}/manualSections`).get();
  const maxOrder = existing.docs.reduce((m, d) => Math.max(m, d.get('order') || 0), 0);

  const ref = db.collection(`orgs/${orgId}/manualSections`).doc();
  await ref.set({
    title, description: description || '',
    order: maxOrder + 1,
    createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'manualSection.create', ref.path, null, { title }, who);
  return { sectionId: ref.id, order: maxOrder + 1 };
});

// ---------------- manualSection.update (rename / describe) ----------------
export const manualSectionUpdate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, sectionId, title, description } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const patch = {};
  if (title != null) patch.title = title;
  if (description != null) patch.description = description;
  await db.doc(`orgs/${orgId}/manualSections/${sectionId}`).set(patch, { merge: true });
  await auditDirect(orgId, 'manualSection.update', `orgs/${orgId}/manualSections/${sectionId}`, null, patch, who);
  return { ok: true };
});

// ---------------- manualSection.reorder ----------------
// Accepts an ordered array of sectionIds; rewrites order fields to match.
export const manualSectionReorder = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, orderedIds } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!Array.isArray(orderedIds)) throw new HttpsError('invalid-argument', 'orderedIds required.');
  const who = actor(auth);
  const batch = db.batch();
  orderedIds.forEach((id, i) => batch.set(db.doc(`orgs/${orgId}/manualSections/${id}`), { order: i + 1 }, { merge: true }));
  await batch.commit();
  await auditDirect(orgId, 'manualSection.reorder', `orgs/${orgId}/manualSections`, null, { count: orderedIds.length }, who);
  return { ok: true };
});

// ---------------- manualSection.delete ----------------
// Only if empty (no documents assigned). Unassigned documents are unaffected.
export const manualSectionDelete = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, sectionId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const inSection = await db.collection(`orgs/${orgId}/documents`)
    .where('sectionId', '==', sectionId).where('status', '==', 'active').limit(1).get();
  if (!inSection.empty) throw new HttpsError('failed-precondition', 'Section is not empty — move its documents first.');
  await db.doc(`orgs/${orgId}/manualSections/${sectionId}`).delete();
  await auditDirect(orgId, 'manualSection.delete', `orgs/${orgId}/manualSections/${sectionId}`, null, {}, who);
  return { ok: true };
});

// ---------------- policy.placeInSection ----------------
// Assign a document to a section + position (order within section).
export const policyPlaceInSection = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, docId, sectionId, order } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  let ord = order;
  if (ord == null && sectionId) {
    const sibs = await db.collection(`orgs/${orgId}/documents`)
      .where('sectionId', '==', sectionId).get();
    ord = sibs.docs.reduce((m, d) => Math.max(m, d.get('manualOrder') || 0), 0) + 1;
  }
  await db.doc(`orgs/${orgId}/documents/${docId}`).set({
    sectionId: sectionId || null, manualOrder: ord || 0,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await auditDirect(orgId, 'policy.placeInSection', `orgs/${orgId}/documents/${docId}`, null, { sectionId, order: ord }, who);
  return { ok: true, order: ord };
});

// ---------------- policy.reorderInSection ----------------
export const policyReorderInSection = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, orderedDocIds } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!Array.isArray(orderedDocIds)) throw new HttpsError('invalid-argument', 'orderedDocIds required.');
  const who = actor(auth);
  const batch = db.batch();
  orderedDocIds.forEach((id, i) => batch.set(db.doc(`orgs/${orgId}/documents/${id}`), { manualOrder: i + 1 }, { merge: true }));
  await batch.commit();
  await auditDirect(orgId, 'policy.reorderInSection', `orgs/${orgId}/documents`, null, { count: orderedDocIds.length }, who);
  return { ok: true };
});

// ---------------- manual.get ----------------
// The whole manual assembled: ordered sections, each with its ordered documents
// and current-version/review state — plus computed numbering (1.1, 1.2…).
export const manualGet = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  const [sectionsSnap, docsSnap] = await Promise.all([
    db.collection(`orgs/${orgId}/manualSections`).get(),
    db.collection(`orgs/${orgId}/documents`).where('status', '==', 'active').get(),
  ]);

  const sections = sectionsSnap.docs
    .map((d) => ({ id: d.id, title: d.get('title'), description: d.get('description') || '', order: d.get('order') || 0 }))
    .sort((a, b) => a.order - b.order);

  // Resolve each document's current version status/review state.
  const docs = await Promise.all(docsSnap.docs.map(async (d) => {
    const doc = d.data();
    let cur = null;
    if (doc.currentVersionId) {
      const v = await db.doc(`orgs/${orgId}/documents/${d.id}/versions/${doc.currentVersionId}`).get();
      if (v.exists) cur = { versionLabel: v.get('versionLabel'), status: v.get('status') };
    }
    const nextDue = doc.nextReviewDue ? doc.nextReviewDue._seconds * 1000 : null;
    const reviewState = !doc.currentVersionId ? 'draft-only'
      : (nextDue && nextDue < Date.now()) ? 'review-due' : 'current';
    return {
      docId: d.id, title: doc.title, docType: doc.docType, category: doc.category,
      storageMode: doc.storageMode, sectionId: doc.sectionId || null, manualOrder: doc.manualOrder || 0,
      standardRefs: (doc.standardRefs || []).map((r) => r.code).filter(Boolean),
      currentVersion: cur, reviewState,
    };
  }));

  // Group + number.
  const bySection = {};
  for (const doc of docs) {
    const key = doc.sectionId || '_unfiled';
    (bySection[key] ||= []).push(doc);
  }
  for (const key of Object.keys(bySection)) bySection[key].sort((a, b) => a.manualOrder - b.manualOrder);

  const toc = sections.map((sec, si) => ({
    ...sec, number: si + 1,
    documents: (bySection[sec.id] || []).map((doc, di) => ({ ...doc, number: `${si + 1}.${di + 1}` })),
  }));
  const unfiled = (bySection._unfiled || []).map((doc) => ({ ...doc, number: '—' }));

  return { sections: toc, unfiled, totalDocs: docs.length };
});
