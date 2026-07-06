// functions/src/log-templates.js — author custom logs & checklists.
// Validates field definitions server-side, then writes the checklistTemplate
// AND its recurring obligation atomically. Callable-mediated so licensees get
// consistent, validated logs rather than raw client writes.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, requireAuth, requireOrg, requireRole, actor, auditDirect,
} from './util.js';

const FIELD_TYPES = ['number', 'bool', 'text', 'select'];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'ADHOC'];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Validate + normalize a field definition. Throws on invalid.
function normField(f, i) {
  if (!f || typeof f !== 'object') throw new HttpsError('invalid-argument', `Field ${i} malformed.`);
  const key = String(f.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  const label = String(f.label || '').trim().slice(0, 120);
  if (!key || !label) throw new HttpsError('invalid-argument', `Field ${i}: key and label required.`);
  if (!FIELD_TYPES.includes(f.type)) throw new HttpsError('invalid-argument', `Field ${i}: bad type.`);
  const out = { key, label, type: f.type, required: !!f.required };
  if (f.unit) out.unit = String(f.unit).slice(0, 16);
  if (f.type === 'number' && (f.min != null || f.max != null)) {
    const min = f.min != null ? Number(f.min) : null;
    const max = f.max != null ? Number(f.max) : null;
    if (min != null && max != null && min > max) throw new HttpsError('invalid-argument', `Field ${i}: min > max.`);
    out.range = { min, max };
  }
  if (f.type === 'select') {
    const opts = (f.options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 30);
    if (opts.length < 2) throw new HttpsError('invalid-argument', `Field ${i}: select needs 2+ options.`);
    out.options = opts;
  }
  return out;
}

// Build an RRULE from structured cadence input.
function buildCadence(c) {
  if (!c || c.freq === 'ADHOC') return null;
  if (!FREQS.includes(c.freq)) throw new HttpsError('invalid-argument', 'Bad cadence frequency.');
  const parts = [`FREQ=${c.freq}`];
  const hour = Number.isInteger(c.hour) ? c.hour : 7;
  parts.push(`BYHOUR=${hour}`, 'BYMINUTE=0');
  if (c.freq === 'WEEKLY' && c.byday) {
    const days = (Array.isArray(c.byday) ? c.byday : [c.byday]).filter((d) => DAYS.includes(d));
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
  }
  if (c.freq === 'MONTHLY' && c.bymonthday) parts.push(`BYMONTHDAY=${Number(c.bymonthday)}`);
  return parts.join(';');
}

// ---------------- logTemplate.create ----------------
export const logTemplateCreate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, title, description, fields, cadence, standardRefs, checkpointId, requireScan, isRegister, registerId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!title || String(title).trim().length < 2) throw new HttpsError('invalid-argument', 'Title required.');
  const who = actor(auth);

  const rrule = buildCadence(cadence);
  const refs = (standardRefs || [])
    .map((r) => (typeof r === 'string' ? { editionId: r.split('|')[0], code: r.split('|')[1] } : r))
    .filter((r) => r && r.code);

  // slug id from title (deterministic-ish, collision-safe with suffix)
  const slug = String(title).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  const uid = `${slug}_${Date.now().toString(36)}`;
  const templateId = `tmpl_${uid}`;
  const obligationId = `ob_${uid}`;

  const batch = db.batch();

  if (!isRegister) {
    const normFields = (fields || []).map(normField);
    if (normFields.length === 0) throw new HttpsError('invalid-argument', 'Add at least one field.');
    batch.set(db.doc(`orgs/${orgId}/checklistTemplates/${templateId}`), {
      title: String(title).trim(),
      fields: normFields,
      standardRefs: refs,
      version: 1, active: true,
      createdBy: who, updatedAt: FieldValue.serverTimestamp(),
    });
  }

  batch.set(db.doc(`orgs/${orgId}/obligations/${obligationId}`), {
    title: String(title).trim(),
    description: description ? String(description).slice(0, 500) : `${title}.`,
    standardRefs: refs,
    cadence: rrule,
    evidenceType: isRegister ? 'register' : 'checklist',
    checklistTemplateId: isRegister ? null : templateId,
    registerId: isRegister ? (registerId || null) : null,
    checkpointId: checkpointId || null,
    requireScan: !!requireScan,
    status: 'active',
    custom: true,
    createdBy: who, updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  await auditDirect(orgId, 'logTemplate.create', `orgs/${orgId}/obligations/${obligationId}`, null,
    { title, cadence: rrule, fields: (fields || []).length }, who);
  return { templateId: isRegister ? null : templateId, obligationId, cadence: rrule };
});

// ---------------- logTemplate.update ----------------
// Edits create a NEW template version (evidence references a version hash, so
// old completions stay valid against the version they were logged under).
export const logTemplateUpdate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, templateId, obligationId, title, description, fields, cadence, standardRefs, checkpointId, requireScan } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  const rrule = buildCadence(cadence);
  const refs = (standardRefs || []).filter((r) => r && r.code);

  const batch = db.batch();
  if (templateId && fields) {
    const normFields = fields.map(normField);
    const tRef = db.doc(`orgs/${orgId}/checklistTemplates/${templateId}`);
    const cur = await tRef.get();
    batch.set(tRef, {
      title: title ? String(title).trim() : cur.get('title'),
      fields: normFields,
      standardRefs: refs.length ? refs : (cur.get('standardRefs') || []),
      version: (cur.get('version') || 1) + 1,
      updatedBy: who, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  if (obligationId) {
    const oRef = db.doc(`orgs/${orgId}/obligations/${obligationId}`);
    const patch = { updatedBy: who, updatedAt: FieldValue.serverTimestamp() };
    if (title) patch.title = String(title).trim();
    if (description != null) patch.description = String(description).slice(0, 500);
    if (cadence) patch.cadence = rrule;
    if (refs.length) patch.standardRefs = refs;
    if (checkpointId !== undefined) patch.checkpointId = checkpointId || null;
    if (requireScan !== undefined) patch.requireScan = !!requireScan;
    batch.set(oRef, patch, { merge: true });
  }
  await batch.commit();
  await auditDirect(orgId, 'logTemplate.update', `orgs/${orgId}/obligations/${obligationId || templateId}`, null, { title }, who);
  return { ok: true };
});

// ---------------- logTemplate.retire ----------------
// Sets obligation status inactive (stops new task generation). History stays.
export const logTemplateRetire = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, obligationId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/obligations/${obligationId}`).set({ status: 'retired' }, { merge: true });
  await auditDirect(orgId, 'logTemplate.retire', `orgs/${orgId}/obligations/${obligationId}`, null, {}, who);
  return { ok: true };
});
