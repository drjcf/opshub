// src/routes/Scan.jsx — the /s/:token staff scan flow.
// Lives OUTSIDE the admin shell: full-screen, mobile-first. Resolves the
// token server-side (scanResolve), then routes to the right form based on
// what's due at this checkpoint.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { doc, getDoc } from 'firebase/firestore';
import { fns, dbc, CONFIG_ORG_ID } from '../lib/firebase.js';
import { useAuth } from '../lib/auth.jsx';
import RegisterCheckForm from '../components/RegisterCheckForm.jsx';
import ChecklistForm from '../components/ChecklistForm.jsx';

function ScanLogin({ onDone }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setErr(''); setBusy(true);
    try { await login(email, pw); onDone?.(); }
    catch { setErr('Sign-in failed.'); setBusy(false); }
  }
  return (
    <div className="scan-card">
      <p className="scan-lead">Sign in to log this check.</p>
      {err && <div className="err">{err}</div>}
      <label className="field"><span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
      <label className="field"><span>Password</span>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()} /></label>
      <button className="btn scan-btn" onClick={go} disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}</button>
    </div>
  );
}

export default function Scan() {
  const params = useParams();
  const { user, orgId, loading } = useAuth();
  // Standalone: /s/:token. Hosted multi-tenant: /s/:orgId/:token.
  const token = params.token;
  const routeOrg = params.orgId || CONFIG_ORG_ID || orgId;

  const [state, setState] = useState({ status: 'idle' });
  const [done, setDone] = useState(null);

  async function resolve() {
    setState({ status: 'loading' });
    try {
      const fn = httpsCallable(fns, 'scanResolve');
      const res = await fn({ orgId: routeOrg, token });
      setState({ status: 'ready', data: res.data });
    } catch (e) {
      setState({ status: 'error', message: e?.message || 'Could not resolve this label.' });
    }
  }

  useEffect(() => {
    if (loading) return;
    if (user && token) resolve();
  }, [loading, user, token]); // eslint-disable-line

  if (loading) return <ScanShell><p className="scan-lead">Loading…</p></ScanShell>;
  if (!user) return <ScanShell title="OpsHub"><ScanLogin onDone={resolve} /></ScanShell>;

  if (done) {
    return (
      <ScanShell title="Logged">
        <div className="scan-done">
          <div className="scan-check">✓</div>
          <p className="scan-lead">{done.title} recorded.</p>
          {done.outOfRange && <div className="err">Out-of-range noted. A corrective task was created.</div>}
          <p className="muted">Signed as {user.email} · {new Date().toLocaleString()}</p>
        </div>
      </ScanShell>
    );
  }

  if (state.status === 'loading' || state.status === 'idle')
    return <ScanShell title="OpsHub"><p className="scan-lead">Looking up this checkpoint…</p></ScanShell>;

  if (state.status === 'error')
    return <ScanShell title="Label problem"><div className="err">{state.message}</div>
      <p className="muted">If this label was recently reprinted, ask an admin to confirm it's active.</p></ScanShell>;

  const { checkpoint, openTasks, templates, lastEntry } = state.data;

  if (!openTasks || openTasks.length === 0) {
    return (
      <ScanShell title={checkpoint.label}>
        <p className="scan-lead">Nothing due right now.</p>
        {lastEntry && <p className="muted">Last logged {new Date(
          (lastEntry.finalizedAt?._seconds || 0) * 1000).toLocaleString()}.</p>}
        {checkpoint.allowAdhocLog && <p className="muted">Ad-hoc logging is available for this point.</p>}
      </ScanShell>
    );
  }

  // For this build, take the first open task (single check per scan is the
  // common case; a picker for multiple is a later refinement).
  const task = openTasks[0];
  const template = task.checklistTemplateId ? templates[task.checklistTemplateId] : null;

  return (
    <ScanShell title={checkpoint.label} subtitle={checkpoint.location}>
      {task.registerId ? (
        <RegisterCheckForm
          orgId={routeOrg} token={token} task={task}
          onDone={(r) => setDone({ title: task.title, outOfRange: r.outOfRange })}
        />
      ) : template ? (
        <ChecklistForm
          orgId={routeOrg} token={token} task={task} template={template}
          onDone={(r) => setDone({ title: task.title, outOfRange: r.outOfRange })}
        />
      ) : (
        <div className="err">This task has no form configured. Ask an admin to attach a checklist template or register.</div>
      )}
    </ScanShell>
  );
}

function ScanShell({ title, subtitle, children }) {
  return (
    <div className="scan-wrap">
      <div className="scan-inner">
        <div className="scan-brand">Ops<span>Hub</span></div>
        {title && <h1 className="scan-title">{title}</h1>}
        {subtitle && <p className="scan-sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
