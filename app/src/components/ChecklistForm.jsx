// src/components/ChecklistForm.jsx — generic template-driven checklist
// (temperature logs, cleaning logs, etc). Submits to taskCompleteFromScan.
import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { fns } from '../lib/firebase.js';

export default function ChecklistForm({ orgId, token, task, template, onDone }) {
  const [answers, setAnswers] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  function set(key, value) { setAnswers((a) => ({ ...a, [key]: value })); }

  const missingRequired = (template.fields || []).some(
    (f) => f.required && (answers[f.key] === undefined || answers[f.key] === '')
  );

  async function submit() {
    setBusy(true); setErr('');
    try {
      const fn = httpsCallable(fns, 'taskCompleteFromScan');
      const res = await fn({ orgId, token, taskId: task.id, answers, clientAt: Date.now() });
      onDone(res.data);
    } catch (e) {
      setErr(e?.message || 'Submit failed.');
      setBusy(false);
    }
  }

  return (
    <div className="check-form">
      <p className="scan-lead">{template.title}</p>
      {err && <div className="err">{err}</div>}

      {(template.fields || []).map((f) => (
        <label className="field" key={f.key}>
          <span>{f.label}{f.required && ' *'}{f.unit ? ` (${f.unit})` : ''}</span>
          {f.type === 'number' && (
            <input type="number" inputMode="decimal" value={answers[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))} />
          )}
          {f.type === 'text' && (
            <input value={answers[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
          )}
          {f.type === 'bool' && (
            <select value={answers[f.key] === undefined ? '' : String(answers[f.key])}
              onChange={(e) => set(f.key, e.target.value === '' ? '' : e.target.value === 'true')}>
              <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          )}
          {f.type === 'select' && (
            <select value={answers[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">—</option>
              {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {f.range && <span className="range-hint">expected {f.range.min}–{f.range.max}{f.unit || ''}</span>}
        </label>
      ))}

      <button className="btn scan-btn" onClick={submit} disabled={busy || missingRequired}>
        {busy ? 'Recording…' : 'Submit log'}</button>
    </div>
  );
}
