// seed/catalog/required-documents.js — the AAAHC-expected document set for an
// ambulatory surgery center. Seeds documentRequirements so the coverage
// dashboard has something to measure against. Standard codes are representative
// domain pins — confirm against your v44 tree.
//
// Usage (from repo root, on DUDESTER):
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/catalog/required-documents.js [orgId] [editionId]

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const ORG = process.argv[2] || 'ferguson';
const EDITION = process.argv[3] || 'aaahc-2026';

const REQS = [
  { key: 'governing-body-bylaws', title: 'Governing Body Bylaws / Structure', category: 'governance', refs: ['ADM.150'], months: 36 },
  { key: 'org-chart', title: 'Organizational Chart', category: 'governance', refs: ['ADM.150'], months: 12 },
  { key: 'credentialing-policy', title: 'Credentialing & Privileging Policy', category: 'governance', refs: ['CRD.190'], months: 36 },
  { key: 'qi-program-plan', title: 'Quality Improvement Program Plan', category: 'quality', refs: ['ASG.160'], months: 12 },
  { key: 'ipc-plan', title: 'Infection Prevention & Control Plan', category: 'infection-control', refs: ['ASG.160', 'FAC.270'], months: 12 },
  { key: 'exposure-control-plan', title: 'Bloodborne Pathogen / Exposure Control Plan', category: 'infection-control', refs: ['FAC.270'], months: 12 },
  { key: 'sterilization-sop', title: 'Sterilization & Reprocessing Procedures', category: 'infection-control', refs: ['ASG.160'], months: 12 },
  { key: 'emergency-preparedness', title: 'Emergency Preparedness / Disaster Plan', category: 'emergency', refs: ['FAC.270'], months: 12 },
  { key: 'fire-safety-plan', title: 'Fire Safety & Evacuation Plan', category: 'emergency', refs: ['FAC.270'], months: 12 },
  { key: 'malignant-hyperthermia', title: 'Malignant Hyperthermia Protocol', category: 'clinical', refs: ['ASG.160'], months: 12 },
  { key: 'anesthesia-policy', title: 'Anesthesia / Sedation Policy', category: 'clinical', refs: ['ASG.160'], months: 12 },
  { key: 'medication-management', title: 'Medication Management Policy', category: 'medication', refs: ['CRD.190'], months: 12 },
  { key: 'controlled-substance-policy', title: 'Controlled Substance Handling Policy', category: 'medication', refs: ['CRD.190', 'ADM.150'], months: 12 },
  { key: 'patient-rights', title: 'Patient Rights & Responsibilities', category: 'clinical', refs: ['ADM.150'], months: 36 },
  { key: 'informed-consent-policy', title: 'Informed Consent Policy', category: 'clinical', refs: ['ADM.150'], months: 36 },
  { key: 'grievance-policy', title: 'Patient Grievance / Complaint Policy', category: 'governance', refs: ['ADM.150'], months: 36 },
  { key: 'transfer-agreement', title: 'Hospital Transfer Agreement', category: 'clinical', refs: ['ASG.160'], months: 12 },
  { key: 'discharge-criteria', title: 'Discharge Criteria & Post-op Instructions', category: 'clinical', refs: ['ASG.160'], months: 12 },
  { key: 'hr-policy', title: 'Personnel / HR Policy Manual', category: 'hr', refs: ['ADM.150'], months: 36 },
  { key: 'safety-plan', title: 'Environmental Safety Management Plan', category: 'safety', refs: ['FAC.270'], months: 12 },
];

async function run() {
  console.log(`Seeding ${REQS.length} required documents → org=${ORG}`);
  const batch = db.batch();
  for (const r of REQS) {
    batch.set(db.doc(`orgs/${ORG}/documentRequirements/${r.key}`), {
      key: r.key, title: r.title, description: '',
      category: r.category, required: true,
      standardRefs: r.refs.map((code) => ({ editionId: EDITION, code })),
      reviewIntervalMonths: r.months,
    }, { merge: true });
    console.log(`  ✓ ${r.title}`);
  }
  await batch.commit();
  console.log('Done. Open the Policies → Coverage tab to see gaps.');
}
run().catch((e) => { console.error(e); process.exit(1); });
