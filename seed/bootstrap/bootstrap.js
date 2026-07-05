// seed/bootstrap/bootstrap.js — one-time deployment bootstrap.
// Stands up the org, YOUR owner account, and enough real data that the
// admin console renders something meaningful (a crash cart with near-term
// expirations so the amber/red status system visibly works).
//
// Run on DUDESTER:
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/bootstrap/bootstrap.js
//
// Idempotent: re-running updates in place, never duplicates. Safe to run again.

import { randomBytes } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

// ---- config for THIS deployment ----
const PROJECT_ID = 'edai-opshub';
const ORG_ID = 'ferguson';
const ADMIN_EMAIL = 'john@thefergusonclinic.com';
const ORG_NAME = 'The Ferguson Clinic';
const TIMEZONE = 'Pacific/Honolulu';

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(readFileSync(credPath, 'utf8'))), projectId: PROJECT_ID });

const db = getFirestore();
const auth = getAuth();
const DAY = 86400000;
const daysOut = (d) => Timestamp.fromMillis(Date.now() + d * DAY);

async function main() {
  console.log(`Bootstrapping ${ORG_NAME} (${ORG_ID}) on ${PROJECT_ID}…\n`);

  // 1) Org doc ------------------------------------------------------------
  await db.doc(`orgs/${ORG_ID}`).set({
    name: ORG_NAME,
    legalName: 'The Ferguson Clinic',
    facilityType: 'combined',
    accreditation: {
      body: 'AAAHC',
      editionId: 'aaahc-2026',
      programType: 'ambulatory',
      surveyWindow: null,
    },
    timezone: TIMEZONE,
    licenseKey: `dev-${randomBytes(6).toString('hex')}`,
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('✓ org');

  // 2) Owner account + custom claim --------------------------------------
  let user;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
    console.log(`✓ owner user exists (${user.uid})`);
  } catch {
    const tempPassword = randomBytes(9).toString('base64url');
    user = await auth.createUser({ email: ADMIN_EMAIL, password: tempPassword, emailVerified: true });
    console.log(`✓ owner user created (${user.uid})`);
    console.log(`\n  TEMP PASSWORD: ${tempPassword}`);
    console.log('  Sign in with this, then change it. (Or use the Auth console to send a reset.)\n');
  }
  await auth.setCustomUserClaims(user.uid, {
    orgId: ORG_ID,
    roles: ['owner', 'admin'],
  });
  console.log('✓ owner+admin claim set');

  // members mirror (UI/display)
  await db.doc(`orgs/${ORG_ID}/members/${user.uid}`).set({
    displayName: 'Dr. John Ferguson',
    email: ADMIN_EMAIL,
    title: 'Medical Director',
    roles: ['owner', 'admin'],
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('✓ member mirror');

  // 3) Standards edition stub (citations only — no AAAHC verbatim text) ---
  await db.doc('standardsEditions/aaahc-2026').set({
    label: 'AAAHC Accreditation Handbook (2026)',
    programType: 'ambulatory',
    effectiveFrom: Timestamp.now(),
    status: 'current',
  }, { merge: true });
  await db.doc('standardsEditions/aaahc-2026/standards/10-I-C').set({
    code: '10.I.C', chapter: 10, chapterName: 'Surgical and Related Services',
    subchapter: 'I', element: 'C',
    shortRef: 'Emergency equipment / crash cart readiness',
    tags: ['safety', 'equipment'], sortKey: '10.09.03',
  }, { merge: true });
  console.log('✓ standards stub');

  // 4) Checkpoint for the crash cart -------------------------------------
  const cpToken = randomBytes(16).toString('base64url');
  const cpRef = db.doc(`orgs/${ORG_ID}/checkpoints/cp_crashcart_or1`);
  await cpRef.set({
    label: 'Crash Cart — OR 1',
    location: 'Operating Room 1',
    assetId: null,
    obligationIds: ['ob_crashcart_daily'],
    allowAdhocLog: false,
    adhocTemplateId: null,
    qrToken: cpToken,
    tokenRotatedAt: FieldValue.serverTimestamp(),
    active: true,
    createdBy: 'system',
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('✓ checkpoint (crash cart OR 1)');

  // 5) Crash cart register with REAL meds + near-term expirations ---------
  //    Deliberate spread so the status system shows all three colors:
  //    one expired (red), one within lead window (amber), rest ok (green).
  await db.doc(`orgs/${ORG_ID}/registers/reg_crashcart_or1`).set({
    kind: 'medTray',
    title: 'Crash Cart — OR 1',
    checkpointId: 'cp_crashcart_or1',
    leadTimeDays: 30,
    criticalDays: 7,
    items: [
      { key: 'epi-1mg',   name: 'Epinephrine 1mg/10mL (1:10,000)', category: 'medication', lot: 'EP4471', expiresAt: daysOut(-3),  qty: 2, par: 2, required: true },
      { key: 'atropine',  name: 'Atropine 1mg/10mL',               category: 'medication', lot: 'AT2210', expiresAt: daysOut(18),  qty: 2, par: 2, required: true },
      { key: 'amiodarone',name: 'Amiodarone 150mg/3mL',            category: 'medication', lot: 'AM8830', expiresAt: daysOut(210), qty: 3, par: 3, required: true },
      { key: 'lidocaine', name: 'Lidocaine 100mg/5mL',             category: 'medication', lot: 'LD1120', expiresAt: daysOut(95),  qty: 2, par: 2, required: true },
      { key: 'naloxone',  name: 'Naloxone 0.4mg/mL',               category: 'medication', lot: 'NX0455', expiresAt: daysOut(60),  qty: 2, par: 2, required: true },
      { key: 'dextrose',  name: 'Dextrose 50% 25g/50mL',           category: 'medication', lot: 'DX9001', expiresAt: daysOut(140), qty: 1, par: 1, required: true },
      { key: 'sodabicarb',name: 'Sodium Bicarbonate 8.4% 50mEq',   category: 'medication', lot: 'SB3300', expiresAt: daysOut(310), qty: 1, par: 1, required: true },
      { key: 'laryngoscope', name: 'Laryngoscope handle + blades', category: 'equipment', lot: null, expiresAt: null, qty: 1, par: 1, required: true },
      { key: 'bvm',       name: 'Bag-valve mask (adult)',          category: 'equipment', lot: null, expiresAt: null, qty: 1, par: 1, required: true },
      { key: 'defib-pads',name: 'Defibrillator pads (adult)',      category: 'supply', lot: 'DP7788', expiresAt: daysOut(25), qty: 2, par: 2, required: true },
    ],
    lastCheckedAt: null,
    lastCheckEvidenceId: null,
    version: 1,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('✓ crash cart register (10 items: 1 expired, 2 expiring, rest ok)');

  // 6) Daily crash-cart-check obligation ---------------------------------
  await db.doc(`orgs/${ORG_ID}/obligations/ob_crashcart_daily`).set({
    title: 'Crash cart check — OR 1',
    description: 'Daily verification of crash cart contents, quantities, and expirations.',
    standardRefs: [{ editionId: 'aaahc-2026', standardId: '10-I-C' }],
    cadence: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    evidenceType: 'checklist',
    checklistTemplateId: null,
    checkpointId: 'cp_crashcart_or1',
    registerId: 'reg_crashcart_or1',
    requireScan: true,
    assignedRole: 'clinicalDirector',
    assignedUid: null,
    gracePeriodDays: 1,
    escalation: [{ afterDays: 1, notifyRole: 'admin' }],
    status: 'active',
    createdBy: 'system',
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('✓ daily obligation');

  console.log('\nBootstrap complete.');
  console.log(`\nScan URL for the crash cart label:\n  /s/${cpToken}`);
  console.log('\nNext: sign in at the app with the owner email above.');
  process.exit(0);
}

main().catch((e) => { console.error('\nBootstrap failed:', e); process.exit(1); });
