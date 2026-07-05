// src/routes/Checkpoints.jsx — mint scan points, rotate tokens.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Modal, Loader, Empty, StatusPill } from '../components/ui.jsx';

export default function Checkpoints() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [items, setItems] = useState(null);
  const [registers, setRegisters] = useState([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const unsub = onSnapshot(
      query(collection(dbc, `orgs/${orgId}/checkpoints`), orderBy('createdAt', 'desc')),
      (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setErr(e.message)
    );
    const unsub2 = onSnapshot(collection(dbc, `orgs/${orgId}/registers`),
      (snap) => setRegisters(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => { unsub(); unsub2(); };
  }, [orgId]);

  async function rotate(id) {
    setErr('');
    try { await mkCallable('checkpointRotateToken')({ checkpointId: id }); }
    catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Checkpoints</h1><p>Physical scan points — a fridge, a sink, a crash cart, an extinguisher.</p></div>
        {isAdmin && <button className="btn" onClick={() => setOpen(true)}>New checkpoint</button>}
      </div>
      {err && <div className="err">{err}</div>}

      <div className="card">
        {items === null ? <Loader /> : items.length === 0 ? (
          <Empty title="No checkpoints yet">Create one, then print its QR label and place it at the location.</Empty>
        ) : (
          <table>
            <thead><tr><th>Label</th><th>Location</th><th>Register</th><th>Ad-hoc</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.label}</td>
                  <td className="muted">{c.location || '—'}</td>
                  <td className="muted">{registers.find((r) => r.checkpointId === c.id)?.title
                    || (c.assetId ? c.assetId : '—')}</td>
                  <td>{c.allowAdhocLog ? <StatusPill kind="ok">enabled</StatusPill> : <span className="muted">—</span>}</td>
                  <td>{c.active ? <StatusPill kind="ok">active</StatusPill> : <StatusPill kind="idle">retired</StatusPill>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {isAdmin && <button className="btn ghost sm" onClick={() => rotate(c.id)}
                      title="Invalidate current label and issue a new token">Rotate token</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && <NewCheckpoint registers={registers} mkCallable={mkCallable}
        onClose={() => setOpen(false)} onErr={setErr} />}
    </>
  );
}

function NewCheckpoint({ registers, mkCallable, onClose, onErr }) {
  const [label, setLabel] = useState('');
  const [location, setLocation] = useState('');
  const [allowAdhoc, setAllowAdhoc] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!label.trim()) return;
    setBusy(true); onErr('');
    try {
      await mkCallable('checkpointMint')({
        label: label.trim(), location: location.trim(), allowAdhocLog: allowAdhoc,
      });
      onClose();
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="New checkpoint" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={create} disabled={busy || !label.trim()}>
          {busy ? 'Creating…' : 'Create checkpoint'}</button>
      </>}>
      <label className="field"><span>Label</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder="Med Fridge #1" autoFocus /></label>
      <label className="field"><span>Location</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)}
          placeholder="Clean utility, Suite 1011" /></label>
      <label className="row" style={{ marginTop: 4 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={allowAdhoc}
          onChange={(e) => setAllowAdhoc(e.target.checked)} />
        <span className="muted">Allow ad-hoc logging (readings without an open task due)</span>
      </label>
      <p className="muted" style={{ marginTop: 14 }}>
        A token is generated on creation. Print its label from the Print labels page.
        The token addresses the location only — logging still requires a signed-in staff session.
      </p>
    </Modal>
  );
}
