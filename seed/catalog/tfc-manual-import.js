// seed/catalog/tfc-manual-import.js — imports the REAL TFC manual content
// extracted from InDesign IDML. For each policy: creates (or reuses) its
// manual section, creates a document typed correctly, and writes ONE authored
// DRAFT version carrying structured sections (POLICY/PURPOSE/PROCEDURE/…) PLUS
// the InDesign link (belt-and-suspenders). Nothing is auto-approved — every
// version lands as a draft for human review (Liability Rule).
//
// Reads: seed/catalog/tfc-manual-content.json  (171 records)
//
// Usage (repo root, DUDESTER):
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/catalog/tfc-manual-import.js [orgId] [editionId]
//
// Idempotent: sections matched by title, documents matched by (section,title).
// Re-running updates the draft content rather than duplicating.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const ORG = process.argv[2] || 'ferguson';
const EDITION = process.argv[3] || 'aaahc-2026';

const __dir = dirname(fileURLToPath(import.meta.url));
const RECORDS = JSON.parse(readFileSync(join(__dir, 'tfc-manual-content.json'), 'utf8'));

// Section → AAAHC standard pins (same mapping as the structure seed).
const SECTION_REFS = {
  'Aesthetic Services': ['ASG.160', 'CRD.190'],
  'Anesthesia Services': ['ASG.160'],
  'Clinical Record & Health Information': ['ADM.150'],
  'Covid-19': ['ASG.160', 'FAC.270'],
  'Environment of Care': ['FAC.270'],
  'Hazard Communication': ['FAC.270'],
  'Infection Control & Prevention': ['ASG.160', 'FAC.270'],
  'Medical Laboratory Services': ['ASG.160'],
  'Rights of Patients': ['ADM.150'],
  'Surgical Services': ['ASG.160'],
};
const SECTION_CATEGORY = {
  'Aesthetic Services': 'clinical', 'Anesthesia Services': 'clinical',
  'Clinical Record & Health Information': 'governance', 'Covid-19': 'infection-control',
  'Environment of Care': 'safety', 'Hazard Communication': 'safety',
  'Infection Control & Prevention': 'infection-control', 'Medical Laboratory Services': 'clinical',
  'Rights of Patients': 'governance', 'Surgical Services': 'clinical',
};
// Live-site section order.
const SECTION_ORDER = [
  'Aesthetic Services', 'Anesthesia Services', 'Clinical Record & Health Information',
  'Covid-19', 'Environment of Care', 'Hazard Communication', 'Infection Control & Prevention',
  'Medical Laboratory Services', 'Rights of Patients', 'Surgical Services',
];

async function findSection(title) {
  const q = await db.collection(`orgs/${ORG}/manualSections`).where('title', '==', title).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}
async function ensureSection(title, order) {
  const existing = await findSection(title);
  if (existing) return existing;
  const ref = db.collection(`orgs/${ORG}/manualSections`).doc();
  await ref.set({ title, description: '', order, createdBy: 'system', createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}
async function findDoc(sectionId, title) {
  const q = await db.collection(`orgs/${ORG}/documents`)
    .where('sectionId', '==', sectionId).where('title', '==', title).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

// Flatten structured sections into a single body string (search/fallback).
function flatten(sections) {
  return sections.map((s) => (s.heading ? `## ${s.heading}\n` : '') + (s.text || '')).join('\n\n').trim();
}

async function run() {
  console.log(`Importing TFC manual content → org=${ORG}, edition=${EDITION}`);
  console.log(`Records: ${RECORDS.length}`);

  // Ensure sections exist in live order.
  const sectionIds = {};
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    sectionIds[SECTION_ORDER[i]] = await ensureSection(SECTION_ORDER[i], i + 1);
  }

  // Track order within each section.
  const orderCounter = {};
  let created = 0, updated = 0, versions = 0;

  for (const rec of RECORDS) {
    const sectionId = sectionIds[rec.section];
    if (!sectionId) { console.warn('  ! no section for', rec.title); continue; }
    orderCounter[rec.section] = (orderCounter[rec.section] || 0) + 1;
    const manualOrder = orderCounter[rec.section];

    const refs = (SECTION_REFS[rec.section] || []).map((code) => ({ editionId: EDITION, code }));
    const category = SECTION_CATEGORY[rec.section] || 'other';

    let docId = await findDoc(sectionId, rec.title);
    const docRef = docId
      ? db.doc(`orgs/${ORG}/documents/${docId}`)
      : db.collection(`orgs/${ORG}/documents`).doc();
    docId = docRef.id;

    if (await findDoc(sectionId, rec.title)) updated++; else created++;

    await docRef.set({
      title: rec.title,
      docType: rec.docType || 'policy',
      category,
      standardRefs: refs,
      storageMode: 'authored',          // content in-app…
      inddUrl: rec.inddUrl || null,     // …AND the InDesign link (belt & suspenders)
      currentVersionId: null,           // stays null — draft awaits human approval
      reviewIntervalMonths: 12,
      lastReviewedAt: null, nextReviewDue: null,
      owner: 'system', status: 'active', requirementId: null,
      sectionId, manualOrder,
      source: 'tfc-idml-import',
      createdBy: 'system', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // One authored DRAFT version with structured sections + InDesign link.
    // Deterministic version id so re-runs update rather than pile up drafts.
    const verRef = db.doc(`orgs/${ORG}/documents/${docId}/versions/import_v1`);
    await verRef.set({
      versionLabel: '1.0-draft',
      status: 'draft',
      storageMode: 'authored',
      sections: rec.sections || [],       // structured, editable blocks
      body: flatten(rec.sections || []),  // flattened for search / fallback
      driveLink: rec.inddUrl || null,     // InDesign source on the version too
      driveFileId: null, storagePath: null,
      changeSummary: 'Imported from InDesign IDML (extracted content).',
      approval: null,
      authoredBy: 'system', authoredAt: FieldValue.serverTimestamp(),
      importSource: rec.file,
    }, { merge: true });
    versions++;
  }

  console.log(`\nDone. Documents created: ${created}, updated: ${updated}. Draft versions: ${versions}.`);
  console.log('All versions are DRAFTS — review in Policies → Manual, then approve to start each review clock.');
}
run().catch((e) => { console.error(e); process.exit(1); });
