// src/routes/Today.jsx — the daily board. Tasks due for me, grouped
// Overdue / Due today / Upcoming. Each links to its checkpoint scan URL
// (or a "go scan" note for requireScan tasks).
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy } from 'firebase/firestore';
import { dbc, CONFIG_ORG_ID } from '../lib/firebase.js';
import { useAuth } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill } from '../components/ui.jsx';

const APP_HOST = import.meta.env.VITE_APP_HOST || window.location.origin;

function ms(ts) { return ts?._seconds ? ts._seconds * 1000 : ts?.toMillis ? ts.toMillis() : 0; }

export default function Today() {
  const { orgId, roles, user } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [checkpoints, setCheckpoints] = useState({});

  useEffect(() => {
    if (!orgId) return;
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const unsub = onSnapshot(
      query(collection(dbc, `orgs/${orgId}/tasks`), where('status', '==', 'open'), orderBy('dueAt')),
      (snap) => setTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setTasks([])
    );
    const unsub2 = onSnapshot(collection(dbc, `orgs/${orgId}/checkpoints`),
      (snap) => setCheckpoints(Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]))));
    return () => { unsub(); unsub2(); };
  }, [orgId]);

  if (tasks === null) return <Loader label="Loading today's board…" />;

  // Mine: assigned to me directly, or to a role I hold.
  const mine = tasks.filter((t) =>
    t.assignedUid === user.uid || (!t.assignedUid && roles.includes(t.assignedRole)));

  const now = Date.now();
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const overdue = mine.filter((t) => ms(t.dueAt) < now);
  const dueToday = mine.filter((t) => ms(t.dueAt) >= now && ms(t.dueAt) <= endOfDay.getTime());
  const upcoming = mine.filter((t) => ms(t.dueAt) > endOfDay.getTime());

  function scanHref(t) {
    const cp = t.checkpointId;
    if (!cp) return null;
    const token = checkpoints[cp]?.qrToken;
    if (!token) return null;
    return CONFIG_ORG_ID ? `${APP_HOST}/s/${token}` : `${APP_HOST}/s/${orgId}/${token}`;
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Today</h1><p>Your compliance items. Tap a check to open its form.</p></div>
      </div>

      {mine.length === 0 ? (
        <div className="card"><Empty title="All clear">Nothing due for you right now.</Empty></div>
      ) : (
        <>
          {overdue.length > 0 && <Group title="Overdue" kind="alert" tasks={overdue} scanHref={scanHref} />}
          {dueToday.length > 0 && <Group title="Due today" kind="warn" tasks={dueToday} scanHref={scanHref} />}
          {upcoming.length > 0 && <Group title="Upcoming" kind="idle" tasks={upcoming} scanHref={scanHref} />}
        </>
      )}
    </>
  );
}

function Group({ title, kind, tasks, scanHref }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-pad" style={{ borderBottom: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <StatusPill kind={kind}>{title}</StatusPill>
        <span className="muted tnum">{tasks.length}</span>
      </div>
      <table>
        <tbody>
          {tasks.map((t) => {
            const href = scanHref(t);
            const due = ms(t.dueAt);
            return (
              <tr key={t.id}>
                <td>
                  <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{t.title}</div>
                  <div className="muted tnum">due {new Date(due).toLocaleString()}
                    {t.priority === 'urgent' && <span className="tag tag-alert" style={{ marginLeft: 8 }}>urgent</span>}
                  </div>
                </td>
                <td style={{ textAlign: 'right', width: 130 }}>
                  {href
                    ? <a className="btn sm" href={href}>{t.requireScan ? 'Scan to log' : 'Open'}</a>
                    : <span className="muted">no form</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
