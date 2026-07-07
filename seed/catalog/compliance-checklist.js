// seed/catalog/compliance-checklist.js — seeds the full AAAHC compliance
// document checklist as documentRequirements, so the Coverage dashboard becomes
// a live survey-readiness view. Each requirement carries:
//   kind         : policy | log | register | record  (what it is)
//   backingHint  : which artifact type satisfies it (policy | obligation | register | record)
//   standardRefs : AAAHC domain pins
// After seeding, run the requirementAutoLink callable (or seed/tools) to link
// each requirement to the matching policy/obligation/register you've imported.
//
// Usage (repo root, DUDESTER):
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/catalog/compliance-checklist.js [orgId] [editionId]
//
// Idempotent: deterministic keys, merge:true.

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const ORG = process.argv[2] || 'ferguson';
const EDITION = process.argv[3] || 'aaahc-2026';

// kind: policy|log|register|record ; hint = backing artifact type
// r(): shorthand builder.
const P = (key, title, refs, cat = 'governance', months = 36) =>
  ({ key, title, category: cat, kind: 'policy', backingHint: 'policy', refs, months });
const L = (key, title, refs, cat = 'safety') =>
  ({ key, title, category: cat, kind: 'log', backingHint: 'obligation', refs, months: 12 });
const REG = (key, title, refs, cat = 'medication') =>
  ({ key, title, category: cat, kind: 'register', backingHint: 'register', refs, months: 12 });
const REC = (key, title, refs, cat = 'governance', months = 12) =>
  ({ key, title, category: cat, kind: 'record', backingHint: 'record', refs, months });

const REQS = [
  // 1. Governance
  REC('gov-body-structure', 'Governing Body Structure / Ownership', ['ADM.150'], 'governance', 36),
  REC('org-chart', 'Organizational Chart', ['ADM.150'], 'governance'),
  P('bylaws', 'Bylaws / Governing Rules', ['ADM.150'], 'governance'),
  REC('scope-of-services', 'Scope of Services Statement', ['ADM.150'], 'governance'),
  REC('gb-minutes', 'Governing Body Meeting Minutes', ['ADM.150'], 'governance', 12),
  REC('conflict-of-interest', 'Conflict of Interest Policy & Disclosures', ['ADM.150'], 'governance', 36),

  // 2. Administration
  REC('facility-license', 'Business & Facility License (Hawaii)', ['ADM.150'], 'governance'),
  REC('liability-insurance', 'Professional & General Liability Insurance', ['ADM.150'], 'governance'),
  REC('vendor-contracts', 'Vendor / Service Contracts', ['ADM.150'], 'governance'),
  REC('transfer-agreement', 'Hospital Transfer Agreement', ['ASG.160'], 'clinical'),
  REC('baa-hipaa', 'Business Associate Agreements (HIPAA)', ['ADM.150'], 'governance'),
  P('records-retention', 'Records Retention & Destruction Policy', ['ADM.150'], 'governance'),

  // 3. Rights of Patients
  P('patient-rights', 'Patient Rights & Responsibilities', ['ADM.150'], 'clinical'),
  P('informed-consent', 'Informed Consent Policy', ['ADM.150'], 'clinical'),
  P('grievance-policy', 'Grievance / Complaint Policy', ['ADM.150'], 'governance'),
  P('advance-directives', 'Advance Directives Policy', ['ADM.150'], 'clinical'),
  P('confidentiality', 'Confidentiality / HIPAA Privacy Policy', ['ADM.150'], 'governance'),
  P('treatment-of-minor', 'Treatment of a Minor Policy', ['ADM.150'], 'clinical'),
  P('interpreter-services', 'Interpreter / Language Access Policy', ['ADM.150'], 'clinical'),
  P('abuse-reporting', 'Suspected Abuse & Mandatory Reporting Policy', ['ADM.150'], 'clinical'),

  // 4. Quality Management & Improvement
  P('qi-program-plan', 'QM/QI Program Plan', ['ASG.160'], 'quality', 12),
  REC('qi-studies', 'QI Studies (PDSA, closed loop)', ['ASG.160'], 'quality', 12),
  REC('peer-review', 'Peer Review / Clinical Case Review', ['ASG.160'], 'quality', 12),
  L('incident-log', 'Adverse Event / Incident Log + CAPA', ['ASG.160'], 'quality'),
  REC('risk-management', 'Risk Management Program & Assessment', ['ASG.160'], 'quality', 12),
  REC('annual-program-eval', 'Annual Program Evaluation (QI/IC/Safety)', ['ASG.160'], 'quality', 12),

  // 5. Clinical Records & Health Information
  P('medical-record-standards', 'Medical Record Content & Documentation', ['ADM.150'], 'governance'),
  P('record-standardization', 'Medical Record Standardization', ['ADM.150'], 'governance'),
  P('records-release', 'Records Release & Correspondence Policy', ['ADM.150'], 'governance'),
  P('phi-breach', 'PHI Disposal / Breach Notification Policies', ['ADM.150'], 'governance'),
  P('info-security', 'Information Security Safeguards Policy', ['ADM.150'], 'governance'),

  // 6. Infection Prevention & Control
  P('ipc-plan', 'Infection Prevention & Control Plan', ['ASG.160', 'FAC.270'], 'infection-control', 12),
  L('sterilization-runs', 'Instrument Sterilization Runs Log', ['ASG.160'], 'infection-control'),
  L('spore-check', 'Biological (Spore) Indicator Log', ['ASG.160'], 'infection-control'),
  L('autoclave-cleaning', 'Autoclave Cleaning Log', ['ASG.160'], 'infection-control'),
  L('hand-hygiene', 'Hand Hygiene Compliance Log', ['FAC.270'], 'infection-control'),
  L('lma-reprocessing', 'High-Level Disinfection / LMA Reprocessing', ['ASG.160'], 'infection-control'),
  L('sharps-checks', 'Sharps Container Checks', ['FAC.270'], 'infection-control'),
  L('or-cleaning', 'OR / Procedure Room Cleaning Log', ['FAC.270'], 'infection-control'),
  REC('employee-health', 'Employee Health / TB / Immunization Records', ['FAC.270'], 'hr'),

  // 7. Facilities & Environment of Care
  P('safety-plan', 'Safety Management Plan', ['FAC.270'], 'safety', 12),
  P('emergency-prep', 'Emergency Preparedness Plan', ['FAC.270'], 'emergency', 12),
  P('equipment-mgmt', 'Equipment Management Plan', ['FAC.270'], 'safety', 12),
  P('utilities-mgmt', 'Utilities Management Plan', ['FAC.270'], 'safety', 12),
  P('hazmat-plan', 'Hazardous Materials & Waste Plan', ['FAC.270'], 'safety', 12),
  REC('sds-inventory', 'Hazard Communication / SDS & Chemical Inventory', ['FAC.270'], 'safety'),
  L('fire-extinguisher', 'Fire Extinguisher Checks', ['FAC.270'], 'safety'),
  L('emergency-lighting', 'Emergency Lighting / Flashlight Checks', ['FAC.270'], 'safety'),
  L('battery-backup', 'Battery Backup / Generator Test Log', ['FAC.270'], 'safety'),
  L('med-gas', 'Medical Gas / Portable O2 Checks', ['FAC.270'], 'safety'),
  L('room-temp-humidity', 'Room Temperature & Humidity Log', ['FAC.270', 'CRD.190'], 'safety'),
  L('fridge-temp', 'Refrigerator / Freezer Temperature Logs', ['FAC.270', 'CRD.190'], 'safety'),
  L('water-temp', 'Water Temperature Log', ['FAC.270'], 'safety'),
  L('warmer-temp', 'Blanket & Fluid Warmer Log', ['FAC.270'], 'safety'),
  L('laser-safety', 'Laser Safety / Laser Vacuum Log', ['FAC.270'], 'safety'),
  REC('fire-drills', 'Fire & Emergency Drills (documented)', ['FAC.270'], 'emergency', 12),
  L('hazwaste-inspection', 'Hazardous Waste Maintenance Inspection', ['FAC.270'], 'safety'),

  // 8. Emergency & Resuscitation Readiness
  L('crash-cart-checks', 'Crash Cart Equipment Checks', ['FAC.270', 'CRD.190'], 'emergency'),
  REG('crash-cart-meds', 'Crash Cart Medication Register', ['FAC.270', 'CRD.190'], 'emergency'),
  L('defib-checks', 'Defibrillator / AED Checks', ['FAC.270'], 'emergency'),
  REG('mh-supply', 'Malignant Hyperthermia Supply Register', ['FAC.270'], 'emergency'),
  REG('mh-meds', 'Malignant Hyperthermia Medication Register', ['FAC.270', 'CRD.190'], 'emergency'),
  L('mh-lock-checks', 'MH Cart Lock Integrity Checks', ['FAC.270'], 'emergency'),
  P('mh-protocol', 'Malignant Hyperthermia Protocol', ['ASG.160'], 'clinical', 12),
  P('code-response', 'Code / Emergency Response Policy', ['ASG.160'], 'clinical', 12),

  // 9. Anesthesia Services
  P('anesthesia-policy', 'Anesthesia / Sedation Policies', ['ASG.160'], 'clinical', 12),
  P('pre-anesthesia-pacu', 'Pre-Anesthesia Eval & PACU / Discharge', ['ASG.160'], 'clinical', 12),
  L('anesthesia-machine', 'Anesthesia Machine / Apparatus Checks', ['ASG.160'], 'clinical'),
  P('deeper-sedation', 'Deeper-Than-Intended Sedation & Rescue', ['ASG.160'], 'clinical', 12),

  // 10. Surgical / Procedure Services
  P('patient-selection', 'Patient Selection Criteria & Scope', ['ASG.160'], 'clinical', 12),
  P('time-out', 'Time-Out / Universal Protocol & Site Marking', ['ASG.160'], 'clinical', 12),
  P('counts', 'Sponge, Sharps & Instrument Counts', ['ASG.160'], 'clinical', 12),
  P('perioperative-instructions', 'Pre-Op / Post-Op Instructions & Follow-Up', ['ASG.160'], 'clinical', 12),
  L('implant-log', 'Implant Documentation & Tracking', ['ADM.150', 'FAC.270'], 'clinical'),
  P('specimen-handling', 'Tissue / Specimen Handling & Exemption', ['ASG.160'], 'clinical', 12),

  // 11. Pharmaceutical / Medication Management
  P('medication-mgmt', 'Medication Management Policy', ['CRD.190'], 'medication', 12),
  REG('general-meds', 'General / Refrigerated Medication Register', ['FAC.270', 'CRD.190'], 'medication'),
  L('narcotic-count', 'Controlled Substance Inventory Count', ['ADM.150', 'FAC.270'], 'medication'),
  L('drug-discrepancies', 'Drug Discrepancy Log & Reconciliation', ['FAC.270'], 'medication'),
  L('med-disposal', 'Medication Disposal / Wastage Log', ['FAC.270', 'CRD.190'], 'medication'),
  L('med-shortage', 'Medication Shortage / Backorder Tracking', ['FAC.270'], 'medication'),
  REC('dea-registration', 'DEA Registration & Controlled-Substance Security', ['CRD.190'], 'medication'),

  // 12. Medical Laboratory Services
  P('clia-waiver', 'CLIA Waiver & Waived Test List', ['ASG.160'], 'clinical', 12),
  P('specimen-venipuncture', 'Specimen Handling & Venipuncture', ['ASG.160'], 'clinical', 12),
  L('glucose-qc', 'Glucose Test QC Log', ['ASG.160'], 'clinical'),
  L('pregnancy-qc', 'Urine Pregnancy Test QC Log', ['ASG.160'], 'clinical'),
  REC('proficiency-testing', 'Proficiency Testing (if applicable)', ['ASG.160'], 'clinical'),

  // 13. Aesthetic Services
  P('aesthetic-protocols', 'Aesthetic Treatment Protocols', ['ASG.160', 'CRD.190'], 'clinical', 12),
  REC('aesthetic-consent', 'Aesthetic Informed Consent & Pre/Post Care', ['ADM.150'], 'clinical'),
  REG('aesthetic-products', 'Aesthetic Product Storage & Lot Tracking', ['CRD.190'], 'medication'),

  // 14. Personnel & Credentialing
  REC('credentialing-files', 'Credentialing & Privileging Files (PSV)', ['CRD.190'], 'hr', 24),
  REC('license-tracking', 'License / DEA / Board Cert Tracking', ['CRD.190'], 'hr', 12),
  REC('reappointment', 'Provider Re-Appointment / Re-Privileging', ['CRD.190'], 'hr', 24),
  REC('competency', 'Job Descriptions & Competency Assessments', ['ADM.150'], 'hr', 12),
  REC('training-records', 'Orientation & Annual In-Service Training', ['ADM.150'], 'hr', 12),
  REC('bls-acls', 'BLS / ACLS Certification Tracking', ['ASG.160'], 'hr', 12),
  REC('oig-sam', 'OIG / SAM Exclusion Screening', ['ADM.150'], 'hr', 12),
  P('impaired-practitioner', 'Impaired / Incapacitated Practitioner Policy', ['ADM.150'], 'hr'),
];

async function run() {
  console.log(`Seeding ${REQS.length} compliance requirements → org=${ORG}, edition=${EDITION}`);
  let n = 0;
  const chunks = [];
  for (let i = 0; i < REQS.length; i += 400) chunks.push(REQS.slice(i, i + 400));
  for (const chunk of chunks) {
    const batch = db.batch();
    for (const r of chunk) {
      batch.set(db.doc(`orgs/${ORG}/documentRequirements/${r.key}`), {
        key: r.key, title: r.title, description: '',
        category: r.category, required: true, kind: r.kind, backingHint: r.backingHint,
        standardRefs: r.refs.map((code) => ({ editionId: EDITION, code })),
        reviewIntervalMonths: r.months,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      n++;
    }
    await batch.commit();
  }
  const byKind = REQS.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
  console.log(`Done. ${n} requirements seeded.`);
  console.log('By kind:', JSON.stringify(byKind));
  console.log('\nNext: call requirementAutoLink to link each to your policy/log/register,');
  console.log('then open Policies → Coverage for the live survey-readiness dashboard.');
}
run().catch((e) => { console.error(e); process.exit(1); });
