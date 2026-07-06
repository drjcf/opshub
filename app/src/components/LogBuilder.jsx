// src/components/LogBuilder.jsx — author a custom log/checklist.
import { useState } from 'react';
import { Modal, StatusPill } from './ui.jsx';

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

let fid = 0;
const newField = () => ({ _id: ++fid, key: '', label: '', type: 'bool', required: true, unit: '', min: '', max: '', options: '' });

export default function LogBuilder({ mkCallable, editions, onClose, onDone, onErr }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState([newField()]);
  const [freq, setFreq] = useState('DAILY');
  const [hour, setHour] = useState(7);
  const [byday, setByday] = useState(['MO']);
  const [bymonthday, setBymonthday] = useState(1);
  const [requireScan, setRequireScan] = useState(false);
  const [refCode, setRefCode] = useState('');
  const [refs, setRefs] = useState([]);
  const [busy, setBusy] = useState(false);

  function updField(id, patch) { setFields((fs) => fs.map((f) => f._id === id ? { ...f, ...patch } : f)); }
  function move(id, dir) {
    setFields((fs) => {
      const i = fs.findIndex((f) => f._id === id); const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const c = [...fs]; [c[i], c[j]] = [c[j], c[i]]; return c;
    });
  }

  async function save() {
    if (!title.trim()) return;
    setBusy(true); onErr('');
    try {
      const payload = {
        title: title.trim(), description,
        fields: fields.map((f) => ({
          key: f.key || f.label, label: f.label, type: f.type, required: f.required,
          unit: f.unit || undefined,
          min: f.type === 'number' && f.min !== '' ? Number(f.min) : undefined,
          max: f.type === 'number' && f.max !== '' ? Number(f.max) : undefined,
          options: f.type === 'select' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
        })),
        cadence: { freq, hour: Number(hour), byday, bymonthday: Number(bymonthday) },
        standardRefs: refs,
        requireScan,
      };
      const r = await mkCallable('logTemplateCreate')(payload);
      onDone(r);
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="New log / checklist" onClose={onClose} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create log'}</button>
      </>}>
      <label className="field"><span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Laser Safety Check" autoFocus /></label>
      <label className="field"><span>Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>

      <div className="builder-section">
        <div className="builder-head"><span>Fields</span>
          <button className="btn ghost sm" onClick={() => setFields((f) => [...f, newField()])}>+ Add field</button></div>
        {fields.map((f, idx) => (
          <div key={f._id} className="field-row">
            <div className="field-row-top">
              <input className="fr-label" value={f.label} placeholder="Field label"
                onChange={(e) => updField(f._id, { label: e.target.value })} />
              <select value={f.type} onChange={(e) => updField(f._id, { type: e.target.value })}>
                {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
              <label className="fr-req"><input type="checkbox" checked={f.required}
                onChange={(e) => updField(f._id, { required: e.target.checked })} /> req</label>
              <button className="btn ghost sm" onClick={() => move(f._id, -1)} disabled={idx === 0}>↑</button>
              <button className="btn ghost sm" onClick={() => move(f._id, 1)} disabled={idx === fields.length - 1}>↓</button>
              <button className="btn ghost sm" onClick={() => setFields((fs) => fs.filter((x) => x._id !== f._id))}>✕</button>
            </div>
            {f.type === 'number' && (
              <div className="fr-extra">
                <input placeholder="unit (°C, %, min)" value={f.unit} onChange={(e) => updField(f._id, { unit: e.target.value })} />
                <input placeholder="min" type="number" value={f.min} onChange={(e) => updField(f._id, { min: e.target.value })} />
                <input placeholder="max" type="number" value={f.max} onChange={(e) => updField(f._id, { max: e.target.value })} />
              </div>
            )}
            {f.type === 'select' && (
              <div className="fr-extra">
                <input placeholder="options, comma-separated (Pass, Fail, N/A)" value={f.options}
                  onChange={(e) => updField(f._id, { options: e.target.value })} style={{ flex: 1 }} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="builder-section">
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
        <div className="builder-head"><span>Standards & options</span></div>
        <div className="row" style={{ gap: 8 }}>
          <input placeholder="Pin standard code (e.g. ASG.160)" value={refCode}
            onChange={(e) => setRefCode(e.target.value)} style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => {
            if (!refCode.trim()) return;
            const ed = editions?.[0] || 'aaahc-2026';
            setRefs((r) => [...r, { editionId: ed, code: refCode.trim() }]); setRefCode('');
          }}>Add</button>
        </div>
        {refs.length > 0 && <div style={{ marginTop: 8 }}>
          {refs.map((r, i) => <span key={i} className="pill st-idle" style={{ marginRight: 4 }}
            onClick={() => setRefs((x) => x.filter((_, j) => j !== i))} title="click to remove">{r.code} ✕</span>)}</div>}
        <label className="row" style={{ marginTop: 10 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={requireScan}
            onChange={(e) => setRequireScan(e.target.checked)} />
          <span className="muted">Require QR scan at a checkpoint to complete (walk-and-scan)</span></label>
      </div>
    </Modal>
  );
}
