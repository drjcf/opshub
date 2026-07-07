// seed/logs/import-logs.js — imports TFC operational logs from Excel exports.
//
// For each .xlsx in a folder: reads the header row to build a checklist
// template (the log-specific task columns become fields), infers cadence from
// the entry dates, creates the recurring obligation (LIVE going forward), and
// backfills every historical row as FINALIZED evidence linked to that
// obligation — so the Logs hub shows accurate last-completed dates and a full
// audit trail, and the log keeps recurring from today.
//
// Stack: Node ESM + firebase-admin + SheetJS (xlsx). Matches OpsHub seeds.
//
// Usage (repo root, DUDESTER):
//   export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
//   node seed/logs/import-logs.js <folder> [orgId] [editionId] [--dry]
//
// --dry prints the plan (template fields, cadence, entry count) without writing.
// Idempotent: deterministic ids per log title; evidence ids derived from the
// row's date + submitter, so re-running updates rather than duplicating.

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import pkg from 'xlsx';
const { read, utils, SSF } = pkg;
const XLSX = { read, utils, SSF };
// read from a buffer so no ESM fs binding is needed inside SheetJS
XLSX.readFile = (path, opts) => read(fs.readFileSync(path), { type: 'buffer', cellDates: true, ...opts });
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const positional = args.filter((a) => !a.startsWith('--'));
const FOLDER = positional[0];
const ORG = positional[1] || 'ferguson';
const EDITION = positional[2] || 'aaahc-2026';
if (!FOLDER) { console.error('Usage: node import-logs.js <folder> [orgId] [editionId] [--dry]'); process.exit(1); }

// Columns that are entry METADATA, not template fields (matched case-insensitively).
const META_COLS = new Set([
  'date', 'data collected time', 'location', 'regulation/standard reference #',
  'regulation/standard reference', 'comments', 'submitted by', 'submitted at',
]);

// Log title → AAAHC standard codes. Extend as you see your real set; unmapped
// logs get a safe default and are flagged in the run report.
const STANDARD_MAP = [
  [/autoclave|steril|spore|aseptic|instrument|scope|gown|glove|sanitation|infection|disinfect/i, ['ASG.160', 'FAC.270']],
  [/refrigerat|freezer|temperature|temp|medication|crash|cart|par.?level|expir/i, ['FAC.270', 'CRD.190']],
  [/emergency|fire|safety|drill|generator|utility|hazard|spill|eyewash/i, ['FAC.270']],
  [/controlled|narcotic|substance|log/i, ['ADM.150', 'FAC.270']],
];
const DEFAULT_REFS = ['FAC.270'];
function refsFor(title) {
  for (const [re, codes] of STANDARD_MAP) if (re.test(title)) return codes;
  return DEFAULT_REFS;
}

// Derive a human title from a filename like "Autoclave_Cleaning__Basic_.xlsx".
function titleFromFile(file) {
  return basename(file, extname(file))
    .replace(/_+/g, ' ').replace(/\bBasic\b/i, '')
    .replace(/\(\s*\)/g, '')                 // drop empty parens left by strips
    .replace(/\s+/g, ' ').trim();
}

// Infer a field type from a column's sample values.
function inferType(values) {
  const vals = values.filter((v) => v != null && String(v).trim() !== '');
  if (vals.length === 0) return { type: 'text' };
  const set = new Set(vals.map((v) => String(v).trim().toLowerCase()));
  const yesno = new Set(['yes', 'no', 'n/a', 'na', 'true', 'false']);
  if ([...set].every((v) => yesno.has(v))) return { type: 'bool' };
  if (vals.every((v) => !isNaN(Number(v)))) {
    const nums = vals.map(Number);
    return { type: 'number', range: { min: Math.min(...nums), max: Math.max(...nums) } };
  }
  if (set.size <= 8 && vals.length >= set.size * 2) return { type: 'select', options: [...new Set(vals.map((v) => String(v).trim()))] };
  return { type: 'text' };
}

const RRULE = { 1: 'FREQ=DAILY', 7: 'FREQ=WEEKLY', 14: 'FREQ=WEEKLY;INTERVAL=2', 30: 'FREQ=MONTHLY', 31: 'FREQ=MONTHLY', 90: 'FREQ=MONTHLY;INTERVAL=3', 365: 'FREQ=YEARLY' };

// A log is a REGISTER (inventory/par list) rather than a cadence checklist when
// its columns describe items (Drug/Item + Par/On Hand + Lot/Expiration) and many
// rows share the same date (a list captured per revision, not a daily check).
const ITEM_NAME_COLS = ['drug', 'item', 'medication name', 'drug name', 'implant description'];
function detectRegister(headers, entries) {
  const H = headers.map((h) => (h || '').toLowerCase());
  const has = (needle) => H.some((h) => h.includes(needle));
  const inventoryish = (has('par') || has('on hand')) && (has('lot') || has('expiration') || has('drawer'));
  const nameCol = ITEM_NAME_COLS.find((n) => H.some((h) => h === n || h.includes(n)));
  if (!inventoryish || !nameCol) return null;
  // date repetition: rows >> distinct dates → a list, not daily completions
  const dates = entries.map((e) => e.date && e.date.toISOString().slice(0, 10)).filter(Boolean);
  const distinct = new Set(dates).size;
  const repetitive = entries.length >= 4 && distinct <= Math.max(3, entries.length / 3);
  if (!repetitive && entries.length > 6) return null; // has real cadence → treat as checklist
  return { nameCol };
}

function findCol(headers, candidates) {
  const H = headers.map((h) => (h || '').toLowerCase());
  for (const c of candidates) { const i = H.findIndex((h) => h === c || h.includes(c)); if (i >= 0) return i; }
  return -1;
}
function inferCadence(dates) {
  // Use DISTINCT dates — many logs record multiple rows per day (one per
  // location/item), which would otherwise collapse the interval to zero.
  const uniq = [...new Set(dates.map((d) => (d instanceof Date && !isNaN(d)) ? d.toISOString().slice(0, 10) : null).filter(Boolean))];
  const ds = uniq.map((s) => new Date(s + 'T00:00:00Z')).sort((a, b) => a - b);
  if (ds.length < 2) return { rrule: null, label: 'PRN / as-needed', medianDays: null };
  const diffs = [];
  for (let i = 1; i < ds.length; i++) diffs.push(Math.round((ds[i] - ds[i - 1]) / 86400000));
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)] || null;
  // snap to nearest known cadence
  const keys = Object.keys(RRULE).map(Number);
  const nearest = keys.reduce((best, k) => Math.abs(k - median) < Math.abs(best - median) ? k : best, keys[0]);
  const snap = Math.abs(nearest - median) <= Math.max(2, nearest * 0.3) ? nearest : null;
  return { rrule: snap ? RRULE[snap] : null, label: snap ? `~${median}d (→ ${RRULE[snap]})` : `irregular ~${median}d`, medianDays: median };
}

function key(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40); }
function parseDateVal(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') { const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null; if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d)); }
  const d = new Date(v); return isNaN(d) ? null : d;
}

function analyzeWorkbook(file) {
  const wb = XLSX.readFile(file, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => (h == null ? '' : String(h).trim()));
  const body = rows.slice(1).filter((r) => r.some((c) => c != null && String(c).trim() !== ''));

  const colIndex = {};
  headers.forEach((h, i) => { colIndex[h.toLowerCase()] = i; });
  const dateIdx = colIndex['date'] ?? 0;
  const byIdx = colIndex['submitted by'];
  const atIdx = colIndex['submitted at'];
  const commentsIdx = colIndex['comments'];

  // Field columns = non-meta headers with a real name.
  const fields = [];
  headers.forEach((h, i) => {
    if (!h) return;
    if (META_COLS.has(h.toLowerCase())) return;
    const colVals = body.map((r) => r[i]);
    const t = inferType(colVals);
    const f = { key: key(h), label: h, type: t.type, required: false };
    if (t.type === 'number' && t.range) f.range = t.range;
    if (t.type === 'select' && t.options) f.options = t.options;
    fields.push(f);
  });

  const entries = body.map((r) => {
    const answers = {};
    headers.forEach((h, i) => {
      if (!h || META_COLS.has(h.toLowerCase())) return;
      const raw = r[i];
      const k = key(h);
      const ft = fields.find((f) => f.key === k)?.type;
      answers[k] = ft === 'bool' ? /^(yes|true)$/i.test(String(raw ?? '').trim())
        : (raw == null ? null : (ft === 'number' ? Number(raw) : String(raw)));
    });
    return {
      date: parseDateVal(r[dateIdx]),
      submittedBy: byIdx != null ? r[byIdx] : null,
      submittedAt: atIdx != null ? r[atIdx] : null,
      comments: commentsIdx != null ? r[commentsIdx] : null,
      answers,
    };
  }).filter((e) => e.date);

  const cadence = inferCadence(entries.map((e) => e.date));

  // Register detection: build items from the most-recent snapshot.
  const reg = detectRegister(headers, entries);
  let register = null;
  if (reg) {
    const nameIdx = findCol(headers, [reg.nameCol]);
    const parIdx = findCol(headers, ['par stock', 'par']);
    const qtyIdx = findCol(headers, ['on hand', 'quantity', 'number of vials', 'drug amount']);
    const lotIdx = findCol(headers, ['lot #1', 'lot number', 'lot #', 'lot']);
    const expIdx = findCol(headers, ['lot #1 expiration', 'expiration date', 'expiration']);
    const drawerIdx = findCol(headers, ['drawer', 'drawer number']);
    const dateIdx = findCol(headers, ['date']);
    // Dedupe by item name, keeping the most-recent row per item (registers are
    // built up incrementally, so the current list spans many dates).
    const byName = new Map();
    for (const r of body) {
      const name = nameIdx >= 0 ? String(r[nameIdx] ?? '').trim() : '';
      if (!name) continue;
      const d = dateIdx >= 0 ? parseDateVal(r[dateIdx]) : null;
      const prev = byName.get(name.toLowerCase());
      if (!prev || (d && (!prev._d || d > prev._d))) byName.set(name.toLowerCase(), { r, _d: d });
    }
    let i = 0;
    const items = [...byName.values()].map(({ r }) => {
      const name = String(r[nameIdx] ?? '').trim();
      const exp = expIdx >= 0 ? parseDateVal(r[expIdx]) : null;
      return {
        key: key(name).slice(0, 28) + '_' + (i++),
        name, category: 'medication',
        par: parIdx >= 0 && r[parIdx] != null && !isNaN(Number(r[parIdx])) ? Number(r[parIdx]) : null,
        qty: qtyIdx >= 0 && r[qtyIdx] != null && !isNaN(Number(r[qtyIdx])) ? Number(r[qtyIdx]) : null,
        lot: lotIdx >= 0 ? (String(r[lotIdx] ?? '').trim() || null) : null,
        expiresAtISO: exp ? exp.toISOString() : null,
        drawer: drawerIdx >= 0 ? (String(r[drawerIdx] ?? '').trim() || null) : null,
        required: false,
      };
    });
    const newest = entries.reduce((m, e) => (e.date && (!m || e.date > m) ? e.date : m), null);
    register = { items, snapshotDate: newest };
  }

  return { title: titleFromFile(file), fields, entries, cadence, headers, register };
}

function evidenceIdFor(obligationId, e) {
  const h = createHash('sha256').update(`${obligationId}|${e.date.toISOString().slice(0, 10)}|${e.submittedBy || ''}`).digest('hex').slice(0, 20);
  return `imp_${h}`;
}

async function importOne(db, file) {
  const a = analyzeWorkbook(file);
  if (!a) { console.log(`  ! ${basename(file)}: no data`); return null; }
  const refs = refsFor(a.title).map((code) => ({ editionId: EDITION, code }));
  const slug = key(a.title);
  const templateId = `tmpl_${slug}`;
  const obligationId = `ob_${slug}`;
  const registerId = `reg_${slug}`;
  const isRegister = !!a.register;

  console.log(`\n• ${a.title}  ${isRegister ? '[REGISTER]' : '[CHECKLIST]'}`);
  if (isRegister) {
    console.log(`  items: ${a.register.items.length} (from ${a.register.snapshotDate ? a.register.snapshotDate.toISOString().slice(0, 10) : 'n/a'}) | refs: ${refs.map((r) => r.code).join(',')}`);
  } else {
    console.log(`  fields: ${a.fields.map((f) => `${f.label}[${f.type}]`).join(', ')}`);
    console.log(`  cadence: ${a.cadence.label} | entries: ${a.entries.length} | refs: ${refs.map((r) => r.code).join(',')}`);
    if (a.cadence.medianDays == null) console.log('  ⚠ cadence unknown — obligation created as PRN (no rrule).');
  }
  if (DRY) return { title: a.title, entries: isRegister ? a.register.items.length : a.entries.length, kind: isRegister ? 'register' : 'checklist' };

  if (isRegister) {
    // Register doc + its recurring check obligation (par/expiry sweep applies).
    const items = a.register.items.map((it) => ({
      key: it.key, name: it.name, category: it.category,
      par: it.par, qty: it.qty, lot: it.lot,
      expiresAt: it.expiresAtISO ? Timestamp.fromDate(new Date(it.expiresAtISO)) : null,
      drawer: it.drawer, required: it.required,
    }));
    await db.doc(`orgs/${ORG}/registers/${registerId}`).set({
      kind: 'inventory', title: a.title, checkpointId: null,
      leadTimeDays: 30, criticalDays: 7, items,
      standardRefs: refs, source: 'xlsx-import',
      lastCheckedAt: a.register.snapshotDate ? Timestamp.fromDate(a.register.snapshotDate) : null,
      lastCheckEvidenceId: null, version: 1, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await db.doc(`orgs/${ORG}/obligations/${obligationId}`).set({
      title: `${a.title} — check`, description: `${a.title} inventory/par & expiration check.`,
      standardRefs: refs, cadence: a.cadence.rrule || 'FREQ=MONTHLY',
      evidenceType: 'register', checklistTemplateId: null, registerId,
      checkpointId: null, requireScan: false, status: 'active', custom: true, source: 'xlsx-import',
      createdBy: 'system', updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`  ✓ register (${items.length} items) + check obligation`);
    return { title: a.title, entries: items.length, kind: 'register' };
  }

  // Template
  const fieldsHash = createHash('sha256').update(JSON.stringify(a.fields)).digest('hex');
  await db.doc(`orgs/${ORG}/checklistTemplates/${templateId}`).set({
    title: a.title, fields: a.fields, standardRefs: refs,
    version: 1, active: true, source: 'xlsx-import',
    createdBy: 'system', updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Obligation (LIVE going forward)
  await db.doc(`orgs/${ORG}/obligations/${obligationId}`).set({
    title: a.title, description: `${a.title} (imported).`,
    standardRefs: refs, cadence: a.cadence.rrule || '',
    evidenceType: 'checklist', checklistTemplateId: templateId,
    registerId: null, checkpointId: null, requireScan: false,
    status: 'active', custom: true, source: 'xlsx-import',
    createdBy: 'system', updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Backfill history as finalized evidence
  let n = 0;
  for (const e of a.entries) {
    const evId = evidenceIdFor(obligationId, e);
    const ts = Timestamp.fromDate(e.date);
    await db.doc(`orgs/${ORG}/evidence/${evId}`).set({
      type: 'checklist',
      title: `${a.title} — ${e.date.toISOString().slice(0, 10)}`,
      standardRefs: refs,
      taskId: null, obligationId,
      payload: {
        templateId, templateVersionHash: fieldsHash, answers: e.answers,
        outOfRange: false,
        importContext: { submittedByText: e.submittedBy || null, submittedAtText: e.submittedAt || null, comments: e.comments || null },
      },
      attachments: [], status: 'finalized',
      finalizedBy: { displayNameSnapshot: e.submittedBy || 'Imported' },
      finalizedAt: ts,
      supersededBy: null, supersedes: null,
      createdBy: { displayNameSnapshot: e.submittedBy || 'Imported' },
      createdAt: ts, imported: true,
    }, { merge: true });
    n++;
  }
  console.log(`  ✓ template + obligation + ${n} historical evidence records`);
  return { title: a.title, entries: n, cadence: a.cadence.label };
}

async function run() {
  const files = readdirSync(FOLDER).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).map((f) => join(FOLDER, f));
  console.log(`${DRY ? '[DRY RUN] ' : ''}Importing ${files.length} log spreadsheet(s) → org=${ORG}`);
  if (files.length === 0) { console.error('No .xlsx files found in', FOLDER); process.exit(1); }

  let db = null;
  if (!DRY) { if (!getApps().length) initializeApp({ credential: applicationDefault() }); db = getFirestore(); }

  const summary = [];
  for (const f of files) { const r = await importOne(db, f); if (r) summary.push(r); }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${DRY ? 'Would import' : 'Imported'} ${summary.length} logs, ${summary.reduce((s, r) => s + r.entries, 0)} total historical entries.`);
  if (!DRY) console.log('Open Logs & Checklists — each log shows its cadence, history, and next due.');
}
run().catch((e) => { console.error(e); process.exit(1); });
