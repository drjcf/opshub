// src/components/LogEditor.jsx — edit an existing log's fields, checkpoint,
// cadence, and scan-gating. Works on seeded catalog logs AND custom ones.
// Editing fields bumps the template version (past completions stay valid
// against the version they were logged under).
import { useState, useEffect } from 'react';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { Modal } from './ui.jsx';

const TYPES = [
  { v: 'number', label: 'Number (with optional range)' },
  { v: 'bool', label: 'Yes / No' },
  { v: 'select', label: 'Dropdown' },
  { v: 'text', label: 'Text' },
];
const FREQS = [
  { v: 'DAILY', label: 'Daily' }, { v: 'WEEKLY', label: 'Weekly' },
  { v: 'MONTHLY', label: 'Monthly' }, { v: 'ADHOC', label: 'Ad hoc (no schedule)' },
];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

let efid = 0;
// Convert a stored field back to editor form (range/options → flat inputs).
function toFormField(f) {
  return {
    _id: ++efid, key: f.key || '', label: f.label || '', type: f.type || 'bool',
    required: !!f.required, unit: f.unit || '',
    min: f.range?.min != null ? f.range.min : '', max: f.range?.max != null ? f.range.max : '',
    options: (f.options || []).join(', '),
  };
}
const blankField = () => ({ _id: ++efid, key: '', label: '', type: 'bool', required: true, unit: '', min: '', max: '', options: '' });

// Parse an existing RRULE back into structured cadence for the form.
function parseCadence(rrule) {
  if (!rrule) return { freq: 'ADHOC', hour: 7, byday: ['MO'], bymonthday: 1 };
  const freq = (rrule.match(/FREQ=(\w+)/) || [])[1] || 'DAILY';
  const hour = Number((rrule.match(/BYHOUR=(\d+)/) || [])[1] ?? 7);
  const byday = ((rrule.match(/BYDAY=([\w,]+)/) || [])[1] || 'MO').split(',');
  const bymonthday = Number((rrule.match(/BYMONTHDAY=(\d+)/) || [])[1] ?? 1);
  return { freq, hour, byday, bymonthday };
}

export default function LogEditor({ row, mkCallable, orgId, onClose, onDone, onErr }) {
  const c0 = parseCadence(row.cadence);
  const [freq, setFreq] = useState(c0.freq);
  const [hour, setHour] = useState(c0.hour);
  const [byday, setByday] = useState(c0.byday);
  const [bymonthday, setBymonthday] = useState(c0.bymonthday);
  const [requireScan, setRequireScan] = useState(!!row.requireScan);
  const [checkpointId, setCheckpointId] = useState(row.checkpointId || '');
  const [checkpoints, setCheckpoints] = useState([]);
  const [fields, setFields] = useState(null); // null=loading, [] once loaded
  const [busy, setBusy] = useState(false);

  const isChecklist = row.evidenceType === 'checklist' && row.templateId;

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    getDocs(collection(dbc, `orgs/${orgId}/checkpoints`))
      .then((snap) => { if (alive) setCheckpoints(snap.docs.map((d) => ({ id: d.id, label: d.get('label'), location: d.get('location') }))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [orgId]);

  // Load current template fields for editing.
  useEffect(() => {
    if (!orgId || !isChecklist) { setFields([]); return; }
    let alive = true;
    getDoc(doc(dbc, `orgs/${orgId}/checklistTemplates/${row.templateId}`))
      .then((snap) => { if (alive) setFields((snap.exists() ? (snap.get('fields') || []) : []).map(toFormField)); })
      .catch(() => { if (alive) setFields([]); });
    return () => { alive = false; };
  }, [orgId, row.templateId]);

  function updField(id, patch) { setFields((fs) => fs.map((f) => f._id === id ? { ...f, ...patch } : f)); }
  function moveField(id, dir) {
    setFields((fs) => {
      const i = fs.findIndex((f) => f._id === id); const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const c = [...fs]; [c[i], c[j]] = [c[j], c[i]]; return c;
    });
  }

  async function save() {
    setBusy(true); onErr('');
    try {
      const payload = {
        obligationId: row.obligationId,
        cadence: { freq, hour: Number(hour), byday, bymonthday: Number(bymonthday) },
        requireScan,
        checkpointId: requireScan ? (checkpointId || null) : null,
      };
      // Include field edits only for checklist logs with a template.
      if (isChecklist && Array.isArray(fields)) {
        payload.templateId = row.templateId;
        payload.fields = fields.map((f) => ({
          key: f.key || f.label, label: f.label, type: f.type, required: f.required,
          unit: f.unit || undefined,
          min: f.type === 'number' && f.min !== '' ? Number(f.min) : undefined,
          max: f.type === 'number' && f.max !== '' ? Number(f.max) : undefined,
          options: f.type === 'select' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
        }));
      }
      await mkCallable('logTemplateUpdate')(payload);
      onDone();
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title={`Edit — ${row.title}`} onClose={onClose} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </>}>
      {isChecklist && (
        <div className="builder-section" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
          <div className="builder-head"><span>Fields</span>
            {Array.isArray(fields) && <button className="btn ghost sm" onClick={() => setFields((f) => [...f, blankField()])}>+ Add field</button>}</div>
          {fields === null ? <div className="muted">Loading fields…</div> : fields.map((f, idx) => (
            <div key={f._id} className="field-row">
              <div className="field-row-top">
                <input className="fr-label" value={f.label} placeholder="Field label"
                  onChange={(e) => updField(f._id, { label: e.target.value })} />
                <select value={f.type} onChange={(e) => updField(f._id, { type: e.target.value })}>
                  {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
                <label className="fr-req"><input type="checkbox" checked={f.required}
                  onChange={(e) => updField(f._id, { required: e.target.checked })} /> req</label>
                <button className="btn ghost sm" onClick={() => moveField(f._id, -1)} disabled={idx === 0}>↑</button>
                <button className="btn ghost sm" onClick={() => moveField(f._id, 1)} disabled={idx === fields.length - 1}>↓</button>
                <button className="btn ghost sm" onClick={() => setFields((fs) => fs.filter((x) => x._id !== f._id))}>✕</button>
              </div>
              {f.type === 'number' && (
                <div className="fr-extra">
                  <input placeholder="unit" value={f.unit} onChange={(e) => updField(f._id, { unit: e.target.value })} />
                  <input placeholder="min" type="number" value={f.min} onChange={(e) => updField(f._id, { min: e.target.value })} />
                  <input placeholder="max" type="number" value={f.max} onChange={(e) => updField(f._id, { max: e.target.value })} />
                </div>
              )}
              {f.type === 'select' && (
                <div className="fr-extra">
                  <input placeholder="options, comma-separated" value={f.options} style={{ flex: 1 }}
                    onChange={(e) => updField(f._id, { options: e.target.value })} />
                </div>
              )}
            </div>
          ))}
          <div className="muted" style={{ fontSize: 12 }}>Editing fields creates a new template version. Past completions stay valid against the version they were logged under.</div>
        </div>
      )}

      <div className="builder-section" style={isChecklist ? {} : { marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
        <div className="builder-head"><span>Schedule</span></div>
        <div className="grid2">
          <label className="field"><span>Frequency</span>
            <select value={freq} onChange={(e) => setFreq(e.target.value)}>
              {FREQS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select></label>
          {freq !== 'ADHOC' && <label className="field"><span>Hour (0–23)</span>
            <input type="number" min="0" max="23" value={hour} onChange={(e) => setHour(e.target.value)} /></label>}
        </div>
        {freq === 'WEEKLY' && (
          <div className="day-picker">
            {DAYS.map((d) => (
              <button key={d} className={`rating-opt ${byday.includes(d) ? 'sel' : ''}`}
                onClick={() => setByday((b) => b.includes(d) ? b.filter((x) => x !== d) : [...b, d])}>{d}</button>
            ))}
          </div>
        )}
        {freq === 'MONTHLY' && <label className="field"><span>Day of month</span>
          <input type="number" min="1" max="28" value={bymonthday} onChange={(e) => setBymonthday(e.target.value)} /></label>}
      </div>

      <div className="builder-section">
        <div className="builder-head"><span>QR checkpoint</span></div>
        <label className="row">
          <input type="checkbox" style={{ width: 'auto' }} checked={requireScan}
            onChange={(e) => setRequireScan(e.target.checked)} />
          <span className="muted">Require QR scan at a checkpoint to complete</span></label>
        {requireScan && (
          <label className="field" style={{ marginTop: 8 }}>
            <span>Checkpoint (QR location)</span>
            {checkpoints.length === 0
              ? <div className="muted" style={{ fontSize: 13 }}>No checkpoints yet — create one in Checkpoints and print its QR label first.</div>
              : <select value={checkpointId} onChange={(e) => setCheckpointId(e.target.value)}>
                  <option value="">Select a checkpoint…</option>
                  {checkpoints.map((cp) => <option key={cp.id} value={cp.id}>{cp.label}{cp.location ? ` · ${cp.location}` : ''}</option>)}
                </select>}
          </label>
        )}
        {row.checkpointId && !requireScan &&
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Unchecking will remove this log's checkpoint assignment.</div>}
      </div>
    </Modal>
  );
}
