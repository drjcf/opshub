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

  const [reqs, docs, obs] = await Promise.all([
    db.collection(`orgs/${orgId}/documentRequirements`).get(),
    db.collection(`orgs/${orgId}/documents`).where('status', '==', 'active').get(),
    db.collection(`orgs/${orgId}/obligations`).where('status', '==', 'active').get(),
  ]);
  const docById = {};
  for (const d of docs.docs) docById[d.id] = { id: d.id, ...d.data() };
  const obById = {};
  for (const o of obs.docs) obById[o.id] = { id: o.id, ...o.data() };

  // Most-recent finalized evidence per obligation (for log/register coverage).
  const evSnap = await db.collection(`orgs/${orgId}/evidence`)
    .where('status', '==', 'finalized').get();
  const lastEvidenceByOb = {};
  for (const e of evSnap.docs) {
    const oid = e.get('obligationId'); if (!oid) continue;
    const ms = e.get('finalizedAt')?.toMillis?.() || 0;
    if (!lastEvidenceByOb[oid] || ms > lastEvidenceByOb[oid]) lastEvidenceByOb[oid] = ms;
  }

  const rows = await Promise.all(reqs.docs.map(async (r) => {
    const req0 = r.data();
    const backing = req0.backing || (req0.docId ? { type: 'policy', ref: req0.docId } : null);
    let status = 'unmet', versionStatus = null, backingTitle = null, backingType = backing?.type || 'manual';

    if (backing?.type === 'policy' || (!backing && req0.docId)) {
      const doc = docById[backing?.ref || req0.docId];
      backingTitle = doc?.title || null;
      if (doc && doc.currentVersionId) {
        const v = await db.doc(`orgs/${orgId}/documents/${doc.id}/versions/${doc.currentVersionId}`).get();
        versionStatus = v.exists ? v.get('status') : null;
        const nextDue = doc.nextReviewDue ? doc.nextReviewDue._seconds * 1000 : null;
        status = (nextDue && nextDue < Date.now()) ? 'review-due' : (versionStatus === 'approved' ? 'met' : 'unmet');
      } else if (doc) {
        status = 'draft-only';
      }
    } else if (backing?.type === 'obligation' || backing?.type === 'register') {
      const ob = obById[backing.ref];
      backingTitle = ob?.title || null;
      if (ob) {
        // covered if a completion exists in the last ~13 months (cadence-agnostic)
        const last = lastEvidenceByOb[backing.ref];
        const fresh = last && (Date.now() - last) < 400 * 24 * 3600 * 1000;
        status = fresh ? 'met' : 'active-no-recent-evidence';
      }
    } else {
      // manual/standing record — presence tracked by an explicit flag
      status = req0.satisfied === true ? 'met' : 'unmet';
      backingType = 'manual';
    }

    return {
      key: r.id, title: req0.title, category: req0.category, required: req0.required !== false,
      kind: req0.kind || backingType,
      standardRefs: (req0.standardRefs || []).map((x) => x.code).filter(Boolean),
      backingType, backingTitle, versionStatus, status,
    };
  }));

  const met = rows.filter((x) => x.status === 'met').length;
  const total = rows.filter((x) => x.required).length;
  const order = { unmet: 0, 'draft-only': 1, 'active-no-recent-evidence': 2, 'review-due': 3, met: 4 };
  rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.title.localeCompare(b.title));
  return { rows, met, total };
});

// ---------------- requirementAutoLink ----------------
// Matches each requirement to a backing artifact (policy document, obligation,
// or register) by normalized-title similarity, and writes the backing pointer.
// Idempotent; only fills backings that resolve confidently.
export const requirementAutoLink = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const [reqs, docs, obs] = await Promise.all([
    db.collection(`orgs/${orgId}/documentRequirements`).get(),
    db.collection(`orgs/${orgId}/documents`).where('status', '==', 'active').get(),
    db.collection(`orgs/${orgId}/obligations`).where('status', '==', 'active').get(),
  ]);
  const docList = docs.docs.map((d) => ({ id: d.id, n: norm(d.get('title')) }));
  const obList = obs.docs.map((o) => ({ id: o.id, n: norm(o.get('title')), type: o.get('evidenceType') === 'register' ? 'register' : 'obligation' }));

  const score = (a, b) => {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aw = a.split(' '), bw = b.split(' ');
    const overlap = aw.filter((w) => w.length > 3 && bw.includes(w)).length;
    return overlap / Math.max(aw.length, bw.length);
  };
  const best = (target, list) => {
    let top = null, s = 0;
    for (const c of list) { const cs = score(target, c.n); if (cs > s) { s = cs; top = c; } }
    return s >= 0.5 ? top : null;
  };

  const batch = db.batch();
  let linked = 0;
  for (const r of reqs.docs) {
    const data = r.data();
    if (data.backing?.ref) continue; // already linked
    const hint = data.backingHint || 'policy';
    const tn = norm(data.title);
    let match = null, type = null;
    if (hint === 'policy') { const m = best(tn, docList); if (m) { match = m.id; type = 'policy'; } }
    if (!match && (hint === 'obligation' || hint === 'register' || hint === 'log')) {
      const m = best(tn, obList); if (m) { match = m.id; type = m.type; }
    }
    if (!match) { // fall back: try the other pool
      const m = best(tn, hint === 'policy' ? obList : docList);
      if (m) { match = m.id; type = m.type || 'policy'; }
    }
    if (match) {
      batch.set(r.ref, { backing: { type, ref: match } }, { merge: true });
      linked++;
    }
  }
  await batch.commit();
  await auditDirect(orgId, 'requirement.autoLink', `orgs/${orgId}/documentRequirements`, null, { linked }, who);
  return { linked, total: reqs.size };
});

// ---------------- requirementSetSatisfied ----------------
// Manually mark a standing-record requirement satisfied (or not).
export const requirementSetSatisfied = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, key, satisfied } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/documentRequirements/${key}`).set({ satisfied: !!satisfied }, { merge: true });
  await auditDirect(orgId, 'requirement.setSatisfied', `orgs/${orgId}/documentRequirements/${key}`, null, { satisfied: !!satisfied }, who);
  return { ok: true };
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
