// src/App.jsx — shell, routing, auth gate.
import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from './lib/auth.jsx';
import { Loader } from './components/ui.jsx';
import Checkpoints from './routes/Checkpoints.jsx';
import Registers from './routes/Registers.jsx';
import Labels from './routes/Labels.jsx';
import Today from './routes/Today.jsx';
import Members from './routes/Members.jsx';
import Standards from './routes/Standards.jsx';
import HandbookDrafts from './routes/HandbookDrafts.jsx';
import Assessments from './routes/Assessments.jsx';
import Library from './routes/Library.jsx';
import LogsHub from './routes/LogsHub.jsx';
import QIStudies from './routes/QIStudies.jsx';

function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(''); setBusy(true);
    try { await login(email, pw); }
    catch { setErr('Email or password not recognized.'); setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">Ops<span>Hub</span></div>
        <div className="sub">Compliance & practice management</div>
        {err && <div className="err">{err}</div>}
        <label className="field"><span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus /></label>
        <label className="field"><span>Password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
        <button className="btn" style={{ width: '100%', justifyContent: 'center' }}
          onClick={submit} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </div>
  );
}

function Sidebar() {
  const { user, roles, logout, orgId } = useAuth();
  return (
    <nav className="sidebar">
      <div className="brand">Ops<span>Hub</span></div>
      <NavLink to="/checkpoints" className="navlink">Checkpoints</NavLink>
      <NavLink to="/registers" className="navlink">Registers</NavLink>
      <NavLink to="/logs" className="navlink">Logs & Checklists</NavLink>
      <NavLink to="/qi" className="navlink">QA / QI</NavLink>
      <NavLink to="/labels" className="navlink">Print labels</NavLink>
      <NavLink to="/people" className="navlink">People</NavLink>
      <NavLink to="/standards" className="navlink">Standards</NavLink>
      <NavLink to="/handbook-drafts" className="navlink">Review entries</NavLink>
      <NavLink to="/assessments" className="navlink">Self-Assessment</NavLink>
      <NavLink to="/library" className="navlink">Library</NavLink>
      <div className="nav-sep" />
      <NavLink to="/today" className="navlink">Today</NavLink>
      <div className="navlink" style={{ opacity: 0.5, cursor: 'default' }}>Training · soon</div>
      <div className="sidebar-foot">
        {user?.email}<br />{roles.join(', ') || 'no role'} · {orgId || '—'}
        <button onClick={logout}>Sign out</button>
      </div>
    </nav>
  );
}

export default function App() {
  const { user, loading, isAdmin } = useAuth();
  if (loading) return <Loader label="Starting OpsHub…" />;
  if (!user) return <Login />;

  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        {!isAdmin && (
          <div className="err">This build's admin console requires an owner or admin role.
            You're signed in but read-only here.</div>
        )}
        <Routes>
          <Route path="/today" element={<Today />} />
          <Route path="/checkpoints" element={<Checkpoints />} />
          <Route path="/registers" element={<Registers />} />
          <Route path="/labels" element={<Labels />} />
          <Route path="/people" element={<Members />} />
          <Route path="/standards" element={<Standards />} />
          <Route path="/handbook-drafts" element={<HandbookDrafts />} />
          <Route path="/assessments" element={<Assessments />} />
          <Route path="/library" element={<Library />} />
          <Route path="/logs" element={<LogsHub />} />
          <Route path="/qi" element={<QIStudies />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes>
      </main>
    </div>
  );
}
