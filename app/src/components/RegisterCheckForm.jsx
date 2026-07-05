// src/components/RegisterCheckForm.jsx — crash cart / par-list verification.
// Loads the register, renders each item with a verdict control, forces an
// explicit verdict on expired/expiring items, submits to registerCheckSubmit.
import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { dbc, fns } from '../lib/firebase.js';

const DAY = 86400000;

function itemFlag(item, leadDays = 30) {
  if (!item.expiresAt) return null;
  const ms = item.expiresAt._seconds ? item.expiresAt._seconds * 1000
    : item.expiresAt.toMillis ? item.expiresAt.toMillis() : new Date(item.expiresAt).getTime();
  const delta = ms - Date.now();
  if (delta <= 0) return 'expired';
  if (delta <= leadDays * DAY) return 'expiring';
  return null;
}
function expMs(item) {
  if (!item.expiresAt) return null;
  return item.expiresAt._seconds ? item.expiresAt._seconds * 1000
    : item.expiresAt.toMillis ? item.expiresAt.toMillis() : new Date(item.expiresAt).getTime();
}
const fmt = (ms) => ms ? new Date(ms).toISOString().slice(0, 10) : '—';

export default function RegisterCheckForm({ orgId, token, task, onDone }) {
  const [register, setRegister] = useState(null);
  const [verdicts, setVerdicts] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const snap = await getDoc(doc(dbc, `orgs/${orgId}/registers/${task.registerId}`));
      if (snap.exists()) setRegister({ id: snap.id, ...snap.data() });
      else setErr('Register not found.');
    })();
  }, [orgId, task.registerId]);

  if (err && !register) return <div className="err">{err}</div>;
  if (!register) return <p className="scan-lead">Loading register…</p>;

  const lead = register.leadTimeDays ?? 30;
  const flagged = (register.items || []).filter((it) => itemFlag(it, lead));
  const allFlaggedResolved = flagged.every((it) => verdicts[it.key]?.verdict);

  function setVerdict(key, patch) {
    setVerdicts((v) => ({ ...v, [key]: { ...v[key], ...patch } }));
  }

  async function submit() {
    setBusy(true); setErr('');
    try {
      const fn = httpsCallable(fns, 'registerCheckSubmit');
      const res = await fn({
        orgId, token, taskId: task.id,
        registerVersionBefore: register.version,
        verdicts,
        clientAt: Date.now(),
      });
      onDone(res.data);
    } catch (e) {
      setErr(e?.message || 'Submit failed.');
      setBusy(false);
    }
  }

  return (
    <div className="check-form">
      <p className="scan-lead">Verify the cart. Confirm each item is present and in date.</p>
      {err && <div className="err">{err}</div>}

      <div className="item-list">
        {(register.items || []).map((it) => {
          const flag = itemFlag(it, lead);
          const v = verdicts[it.key] || {};
          return (
            <div key={it.key} className={`item ${flag ? 'item-flag-' + flag : ''}`}>
              <div className="item-head">
                <div>
                  <div className="item-name">{it.name}{it.required && <span className="req"> ·req</span>}</div>
                  <div className="item-meta">
                    {it.lot ? `Lot ${it.lot} · ` : ''}exp {fmt(expMs(it))}
                    {flag === 'expired' && <span className="tag tag-alert">EXPIRED</span>}
                    {flag === 'expiring' && <span className="tag tag-warn">expiring</span>}
                  </div>
                </div>
              </div>
              {flag ? (
                <div className="verdict-row">
                  <select value={v.verdict || ''} onChange={(e) => setVerdict(it.key, { verdict: e.target.value })}>
                    <option value="">— choose —</option>
                    <option value="present">Present (as-is)</option>
                    <option value="replaced">Replaced it</option>
                    <option value="missing">Missing</option>
                  </select>
                  {v.verdict === 'replaced' && (
                    <div className="replace-fields">
                      <input placeholder="New lot" value={v.newLot || ''}
                        onChange={(e) => setVerdict(it.key, { newLot: e.target.value })} />
                      <input type="date" value={v.newExpiresAtStr || ''}
                        onChange={(e) => setVerdict(it.key, {
                          newExpiresAtStr: e.target.value,
                          newExpiresAt: e.target.value ? new Date(e.target.value).getTime() : null,
                        })} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="item-ok">✓ in date</div>
              )}
            </div>
          );
        })}
      </div>

      {flagged.length > 0 && !allFlaggedResolved && (
        <p className="muted">Resolve each flagged item to submit.</p>
      )}
      <button className="btn scan-btn" onClick={submit}
        disabled={busy || (flagged.length > 0 && !allFlaggedResolved)}>
        {busy ? 'Recording…' : 'Complete check'}</button>
    </div>
  );
}
