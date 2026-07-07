// seed/catalog/tfc-manual.js — seeds TFC Surgery Center's REAL policy manual
// into OpsHub: the 10 sections and ~155 policy titles from the live manual at
// https://cred.tfc-bdh.com/pp/ . Creates manualSections (ordered chapters) and
// a document per policy, filed into its section with order, mapped to AAAHC
// standards per section so the coverage view works immediately.
//
// Documents are created in "linked" mode (content lives in the InDesign/source
// manual for now — content-later migration). No versions are created; add a
// version + approve when you bring each policy's content in.
//
// Usage (from repo root, on DUDESTER):
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/catalog/tfc-manual.js [orgId] [editionId]
//
// Idempotent-ish: sections are matched by title (won't duplicate); documents
// are matched by (sectionId,title). Safe to re-run.

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const ORG = process.argv[2] || 'ferguson';
const EDITION = process.argv[3] || 'aaahc-2026';

// Section → { category, standard codes, policy titles }.
// Standard codes are representative AAAHC domain pins — confirm against v44.
const MANUAL = [
  {
    title: 'Aesthetic Services', category: 'clinical', refs: ['ASG.160', 'CRD.190'],
    docType: 'procedure',
    policies: [
      'Treatment Protocol for Botulinum Toxin Type A',
      'Treatment Protocol for Calcium Hydroxylapatite Dermal Filler',
      'Treatment Protocol for Deoxycholic Acid (Kybella)',
      'Treatment Protocol for Hyaluronic Acid Dermal Filler',
      'Treatment Protocol for Laser Light Therapy',
      'Treatment Protocol for Poly-L Lactic Acid (Sculptra)',
    ],
  },
  {
    title: 'Anesthesia Services', category: 'clinical', refs: ['ASG.160'],
    docType: 'policy',
    policies: [
      'Anesthesiology Guidelines based on ASA Guidelines',
      'Anesthesia Apparatus Check Recommendations',
      'Anesthesia Care Plan', 'Anesthesia Informed Consent',
      'Anesthesia Quality Improvement', 'Anesthesia Quality Assurance Indicator Sheets',
      'Areas of Sedation', 'ASA Classification System',
      'Certified Registered Nurse Anesthetists (CRNA) Duties and Responsibilities',
      'Deeper than Expected Sedation', 'Documentation in the Medical Record',
      'General Anesthesia', 'Infection Control',
      'Intra-operative Anesthesia Monitoring and Documentation',
      'Intravenous Sedation/Procedural Sedation', 'Levels of Sedation',
      'Malignant Hyperthermia', 'PACU', 'Pre-Anesthesia Evaluation',
      'Review and Approval',
    ],
  },
  {
    title: 'Clinical Record & Health Information', category: 'governance', refs: ['ADM.150'],
    docType: 'policy',
    policies: [
      'Audits and Evaluations', 'Chart Review', 'Closing Patient Files', 'Confidentiality',
      'Corrective Action', 'Device and Media Controls', 'Disposal of PHI',
      'Email, Instant Messaging, and Internet Use', 'Emergency/Disaster Contingency Plan',
      'Faxing Private Health Information', 'Medical Records', 'Medical Records Standardization',
      'Notification of Breach of Unsecured PHI', 'Passwords', 'Patient Correspondence',
      'Patient Medical Records Release', 'Physical Security', 'Protected Health Information (PHI)',
      'Records Retention', 'Security Incident Management', 'Workstation Use', 'Workstation Security',
      'Review and Approval',
    ],
  },
  {
    title: 'Covid-19', category: 'infection-control', refs: ['ASG.160', 'FAC.270'],
    docType: 'plan',
    policies: [
      'Cleaning and Disinfection', 'Infection Prevention and Control', 'Patient Screening',
      'Staff, Contractor and Consultant Screening, Illness and Testing', 'Review and Approval',
    ],
  },
  {
    title: 'Environment of Care', category: 'safety', refs: ['FAC.270'],
    docType: 'plan',
    policies: [
      'Emergency Preparedness Plan', 'Equipment Management Plan',
      'Hazardous Material and Waste Management Plan', 'Impaired Physician Plan',
      'Incapacitated Physician Plan', 'Incident Reporting', 'Processing Physicians Orders',
      'Safety Management Plan', 'Security Management Plan', 'Utilities Management Plan',
      'Violent and Aggressive Patients & Visitors', 'Visiting Physicians and Allied Health Professionals',
      'Workplace Violence', 'Review and Approval',
    ],
  },
  {
    title: 'Hazard Communication', category: 'safety', refs: ['FAC.270'],
    docType: 'plan',
    policies: [
      'Plan Overview', 'Fire Safety', 'Guidelines for Cleaning a Chemical Spill',
      'Hazard Classes and Storage', 'Knowledge of SDS',
      'National Fire Protection Association Rating Codes', 'Right to Know', 'Safety Practices',
      'Staff and Employee Communication', 'Staff Training', 'Workplace Corrosives', 'Review and Approval',
    ],
  },
  {
    title: 'Infection Control & Prevention', category: 'infection-control', refs: ['ASG.160', 'FAC.270'],
    docType: 'policy',
    policies: [
      'Autoclave Cleaning', 'Basic Aseptic Technique', 'Checking of Needles/Glove Boxes',
      'Cleaning of Anesthesia Equipment', 'Cleaning of Brushes', 'Contagious Disease and Tuberculosis',
      'Employee Health', 'Food and Drink in a Clinical Setting', 'Guidelines Resources',
      'Guidelines for Gowning and Gloving', 'Handling and Storage of Sterile Supplies',
      'Infection Control Plan', 'Laundry Services per CDC Guidelines',
      'Loaner Instruments and External Vendor Processing',
      'Maintenance and Repair of Reusable Medical Equipment & Medical Devices',
      'Operating Room Sanitation', 'Refrigerator/Freezer Cleaning per CDC Guidelines',
      'Reporting to the Hawaii State Department of Health', 'Selection and Use of Packaging Materials',
      'Selection of Gowns and Drapes', 'Shelf-Life Guidelines', 'Spore Testing per CDC Guidelines',
      'Sterile Processing per CDC Guidelines', 'Sterile Supply Check',
      'Sterilization and Disinfection Guidelines per CDC Guidelines',
      'Storage of Sterile Packaged Materials per CDC Guidelines', 'Surgical Hand Scrub',
      'Review and Approval',
    ],
  },
  {
    title: 'Medical Laboratory Services', category: 'clinical', refs: ['ASG.160'],
    docType: 'policy',
    policies: [
      'CLIA Waiver', 'Glucose Test Quality Control', 'Glucose Tests', 'Lab Test Results',
      'Outside Laboratory Testing', 'Proficiency Testing', 'Specimen Handling',
      'Test Kits, Laboratory Devices and Supporting Supplies', 'Tissue Exemption',
      'Urine Pregnancy Test Quality Control', 'Urine Pregnancy Tests', 'Use of the Centrifuge',
      'Venipuncture', 'Review and Approval',
    ],
  },
  {
    title: 'Rights of Patients', category: 'governance', refs: ['ADM.150'],
    docType: 'policy',
    policies: [
      'Abusive Patient/Visitor', 'Advance Directives', 'After Hour Phone Message/Emergency Care',
      'Grievances', 'Interpreter Services', 'Patient Confidentiality',
      'Patient Follow-Up of Missed Appointment', 'Patient Rights and Responsibilities',
      'Patient Satisfaction Surveys', 'Patient Termination of Services', 'Patient/Family Education',
      'Patient/Parent or Legal Guardian Complaints', 'Resolution of Conflict in Care and Treatment Decisions',
      'Restraints and Seclusion', 'Suspected or Actual Patient Abuse Plan', 'Termination of Services',
      'Treatment of a Minor', 'Understanding of Informed Consent, Patient/Parent or Legal Guardian',
      'Review and Approval',
    ],
  },
  {
    title: 'Surgical Services', category: 'clinical', refs: ['ASG.160'],
    docType: 'policy',
    policies: [
      'Adverse Events', 'Approved Medical Abbreviations', 'Assessment and Management of Pain',
      'Attire in the Operating Room', 'Authenticating Orders', 'Blood Transfusions', 'Code Responses',
      'DVT Risk Assessment', 'Emergency Cart', 'Fat Grafting', 'Implants Documentation and Tracking',
      'Intra-Operative and Post-Operative Reports', 'Patient Care Orders',
      'Patient Safety in the Procedure Room', 'Patient Selection Criteria',
      'Physician Protocol for Local Anesthesia Procedures', 'Post Op Phone Call',
      'Post Procedure Instructions', 'Post-op Visit', 'Pre-Operative Checklist',
      'Pre-Procedure Instructions', 'Psychological Evaluations', 'Scope of Practice',
      'Sponge, Sharps, and Instrument Counts', 'Standing Order', 'Surgical Site Markings',
      'Surgical Suite and Operating Room', 'Time-Out Verification',
      'Visitors in the Procedure/Operating Room', 'Review and Approval',
    ],
  },
];

async function findSectionByTitle(title) {
  const q = await db.collection(`orgs/${ORG}/manualSections`).where('title', '==', title).limit(1).get();
  return q.empty ? null : q.docs[0];
}
async function findDocByTitleInSection(sectionId, title) {
  const q = await db.collection(`orgs/${ORG}/documents`)
    .where('sectionId', '==', sectionId).where('title', '==', title).limit(1).get();
  return q.empty ? null : q.docs[0];
}

async function run() {
  console.log(`Seeding TFC manual → org=${ORG}, edition=${EDITION}`);
  let secN = 0, docN = 0, skipDoc = 0;

  for (let si = 0; si < MANUAL.length; si++) {
    const sec = MANUAL[si];
    // Section (match by title so re-runs don't duplicate).
    let secDoc = await findSectionByTitle(sec.title);
    let sectionId;
    if (secDoc) { sectionId = secDoc.id; }
    else {
      const ref = db.collection(`orgs/${ORG}/manualSections`).doc();
      await ref.set({
        title: sec.title, description: '', order: si + 1,
        createdBy: 'system', createdAt: FieldValue.serverTimestamp(),
      });
      sectionId = ref.id; secN++;
    }
    console.log(`\n§ ${si + 1}. ${sec.title}  (${sec.policies.length} policies)`);

    const refs = sec.refs.map((code) => ({ editionId: EDITION, code }));
    for (let di = 0; di < sec.policies.length; di++) {
      const title = sec.policies[di];
      const existing = await findDocByTitleInSection(sectionId, title);
      if (existing) { skipDoc++; continue; }
      const ref = db.collection(`orgs/${ORG}/documents`).doc();
      await ref.set({
        title,
        docType: title === 'Review and Approval' ? 'form' : sec.docType,
        category: sec.category,
        standardRefs: refs,
        storageMode: 'linked',
        currentVersionId: null,
        reviewIntervalMonths: 12,
        lastReviewedAt: null, nextReviewDue: null,
        owner: 'system', status: 'active', requirementId: null,
        sectionId, manualOrder: di + 1,
        source: 'tfc-manual-migration',
        createdBy: 'system', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      docN++;
    }
  }

  console.log(`\nDone. ${secN} new sections, ${docN} policies created, ${skipDoc} already present.`);
  console.log('Open Policies → Manual to see the numbered TOC.');
  console.log('Each policy is "linked" with no version yet — add a version (Drive link or authored) and approve to start its review clock.');
}
run().catch((e) => { console.error(e); process.exit(1); });
