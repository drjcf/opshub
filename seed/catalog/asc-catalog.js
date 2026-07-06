// seed/catalog/asc-catalog.js — standard ASC logs & checklists.
// Seeds checklistTemplates + recurring obligations for an ambulatory surgery
// center: temperature logs, sterilization, controlled substances, safety
// checks, OR readiness. Each obligation carries an rrule cadence + AAAHC
// standard refs so completions become evidence mapped to the crosswalk.
//
// Usage (from repo root, on DUDESTER):
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/catalog/asc-catalog.js [orgId] [editionId]
//
// Idempotent: uses deterministic doc IDs, merge:true. Re-run safely.

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const ORG = process.argv[2] || 'ferguson';
const EDITION = process.argv[3] || 'aaahc-2026';

// Rating/range helpers for check fields.
const num = (key, label, unit, min, max, required = true) =>
  ({ key, label, type: 'number', unit, required, range: (min != null ? { min, max } : undefined) });
const bool = (key, label, required = true) => ({ key, label, type: 'bool', required });
const text = (key, label, required = false) => ({ key, label, type: 'text', required });
const sel = (key, label, options, required = true) => ({ key, label, type: 'select', options, required });

// The catalog: each entry = a template + a recurring obligation.
// cadence uses RRULE; standardRefs pin to AAAHC codes (adjust codes to your
// confirmed v44 tree — these are representative domain pins).
const CATALOG = [
  {
    id: 'temp_med_fridge',
    title: 'Medication Refrigerator Temperature',
    cadence: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    refs: ['FAC.270', 'CRD.190'],
    fields: [
      num('tempC', 'Temperature', '°C', 2, 8),
      bool('inRange', 'Within 2–8°C range?'),
      text('action', 'Corrective action (if out of range)'),
    ],
  },
  {
    id: 'temp_freezer',
    title: 'Freezer Temperature',
    cadence: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    refs: ['FAC.270'],
    fields: [num('tempC', 'Temperature', '°C', -30, -15), bool('inRange', 'Within range?'), text('action', 'Corrective action')],
  },
  {
    id: 'temp_supply_room',
    title: 'Supply / Med Storage Room Temp & Humidity',
    cadence: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    refs: ['FAC.270'],
    fields: [
      num('tempF', 'Temperature', '°F', 68, 75),
      num('humidity', 'Relative humidity', '%', 30, 60),
      bool('inRange', 'Both within range?'),
    ],
  },
  {
    id: 'sterilizer_autoclave',
    title: 'Autoclave / Sterilizer Cycle Log',
    cadence: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=30',
    refs: ['ASG.160', 'FAC.270'],
    fields: [
      text('loadId', 'Load / cycle ID', true),
      num('tempF', 'Cycle temperature', '°F', 250, 275),
      num('durationMin', 'Exposure time', 'min', 3, 60),
      sel('biologicalIndicator', 'Biological indicator result', ['Pass', 'Fail', 'Pending', 'N/A - not due']),
      sel('chemicalIndicator', 'Chemical indicator', ['Pass', 'Fail']),
      bool('loadReleased', 'Load released for use?'),
    ],
  },
  {
    id: 'sterilizer_spore',
    title: 'Weekly Spore / Biological Indicator Test',
    cadence: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7',
    refs: ['ASG.160'],
    fields: [
      sel('result', 'Spore test result', ['Pass', 'Fail', 'Pending']),
      text('lotNumber', 'BI lot number', true),
      text('action', 'Action if fail (recall loads, re-test)'),
    ],
  },
  {
    id: 'controlled_substance',
    title: 'Controlled Substance / Narcotics Count',
    cadence: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    refs: ['CRD.190', 'ADM.150'],
    fields: [
      bool('countMatches', 'Physical count matches record?'),
      text('discrepancy', 'Discrepancy detail (if any)'),
      text('witness', 'Second-signature witness', true),
      bool('secured', 'Returned to double-lock storage?'),
    ],
  },
  {
    id: 'crash_cart_daily',
    title: 'Crash Cart Check',
    cadence: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    refs: ['ASG.160', 'CRD.190'],
    isRegister: true, // uses the register/par mechanism, not a field checklist
    fields: [],
  },
  {
    id: 'defibrillator_check',
    title: 'Defibrillator / AED Function Check',
    cadence: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    refs: ['ASG.160'],
    fields: [
      bool('selfTestPass', 'Self-test passed?'),
      bool('padsInDate', 'Pads in date?'),
      bool('batteryCharged', 'Battery charged?'),
      num('padsExpiryDays', 'Days until pads expire', 'days', 0, 3650, false),
    ],
  },
  {
    id: 'eyewash_station',
    title: 'Emergency Eyewash Station',
    cadence: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8',
    refs: ['FAC.270'],
    fields: [
      bool('flushed', 'Flushed for 3 minutes?'),
      bool('clearFlow', 'Clear, unobstructed flow?'),
      bool('capsIntact', 'Protective caps intact?'),
    ],
  },
  {
    id: 'fire_extinguisher',
    title: 'Fire Extinguisher Inspection',
    cadence: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9',
    refs: ['FAC.270'],
    fields: [
      bool('gaugeGreen', 'Gauge in green zone?'),
      bool('pinSealIntact', 'Pin & seal intact?'),
      bool('accessClear', 'Access unobstructed?'),
      bool('tagCurrent', 'Annual service tag current?'),
    ],
  },
  {
    id: 'generator_test',
    title: 'Emergency Generator / Backup Power Test',
    cadence: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16',
    refs: ['FAC.270'],
    fields: [
      bool('started', 'Generator started under load?'),
      num('runMin', 'Run time', 'min', 5, 120),
      bool('transferOk', 'Automatic transfer switch functioned?'),
      text('notes', 'Observations'),
    ],
  },
  {
    id: 'malignant_hyperthermia',
    title: 'Malignant Hyperthermia Cart Check',
    cadence: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7',
    refs: ['ASG.160'],
    fields: [
      bool('dantroleneStocked', 'Dantrolene stocked to par?'),
      bool('coldSalineAvailable', 'Cold saline available?'),
      bool('suppliesInDate', 'All supplies in date?'),
      num('dantroleneVials', 'Dantrolene vials on hand', 'vials', 0, 100),
    ],
  },
  {
    id: 'anesthesia_machine',
    title: 'Anesthesia Machine Pre-Use Checkout',
    cadence: 'FREQ=DAILY;BYHOUR=6;BYMINUTE=45',
    refs: ['ASG.160'],
    fields: [
      bool('leakTest', 'Low-pressure leak test passed?'),
      bool('o2Supply', 'O2 supply & backup cylinder verified?'),
      bool('scavenging', 'Scavenging system functional?'),
      bool('co2Absorbent', 'CO2 absorbent adequate?'),
      bool('alarmsTested', 'Alarms tested?'),
      bool('suctionReady', 'Suction present & working?'),
    ],
  },
  {
    id: 'or_daily_open',
    title: 'OR Opening Readiness Checklist',
    cadence: 'FREQ=DAILY;BYHOUR=6;BYMINUTE=30',
    refs: ['ASG.160', 'FAC.270'],
    fields: [
      bool('terminalCleanDone', 'Terminal clean completed?'),
      bool('tempHumidityOk', 'Temp & humidity in range?'),
      num('roomTempF', 'Room temperature', '°F', 68, 75),
      num('roomHumidity', 'Humidity', '%', 20, 60),
      bool('suctionReady', 'Suction ready?'),
      bool('emergencyEquipPresent', 'Emergency equipment present?'),
    ],
  },
  {
    id: 'biohazard_sharps',
    title: 'Biohazard / Sharps Container Check',
    cadence: 'FREQ=DAILY;BYHOUR=17;BYMINUTE=0',
    refs: ['FAC.270'],
    fields: [
      bool('belowFill', 'All containers below fill line?'),
      bool('secured', 'Containers secured & upright?'),
      bool('pickupScheduled', 'Pickup scheduled if needed?'),
    ],
  },
  {
    id: 'hand_hygiene_audit',
    title: 'Hand Hygiene Compliance Audit',
    cadence: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=12',
    refs: ['ASG.160'],
    fields: [
      num('observations', 'Observations counted', '', 0, 1000),
      num('compliant', 'Compliant observations', '', 0, 1000),
      num('rate', 'Compliance rate', '%', 0, 100),
      text('notes', 'Notes / opportunities'),
    ],
  },
];

async function run() {
  console.log(`Seeding ASC catalog → org=${ORG}, edition=${EDITION}`);
  let templates = 0, obligations = 0;

  for (const c of CATALOG) {
    // Template (skip field template for the register-based crash cart).
    if (!c.isRegister) {
      await db.doc(`orgs/${ORG}/checklistTemplates/tmpl_${c.id}`).set({
        title: c.title,
        fields: c.fields,
        standardRefs: c.refs.map((code) => ({ editionId: EDITION, code })),
        version: 1,
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      templates++;
    }

    // Recurring obligation that materializes tasks on the cadence.
    await db.doc(`orgs/${ORG}/obligations/ob_${c.id}`).set({
      title: c.title,
      description: `Standard ASC ${c.title.toLowerCase()}.`,
      standardRefs: c.refs.map((code) => ({ editionId: EDITION, code })),
      cadence: c.cadence,
      evidenceType: c.isRegister ? 'register' : 'checklist',
      checklistTemplateId: c.isRegister ? null : `tmpl_${c.id}`,
      registerId: c.isRegister ? 'reg_crashcart_or1' : null,
      checkpointId: null,          // assign to a checkpoint in the UI if scan-gated
      requireScan: false,
      status: 'active',
      catalogId: c.id,             // marks these as catalog-seeded
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    obligations++;
    console.log(`  ✓ ${c.title}  [${c.cadence.split(';')[0].replace('FREQ=', '').toLowerCase()}]`);
  }

  console.log(`\nDone. ${templates} templates, ${obligations} obligations seeded.`);
  console.log('Next: run materializeTasks (Cloud Scheduler → Run now) to generate due tasks.');
}

run().catch((e) => { console.error(e); process.exit(1); });
