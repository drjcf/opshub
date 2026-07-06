// src/routes/Members.jsx — staff roster + provisioning.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Modal, Loader, Empty, StatusPill } from '../components/ui.jsx';
import EmployeeFile from './EmployeeFile.jsx';

const ROLE_LABELS = {
  owner: 'Owner', admin: 'Admin', clinicalDirector: 'Clinical Director', staff: 'Staff',
};
const ROLE_ORDER = ['owner', 'admin', 'clinicalDirector', 'staff'];

export default function Members() {
  const { orgId, isAdmin, roles: myRoles, user } = useAuth();
  const mkCallable = useCallableFactory();
  const [members, setMembers] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [err, setErr] = useState('');
  const [banner, setBanner] = useState(null);
  const isOwner = myRoles.includes('owner');

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(
      query(collection(dbc, `orgs/${orgId}/members`), orderBy('createdAt', 'desc')),
      (snap) => setMembers(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setErr(e.message)
    );
  }, [orgId]);

  async function deactivate(uid) {
    setErr('');
    try { await mkCallable('memberDeactivate')({ uid }); }
    catch (e) { setErr(e.message); }
  }

  if (viewing) return <EmployeeFile uid={viewing} onBack={() => setViewing(null)} />;

  return (
    <>
      <div className="page-head">
        <div><h1>People</h1><p>Staff accounts and their roles. Adding a person provisions their sign-in and training.</p></div>
        {isAdmin && <button className="btn" onClick={() => setShowAdd(true)}>Add person</button>}
      </div>
      {err && <div className="err">{err}</div>}
      {banner && <div className="card card-pad" style={{ marginBottom: 16, background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>
        <strong style={{ color: 'var(--ok)' }}>{banner.title}</strong>
        {banner.tempPassword && <div style={{ marginTop: 8 }}>
          Temp password: <code style={{ background: '#fff', padding: '2px 8px', borderRadius: 6, fontFamily: 'var(--mono)' }}>{banner.tempPassword}</code>
          <div className="muted" style={{ marginTop: 4 }}>Share securely. They change it on first sign-in.</div>
        </div>}
        {banner.resetLink && <div style={{ marginTop: 8 }}><a href={banner.resetLink}>Password reset link</a></div>}
        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setBanner(null)}>Dismiss</button>
      </div>}

      <div className="card">
        {members === null ? <Loader /> : members.length === 0 ? (
          <Empty title="No people yet">Add your first staff member to give them sign-in and assign training.</Empty>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>
                    <button className="linklike" onClick={() => setViewing(m.id)}>{m.displayName}</button>{m.id === user.uid && <span className="muted"> · you</span>}
                    {m.title && <div className="muted" style={{ fontWeight: 400 }}>{m.title}</div>}
                  </td>
                  <td className="muted">{m.email}</td>
                  <td>{[...(m.roles || [])].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
                    .map((r) => <span key={r} className="pill st-idle" style={{ marginRight: 4 }}>{ROLE_LABELS[r] || r}</span>)}</td>
                  <td>{m.active !== false ? <StatusPill kind="ok">active</StatusPill> : <StatusPill kind="idle">inactive</StatusPill>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {isAdmin && m.active !== false && (
                      <>
                        <button className="btn ghost sm" onClick={() => setEditing(m)}>Roles</button>
                        {m.id !== user.uid &&
                          <button className="btn ghost sm" style={{ marginLeft: 6 }}
                            onClick={() => deactivate(m.id)}>Deactivate</button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && <AddMember isOwner={isOwner} mkCallable={mkCallable}
        onClose={() => setShowAdd(false)} onErr={setErr} onDone={(r) => {
          setShowAdd(false);
          setBanner({ title: `${r.note}`, tempPassword: r.tempPassword, resetLink: r.resetLink });
        }} />}
      {editing && <EditRoles member={editing} isOwner={isOwner} mkCallable={mkCallable}
        onClose={() => setEditing(null)} onErr={setErr} />}
    </>
  );
}

function RoleChecks({ value, onChange, isOwner }) {
  function toggle(r) {
    onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '6px 0 14px' }}>
      {ROLE_ORDER.map((r) => {
        const elevated = r === 'owner' || r === 'admin';
        const disabled = elevated && !isOwner;
        return (
          <label key={r} className="row" style={{ opacity: disabled ? 0.5 : 1 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={value.includes(r)}
              disabled={disabled} onChange={() => toggle(r)} />
            <span>{ROLE_LABELS[r]}{disabled && <span className="muted"> · owner only</span>}</span>
          </label>
        );
      })}
    </div>
  );
}

function AddMember({ isOwner, mkCallable, onClose, onErr, onDone }) {
  const [email, setEmail] = useState('');
  const [displayName, setName] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('clinical');
  const [roles, setRoles] = useState(['staff']);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!email.trim()) return;
    setBusy(true); onErr('');
    try {
      const r = await mkCallable('memberCreate')({
        email: email.trim(), displayName: displayName.trim(), title: title.trim(),
        roles, category,
      });
      onDone(r);
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="Add person" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={create} disabled={busy || !email.trim()}>
          {busy ? 'Creating…' : 'Create account'}</button>
      </>}>
      <label className="field"><span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
      <div className="grid2">
        <label className="field"><span>Full name</span>
          <input value={displayName} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="RN, Circulator" /></label>
      </div>
      <label className="field"><span>Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="clinical">Clinical</option>
          <option value="frontOffice">Front office</option>
          <option value="allied">Allied</option>
        </select></label>
      <div className="field"><span>Roles</span>
        <RoleChecks value={roles} onChange={setRoles} isOwner={isOwner} /></div>
      <p className="muted">A sign-in is created immediately. Clinical training requirements
        are assigned automatically based on role and category.</p>
    </Modal>
  );
}

function EditRoles({ member, isOwner, mkCallable, onClose, onErr }) {
  const [roles, setRoles] = useState(member.roles || ['staff']);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); onErr('');
    try { await mkCallable('memberSetRoles')({ uid: member.id, roles }); onClose(); }
    catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={`Roles — ${member.displayName}`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save roles'}</button>
      </>}>
      <RoleChecks value={roles} onChange={setRoles} isOwner={isOwner} />
      <p className="muted">Role changes take effect on the person's next sign-in
        (their session is refreshed automatically).</p>
    </Modal>
  );
}
