// functions/src/assessment.js — self-assessment / mock-survey scoring.
// Rates parsed handbook elements against their AAAHC rating scale, links
// evidence as support, rolls up element -> standard -> domain -> overall.
// Human assigns ratings (Liability Rule); evidence informs, never auto-decides.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, auditDirect,
} from './util.js';

// Map a rating token to a 0..1 compliance value. Extend as scales appear.
const RATING_MAP = {
  yes: 1.0, no: 0.0,
  fc: 1.0,            // Full Compliance
  sc: 0.75,           // Substantial
  pc: 0.5,            // Partial
  mc: 0.25,           // Minimal
  nc: 0.0,            // Non-compliance
  'n/a': null, na: null,
};

function complianceOf(rating) {
  if (rating == null) return null;
  const key = String(rating).trim().toLowerCase();
  return key in RATING_MAP ? RATING_MAP[key] : null;
}

// Parse a handbook rating string ("FC, PC, NC" / "Yes, No") into ordered options.
function scaleFromRatingString(s) {
  if (!s) return ['Yes', 'No'];
  const opts = s.split(/[,/]/).map((x) => x.trim()).filter(Boolean);
  // dedupe, keep order
  const seen = new Set(); const out = [];
  for (const o of opts) { const k = o.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(o); } }
  return out.length ? [...out, 'N/A'] : ['Yes', 'No', 'N/A'];
}

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

// ---------------- assessment.create ----------------
// Snapshots the current edition's standards+elements into a new assessment,
// seeding a rating doc per item with its parsed scale (rating still null).
export const assessmentCreate = onCall({ timeoutSeconds: 300 }, async (req) => {
  const auth = requireAuth(req);
  const { orgId, title } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
  if (!lic.exists) throw new HttpsError('failed-precondition', 'No handbook license.');
  const edition = lic.get('edition');

  // Pull the org's confirmed handbook entries (they carry kind + rating).
  const entries = await db.collection(`orgs/${orgId}/handbookEntries`)
    .where('edition', '==', edition).get();
  if (entries.empty) throw new HttpsError('failed-precondition',
    'No confirmed handbook entries. Confirm handbook drafts before assessing.');

  const aRef = db.collection(`orgs/${orgId}/assessments`).doc();
  await aRef.set({
    edition, title: title || `Self-Assessment ${new Date().toISOString().slice(0, 10)}`,
    status: 'in_progress', startedBy: who, startedAt: FieldValue.serverTimestamp(),
    completedAt: null, applicability: {},
    summary: { overall: null, byDomain: {}, counts: { compliant: 0, partial: 0, noncompliant: 0, unrated: 0, na: 0 } },
  });

  // Seed a rating doc per element/standard (skip guidance).
  let batch = db.batch(); let n = 0;
  for (const d of entries.docs) {
    const e = d.data();
    if (e.kind === 'guidance') continue;
    const id = e.code.replace(/\./g, '-');
    batch.set(aRef.collection('ratings').doc(id), {
      code: e.code, standardCode: e.standardCode || e.code, domain: e.domain || e.code.split('.')[0],
      kind: e.kind || 'standard', scale: scaleFromRatingString(e.rating),
      rating: null, compliance: null, note: '', evidenceIds: [],
      override: false,
    });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  await auditDirect(orgId, 'assessment.create', aRef.path, null, { edition, items: n }, who);
  return { assessmentId: aRef.id, items: n };
});

// ---------------- assessment.rateItem ----------------
export const assessmentRateItem = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, assessmentId, code, rating, note, evidenceIds } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  const who = actor(auth);
  const id = String(code).replace(/\./g, '-');
  const rRef = db.doc(`orgs/${orgId}/assessments/${assessmentId}/ratings/${id}`);
  const snap = await rRef.get();
  if (!snap.exists) throw new HttpsError('not-found', `Item ${code} not in assessment.`);

  await rRef.set({
    rating: rating ?? null,
    compliance: complianceOf(rating),
    note: note ?? snap.get('note') ?? '',
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : (snap.get('evidenceIds') || []),
    ratedBy: who, ratedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Recompute the affected standard's rollup + assessment summary.
  await recomputeSummary(orgId, assessmentId);
  return { ok: true, code, compliance: complianceOf(rating) };
});

// ---------------- assessment.overrideStandard ----------------
export const assessmentOverrideStandard = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, assessmentId, standardCode, overrideRating, justification } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const id = String(standardCode).replace(/\./g, '-');
  const rRef = db.doc(`orgs/${orgId}/assessments/${assessmentId}/ratings/${id}`);

  await rRef.set({
    override: overrideRating != null,
    overrideRating: overrideRating ?? null,
    rating: overrideRating ?? null,
    compliance: complianceOf(overrideRating),
    justification: justification ?? '',
    ratedBy: who, ratedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await recomputeSummary(orgId, assessmentId);
  await auditDirect(orgId, 'assessment.override', rRef.path, null,
    { standardCode, overrideRating }, who);
  return { ok: true };
});

// ---------------- assessment.setApplicability ----------------
// Mark selective standards in/out of scope (excluded from rollup when out).
export const assessmentSetApplicability = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, assessmentId, standardCode, applicable } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/assessments/${assessmentId}`).set({
    applicability: { [standardCode]: !!applicable },
  }, { merge: true });
  await recomputeSummary(orgId, assessmentId);
  return { ok: true, standardCode, applicable: !!applicable };
});

// ---------------- assessment.complete ----------------
export const assessmentComplete = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, assessmentId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const summary = await recomputeSummary(orgId, assessmentId);
  await db.doc(`orgs/${orgId}/assessments/${assessmentId}`).set({
    status: 'complete', completedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await auditDirect(orgId, 'assessment.complete', `orgs/${orgId}/assessments/${assessmentId}`, null,
    { overall: summary.overall }, who);
  return { ok: true, summary };
});

// ---- rollup engine ----
async function recomputeSummary(orgId, assessmentId) {
  const aRef = db.doc(`orgs/${orgId}/assessments/${assessmentId}`);
  const [aSnap, ratings] = await Promise.all([
    aRef.get(),
    aRef.collection('ratings').get(),
  ]);
  const applicability = aSnap.get('applicability') || {};

  // Group by standard.
  const byStandard = {};
  const overrides = {};
  for (const d of ratings.docs) {
    const r = d.data();
    if (r.kind === 'standard' && r.override) overrides[r.standardCode || r.code] = r.compliance;
    if (r.kind !== 'element') continue;
    const sc = r.standardCode;
    (byStandard[sc] ||= []).push(r.compliance);
  }

  // Standard compliance = override, else mean of rated non-null elements.
  const standardScores = {};
  const domainBuckets = {};
  const counts = { compliant: 0, partial: 0, noncompliant: 0, unrated: 0, na: 0 };

  const allStandardCodes = new Set([
    ...Object.keys(byStandard),
    ...Object.keys(overrides),
  ]);

  for (const sc of allStandardCodes) {
    if (applicability[sc] === false) continue; // out-of-scope selective
    let score;
    if (sc in overrides && overrides[sc] != null) score = overrides[sc];
    else {
      const vals = (byStandard[sc] || []).filter((v) => v != null);
      score = mean(vals);
    }
    standardScores[sc] = score;
    const domain = sc.split('.')[0];
    if (score != null) (domainBuckets[domain] ||= []).push(score);
  }

  // Item-level counts (for the readiness dashboard).
  for (const d of ratings.docs) {
    const r = d.data();
    if (r.kind === 'guidance') continue;
    if (r.rating == null) { counts.unrated++; continue; }
    const c = r.compliance;
    if (c == null) counts.na++;
    else if (c >= 1) counts.compliant++;
    else if (c <= 0) counts.noncompliant++;
    else counts.partial++;
  }

  const byDomain = {};
  for (const [dom, vals] of Object.entries(domainBuckets)) byDomain[dom] = mean(vals);
  const overall = mean(Object.values(byDomain).filter((v) => v != null));

  const summary = { overall, byDomain, counts };
  await aRef.set({ summary }, { merge: true });
  return summary;
}
