// functions/src/handbook.js — Delta 06.
// Per-licensee handbook: the org stores its OWN purchased handbook text,
// cross-referenced to the global citation tree. No AAAHC text ships in
// OpsHub; nothing here reads or writes across tenants.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, audit, auditDirect,
} from './util.js';

// ---------------- handbook.attestLicense ----------------
// An owner affirms the org holds a valid AAAHC license for an edition.
// Gates all subsequent handbook text entry. The licensee owns their
// copyright compliance — same as bringing your own handbook to a survey.
export const handbookAttestLicense = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, edition, source } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner']);
  if (!edition) throw new HttpsError('invalid-argument', 'Edition required.');
  const who = actor(auth);

  // Confirm the edition exists in the global citation tree.
  const ed = await db.doc(`standardsEditions/${edition}`).get();
  if (!ed.exists) throw new HttpsError('not-found', 'Unknown edition.');

  await db.doc(`orgs/${orgId}/handbookConfig/license`).set({
    edition,
    source: source || 'purchased-pdf',
    purchaseAttestedBy: who,
    purchaseAttestedAt: FieldValue.serverTimestamp(),
    storagePrefix: `orgs/${orgId}/handbook/${edition}/`,
    status: 'active',
  }, { merge: true });

  await auditDirect(orgId, 'handbook.attestLicense', `orgs/${orgId}/handbookConfig/license`, null,
    { edition, source: source || 'purchased-pdf' }, who);
  return { ok: true, edition };
});

// ---------------- handbook.setEntry ----------------
// Write/update the licensee's own text for one standard. Gated on an active
// license attestation.
export const handbookSetEntry = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, standardId, text, pageRef, sourceUpload } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!standardId) throw new HttpsError('invalid-argument', 'standardId required.');
  const who = actor(auth);

  const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
  if (!lic.exists || lic.get('status') !== 'active') {
    throw new HttpsError('failed-precondition',
      'No active handbook license attestation. An owner must attest the org holds an AAAHC license first.');
  }
  const edition = lic.get('edition');

  // Confirm the standard exists in the citation tree for this edition.
  const std = await db.doc(`standardsEditions/${edition}/standards/${standardId}`).get();
  if (!std.exists) throw new HttpsError('not-found', `Standard ${standardId} not in edition ${edition}.`);

  await db.doc(`orgs/${orgId}/handbookEntries/${standardId}`).set({
    standardId, edition,
    text: text ?? '',
    pageRef: pageRef ?? null,
    sourceUpload: sourceUpload ?? null,
    enteredBy: who,
    enteredAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Audit records that an entry changed, NOT the text itself (keep licensed
  // text out of the audit log too).
  await auditDirect(orgId, 'handbook.setEntry', `orgs/${orgId}/handbookEntries/${standardId}`, null,
    { standardId, hasText: !!(text && text.length) }, who);
  return { ok: true, standardId };
});

// ---------------- handbook.removeEdition ----------------
// Purge the org's handbook text (e.g. license lapsed). Deletes entries and
// marks the license removed. Storage objects are deleted client-side or via
// a follow-up; this clears the Firestore text.
export const handbookRemoveEdition = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, edition } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner']);
  const who = actor(auth);

  const entries = await db.collection(`orgs/${orgId}/handbookEntries`)
    .where('edition', '==', edition).get();
  let batch = db.batch();
  let n = 0;
  for (const e of entries.docs) {
    batch.delete(e.ref);
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  batch.set(db.doc(`orgs/${orgId}/handbookConfig/license`), { status: 'removed' }, { merge: true });
  await batch.commit();

  await auditDirect(orgId, 'handbook.removeEdition', `orgs/${orgId}/handbookConfig/license`, null,
    { edition, entriesPurgedCount: n }, who);
  return { ok: true, purged: n };
});

// ---------------- handbook.getCrosswalk ----------------
// Read model for the standards browser: for a standard, return the licensee's
// own text (if any) + obligations + evidence coverage. Staff/CD/admin only.
export const handbookGetCrosswalk = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, standardId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
  const edition = lic.exists ? lic.get('edition') : null;

  // standardId is dash form (ADM-180); standardCode is dot form (ADM.180).
  const standardCode = standardId.replace(/-/g, '.');

  const [entriesSnap, obligationsSnap, evidenceSnap, stdSnap] = await Promise.all([
    // ALL entries for this standard: the standard-level doc AND its elements
    // AND guidance. Parser puts most text on elements, so fetch them all.
    db.collection(`orgs/${orgId}/handbookEntries`)
      .where('standardCode', '==', standardCode).get(),
    db.collection(`orgs/${orgId}/obligations`).where('status', '==', 'active').get(),
    db.collection(`orgs/${orgId}/evidence`).where('status', '==', 'finalized').limit(500).get(),
    edition ? db.doc(`standardsEditions/${edition}/standards/${standardId}`).get() : Promise.resolve(null),
  ]);

  // Match obligations/evidence that reference this standard by code.
  const matchesStandard = (refs) =>
    (refs || []).some((r) => r.code === standardCode || r.standardId === standardId);

  const obligations = obligationsSnap.docs
    .filter((d) => matchesStandard(d.get('standardRefs')))
    .map((d) => ({ id: d.id, title: d.get('title') }));

  const evidence = evidenceSnap.docs
    .filter((d) => matchesStandard(d.get('standardRefs')))
    .map((d) => ({ id: d.id, title: d.get('title'), finalizedAt: d.get('finalizedAt') }))
    .slice(0, 25);

  // Assemble text: standard-level first, then elements in code order, then guidance.
  const all = entriesSnap.docs.map((d) => d.data());
  const standardEntry = all.find((e) => e.kind === 'standard');
  const elements = all.filter((e) => e.kind === 'element' || e.kind === 'subelement')
    .sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  const guidance = all.filter((e) => e.kind === 'guidance');

  const ownText = (standardEntry || elements.length || guidance.length) ? {
    text: standardEntry?.text || '',
    rating: standardEntry?.rating || '',
    designator: standardEntry?.designator || '',
    pageRef: standardEntry?.pageRef || elements[0]?.pageRef || null,
    elements: elements.map((e) => ({ code: e.code, text: e.text, rating: e.rating || '' })),
    guidance: guidance.map((e) => e.text).filter(Boolean),
  } : null;

  return {
    standardId,
    citation: stdSnap?.exists ? {
      code: stdSnap.get('code'), chapterName: stdSnap.get('chapterName'),
      shortRef: stdSnap.get('shortRef'),
    } : null,
    ownText,
    obligations,
    evidence,
    coverage: evidence.length > 0 ? 'covered' : obligations.length > 0 ? 'obligated' : 'gap',
  };
});

// ---------------- handbook.ingestFromUpload ----------------
// Parses the licensee's OWN uploaded handbook PDF (already in their GCS
// bucket) into staged draft handbookEntries. Runs entirely in-tenant.
// Text is the licensee's own copy; never logged, never emitted cross-tenant.
// Requires: firebase-admin storage, pdfjs-dist. Heavy (218 pages) → generous
// timeout/memory.
import { getStorage } from 'firebase-admin/storage';
import { parseHandbookRows, rowsFromContent, citationTreeFromParse } from './handbook-parse.js';

export const handbookIngestFromUpload = onCall(
  { timeoutSeconds: 540, memory: '1GiB' },
  async (req) => {
    const auth = requireAuth(req);
    const { orgId, storagePath, seedCitationTree } = req.data || {};
    requireOrg(auth, orgId);
    requireRole(auth, ['owner', 'admin']);
    const who = actor(auth);

    const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
    if (!lic.exists || lic.get('status') !== 'active') {
      throw new HttpsError('failed-precondition', 'Attest a handbook license before ingesting.');
    }
    const edition = lic.get('edition');
    if (!storagePath || !storagePath.startsWith(`orgs/${orgId}/handbook/`)) {
      throw new HttpsError('invalid-argument', 'storagePath must be within this org\'s handbook prefix.');
    }

    // Download the licensee's own PDF from their bucket.
    const bucket = getStorage().bucket();
    const [buf] = await bucket.file(storagePath).download();

    // Parse with pdfjs (dynamic import — heavy dep, load on demand).
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;

    const allRows = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      for (const r of rowsFromContent(content, p)) allRows.push(r);
    }

    const parse = parseHandbookRows(allRows);

    // Stage entries as DRAFT for licensee review (never auto-commit).
    let staged = 0;
    let batch = db.batch();
    for (const e of parse.entries) {
      const id = e.code.replace(/\./g, '-');
      batch.set(db.doc(`orgs/${orgId}/handbookEntriesDraft/${id}`), {
        ...e, edition, staged: true, stagedBy: who, stagedAt: FieldValue.serverTimestamp(),
      });
      if (++staged % 400 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();

    // Optionally seed the CITATION-ONLY tree (codes + structure, no text)
    // into the global edition — admin action, populates the browser.
    let treeSeeded = 0;
    if (seedCitationTree) {
      const tree = citationTreeFromParse(parse);
      let tb = db.batch();
      for (const d of tree.domains) {
        tb.set(db.doc(`standardsEditions/${edition}/domains/${d.code}`),
          { code: d.code, name: d.name || d.code, order: d.order }, { merge: true });
      }
      for (const s of tree.standards) {
        const id = s.code.replace(/\./g, '-');
        tb.set(db.doc(`standardsEditions/${edition}/standards/${id}`), {
          code: s.code, domain: s.domain, number: s.number,
          elementCodes: s.elementCodes, shortRef: '', order: s.order,
        }, { merge: true });
        if (++treeSeeded % 300 === 0) { await tb.commit(); tb = db.batch(); }
      }
      await tb.commit();
    }

    // Audit: counts only, never text.
    await auditDirect(orgId, 'handbook.ingest', `orgs/${orgId}/handbookEntriesDraft`, null,
      { pages: pdf.numPages, staged, treeSeeded, domains: parse.domains.length }, who);

    return {
      pages: pdf.numPages, staged, treeSeeded,
      domains: parse.domains.map((d) => d.code),
      note: 'Draft entries staged for review. Confirm to publish into handbookEntries.',
    };
  }
);

// ---------------- handbook.confirmDrafts ----------------
// Promote reviewed draft entries into live handbookEntries.
export const handbookConfirmDrafts = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, codes } = req.data || {}; // codes: array of entry codes to confirm, or null = all
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  let q = db.collection(`orgs/${orgId}/handbookEntriesDraft`);
  const drafts = await q.get();
  let confirmed = 0;
  let batch = db.batch();
  for (const d of drafts.docs) {
    const data = d.data();
    if (codes && !codes.includes(data.code)) continue;
    batch.set(db.doc(`orgs/${orgId}/handbookEntries/${d.id}`), {
      code: data.code, standardCode: data.standardCode ?? null, domain: data.domain ?? null,
      edition: data.edition, kind: data.kind ?? 'standard',
      text: data.text ?? '', pageRef: data.pageRef ?? null,
      rating: data.rating ?? '', designator: data.designator ?? '',
      enteredBy: who, enteredAt: FieldValue.serverTimestamp(),
    });
    batch.delete(d.ref);
    if (++confirmed % 300 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  await auditDirect(orgId, 'handbook.confirmDrafts', `orgs/${orgId}/handbookEntries`, null, { confirmed }, who);
  return { confirmed };
});

// ---------------- handbook.seedTreeFromDrafts ----------------
// Build the citation-only tree from already-staged drafts (no re-upload).
// Use when ingest ran without seedCitationTree, or to re-seed after fixing.
export const handbookSeedTreeFromDrafts = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);

  const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
  if (!lic.exists) throw new HttpsError('failed-precondition', 'No handbook license.');
  const edition = lic.get('edition');

  const drafts = await db.collection(`orgs/${orgId}/handbookEntriesDraft`).get();
  const domains = new Map();
  const standards = new Map();

  for (const d of drafts.docs) {
    const e = d.data();
    if (!e.domain) continue;
    if (!domains.has(e.domain)) domains.set(e.domain, { code: e.domain, name: e.domain });
    if (e.kind === 'guidance') continue;
    const sc = e.standardCode || e.code;
    if (!standards.has(sc)) {
      standards.set(sc, {
        code: sc, domain: sc.split('.')[0], number: Number(sc.split('.')[1]) || 0,
        elementCodes: [], order: sc,
      });
    }
    if (e.kind === 'element') standards.get(sc).elementCodes.push(e.code);
  }

  let tb = db.batch(); let n = 0; let dn = 0;
  for (const dom of domains.values()) {
    tb.set(db.doc(`standardsEditions/${edition}/domains/${dom.code}`),
      { code: dom.code, name: dom.name, order: dn++ }, { merge: true });
  }
  for (const s of standards.values()) {
    const id = s.code.replace(/\./g, '-');
    tb.set(db.doc(`standardsEditions/${edition}/standards/${id}`), {
      code: s.code, domain: s.domain, number: s.number,
      elementCodes: s.elementCodes, shortRef: '', order: s.order,
    }, { merge: true });
    if (++n % 300 === 0) { await tb.commit(); tb = db.batch(); }
  }
  await tb.commit();
  await auditDirect(orgId, 'handbook.seedTreeFromDrafts', `standardsEditions/${edition}`, null,
    { domains: domains.size, standards: n, edition }, who);
  return { edition, domains: domains.size, standards: n };
});
