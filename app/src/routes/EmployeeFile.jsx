// src/routes/EmployeeFile.jsx — the unified per-person file.
import { useEffect, useState } from 'react';
import { getStorage, ref as sref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { app } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';

const CRED_TYPES = ['license', 'certification', 'dea', 'boardCert', 'cpr', 'insurance', 'immunization', 'backgroundCheck', 'other'];
const HR_CATS = ['evaluation', 'letter', 'offer', 'discipline', 'acknowledgement', 'competency', 'other'];

function expiryChip(item) {
  if (!item.expiresOn) return <StatusPill kind="idle">no expiry</StatusPill>;
  const ms = item.expiresOn._seconds ? item.expiresOn._seconds * 1000 : new Date(item.expiresOn).getTime();
  const days = Math.floor((ms - Date.now()) / 86400000);
  if (days < 0) return <StatusPill kind="alert">expired</StatusPill>;
  if (days <= 14) return <StatusPill kind="alert">{days}d left</StatusPill>;
  if (days <= 60) return <StatusPill kind="warn">{days}d left</StatusPill>;
  return <StatusPill kind="ok">valid</StatusPill>;
}

export default function EmployeeFile({ uid, onBack }) {
  const { orgId } = useAuth();
  const mkCallable = useCallableFactory();
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');
  const [addCred, setAddCred] = useState(false);
  const [addHr, setAddHr] = useState(false);

  async function load() {
    setErr('');
    try { const r = await mkCallable('employeeFileGet')({ uid }); setFile(r); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { if (orgId && uid) load(); }, [orgId, uid]); // eslint-disable-line

  if (!file) return err ? <div className="err">{err}</div> : <Loader label="Loading file…" />;
  const p = file.profile || {};

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← People</button>
          <h1>{p.displayName || uid}</h1>
          <p>{p.title || '—'} · {p.category || '—'}{p.active === false ? ' · inactive' : ''}</p>
        </div>
      </div>
      {err && <div className="err">{err}</div>}

      {/* Credentials */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head">
          <span>Credentials & Licenses ({file.credentials.length})</span>
          {file.viewerIsHR && <button className="btn ghost sm" onClick={() => setAddCred(true)}>Add credential</button>}
        </div>
        {file.credentials.length === 0 ? <div className="card-pad muted">No credentials on file.</div> : (
          <table>
            <thead><tr><th>Credential</th><th>Type</th><th>Number</th><th>Expires</th><th>Verified</th><th></th></tr></thead>
            <tbody>
              {file.credentials.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.name}
                    {c.issuer && <div className="muted" style={{ fontWeight: 400 }}>{c.issuer}</div>}</td>
                  <td className="muted">{c.type}</td>
                  <td className="muted tnum">{c.number || '—'}</td>
                  <td>{expiryChip(c)}</td>
                  <td>{c.verifiedAt ? <StatusPill kind="ok">verified</StatusPill> : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {c.storagePath && <DownloadBtn storagePath={c.storagePath} />}
                    {file.viewerIsHR && !c.verifiedAt &&
                      <button className="btn ghost sm" style={{ marginLeft: 6 }}
                        onClick={async () => { await mkCallable('credentialVerify')({ uid, itemId: c.id }); load(); }}>Verify</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Training */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head"><span>Training ({file.trainingRecords.length})</span></div>
        {file.trainingRecords.length === 0 ? <div className="card-pad muted">No training records.</div> : (
          <table>
            <thead><tr><th>Course / Requirement</th><th>Status</th><th>Completed</th></tr></thead>
            <tbody>
              {file.trainingRecords.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{t.title || t.requirementId || t.id}</td>
                  <td><StatusPill kind={t.status === 'complete' ? 'ok' : 'warn'}>{t.status || '—'}</StatusPill></td>
                  <td className="muted">{t.completedAt ? 'done' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* HR documents */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head">
          <span>HR Documents ({file.hrDocuments.length}){!file.viewerIsHR && <span className="muted"> · your non-confidential docs</span>}</span>
          {file.viewerIsHR && <button className="btn ghost sm" onClick={() => setAddHr(true)}>Add document</button>}
        </div>
        {file.hrDocuments.length === 0 ? <div className="card-pad muted">No documents.</div> : (
          <table>
            <thead><tr><th>Title</th><th>Category</th><th></th><th></th></tr></thead>
            <tbody>
              {file.hrDocuments.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{d.title}</td>
                  <td className="muted">{d.category}</td>
                  <td>{d.confidential && <StatusPill kind="alert">confidential</StatusPill>}</td>
                  <td style={{ textAlign: 'right' }}>{d.storagePath && <DownloadBtn storagePath={d.storagePath} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addCred && <CredentialModal uid={uid} mkCallable={mkCallable} orgId={orgId}
        onClose={() => setAddCred(false)} onDone={() => { setAddCred(false); load(); }} onErr={setErr} />}
      {addHr && <HrDocModal uid={uid} mkCallable={mkCallable} orgId={orgId}
        onClose={() => setAddHr(false)} onDone={() => { setAddHr(false); load(); }} onErr={setErr} />}
    </>
  );
}

function DownloadBtn({ storagePath }) {
  async function open() {
    try { const u = await getDownloadURL(sref(getStorage(app), storagePath)); window.open(u, '_blank'); }
    catch (e) { /* ignore */ }
  }
  return <button className="btn ghost sm" onClick={open}>Open</button>;
}

function CredentialModal({ uid, mkCallable, orgId, onClose, onDone, onErr }) {
  const [f, setF] = useState({ type: 'license', name: '', number: '', issuer: '', issuedOn: '', expiresOn: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function save() {
    if (!f.name) return;
    setBusy(true); onErr('');
    try {
      let storagePath = null;
      if (file) {
        const id = `c_${Date.now()}`;
        storagePath = `orgs/${orgId}/personnel/${uid}/hr/${id}/${file.name}`;
        await new Promise((res, rej) => {
          const t = uploadBytesResumable(sref(getStorage(app), storagePath), file, { contentType: file.type });
          t.on('state_changed', null, rej, res);
        });
      }
      await mkCallable('credentialUpsertItem')({ uid, ...f, storagePath });
      onDone();
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="Add credential" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !f.name}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <label className="field"><span>Type</span>
        <select value={f.type} onChange={set('type')}>{CRED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} placeholder="State Medical License" autoFocus /></label>
      <div className="grid2">
        <label className="field"><span>Number</span><input value={f.number} onChange={set('number')} /></label>
        <label className="field"><span>Issuer</span><input value={f.issuer} onChange={set('issuer')} /></label>
      </div>
      <div className="grid2">
        <label className="field"><span>Issued</span><input type="date" value={f.issuedOn} onChange={set('issuedOn')} /></label>
        <label className="field"><span>Expires</span><input type="date" value={f.expiresOn} onChange={set('expiresOn')} /></label>
      </div>
      <label className="field"><span>Scan (optional)</span><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
    </Modal>
  );
}

function HrDocModal({ uid, mkCallable, orgId, onClose, onDone, onErr }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('evaluation');
  const [confidential, setConfidential] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!file || !title) return;
    setBusy(true); onErr('');
    try {
      const id = `h_${Date.now()}`;
      const storagePath = `orgs/${orgId}/personnel/${uid}/hr/${id}/${file.name}`;
      await new Promise((res, rej) => {
        const t = uploadBytesResumable(sref(getStorage(app), storagePath), file, { contentType: file.type });
        t.on('state_changed', null, rej, res);
      });
      await mkCallable('hrDocRegister')({ uid, title, category, storagePath, contentType: file.type, size: file.size, confidential });
      onDone();
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="Add HR document" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !file || !title}>{busy ? 'Uploading…' : 'Save'}</button></>}>
      <label className="field"><span>File</span><input type="file" onChange={(e) => { const x = e.target.files?.[0]; setFile(x); if (x && !title) setTitle(x.name); }} /></label>
      <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>{HR_CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      <label className="row" style={{ marginTop: 6 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
        <span className="muted">Confidential — HR only, not visible to the employee</span></label>
    </Modal>
  );
}
