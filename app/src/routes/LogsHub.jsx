// src/routes/LogsHub.jsx — Logs & Checklists management hub.
// Every recurring checklist/log with cadence, last completion, open items,
// and a history drawer. The operational record a surveyor asks to see.
import { useEffect, useState } from 'react';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';
import LogBuilder from '../components/LogBuilder.jsx';
import LogEditor from '../components/LogEditor.jsx';

// Human-readable cadence from RRULE.
function cadenceLabel(rrule) {
  if (!rrule) return 'ad hoc';
  const freq = (rrule.match(/FREQ=(\w+)/) || [])[1];
  const day = (rrule.match(/BYDAY=(\w+)/) || [])[1];
  const map = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' };
  let s = map[freq] || freq?.toLowerCase() || 'ad hoc';
  if (freq === 'WEEKLY' && day) s += ` (${day})`;
  return s;
}

function lastLabel(ms) {
  if (!ms) return { text: 'never', kind: 'alert' };
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days === 0) return { text: 'today', kind: 'ok' };
  if (days === 1) return { text: 'yesterday', kind: 'ok' };
  if (days <= 7) return { text: `${days}d ago`, kind: 'warn' };
  return { text: `${days}d ago`, kind: 'alert' };
}

export default function LogsHub() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [rows, setRows] = useState(null);
  const [history, setHistory] = useState(null);
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    try { const r = await mkCallable('logsHubRoster')({}); setRows(r.rows); }
    catch (e) { setErr(e.message); setRows([]); }
  }
  useEffect(() => { if (orgId) load(); }, [orgId]); // eslint-disable-line

  async function openHistory(row) {
    setHistory({ row, rows: null });
    try {
      const r = await mkCallable('logsHubHistory')({ obligationId: row.obligationId });
      setHistory({ row, rows: r.rows });
    } catch (e) { setErr(e.message); setHistory({ row, rows: [] }); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Logs & Checklists</h1><p>All recurring compliance logs, their cadence, and completion history.</p></div>
        {isAdmin && <button className="btn" onClick={() => setBuilding(true)}>New log</button>}
      </div>
      {err && <div className="err">{err}</div>}

      {rows === null ? <Loader /> : rows.length === 0 ? (
        <div className="card"><Empty title="No logs configured">
          Seed the ASC catalog or create obligations to populate this hub.</Empty></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Log / Checklist</th><th>Cadence</th><th>Last done</th><th>Open</th><th>Standards</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const last = lastLabel(r.lastCompletedMs);
                return (
                  <tr key={r.obligationId}>
                    <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.title}
                      <div className="muted" style={{ fontWeight: 400 }}>
                        {r.evidenceType === 'register' ? 'register / par-list' : 'checklist'}</div></td>
                    <td className="muted">{cadenceLabel(r.cadence)}</td>
                    <td><StatusPill kind={last.kind}>{last.text}</StatusPill>
                      {r.lastCompletedBy && <div className="muted" style={{ fontSize: 12 }}>{r.lastCompletedBy}</div>}</td>
                    <td>{r.openCount > 0 ? <StatusPill kind="warn">{r.openCount} due</StatusPill> : <span className="muted">—</span>}</td>
                    <td>{r.standardRefs.slice(0, 3).map((c) => <span key={c} className="pill st-idle" style={{ marginRight: 4 }}>{c}</span>)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.checkpointId && <span className="pill st-ok" style={{ marginRight: 6 }} title="scan-gated">QR</span>}
                      {isAdmin && <button className="btn ghost sm" onClick={() => setEditing(r)}>Edit</button>}
                      <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => openHistory(r)}>History</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && <LogEditor row={editing} mkCallable={mkCallable} orgId={orgId}
        onClose={() => setEditing(null)} onErr={setErr}
        onDone={() => { setEditing(null); load(); }} />}

      {building && <LogBuilder mkCallable={mkCallable} editions={['aaahc-2026']} orgId={orgId}
        onClose={() => setBuilding(false)} onErr={setErr}
        onDone={() => { setBuilding(false); load(); }} />}

      {history && <Modal title={`History — ${history.row.title}`} onClose={() => setHistory(null)}
        footer={<button className="btn ghost" onClick={() => setHistory(null)}>Close</button>}>
        {history.rows === null ? <Loader /> : history.rows.length === 0 ? (
          <Empty title="No completions yet">This log hasn't been completed. It'll appear here once logged.</Empty>
        ) : (
          <table>
            <thead><tr><th>Completed</th><th>By</th><th>Flags</th></tr></thead>
            <tbody>
              {history.rows.map((h) => (
                <tr key={h.evidenceId}>
                  <td className="tnum">{new Date(h.finalizedMs).toLocaleString()}</td>
                  <td className="muted">{h.by || '—'}</td>
                  <td>
                    {h.outOfRange && <span className="pill st-alert" style={{ marginRight: 4 }}>out of range</span>}
                    {h.lateEvidence && <span className="pill st-warn">late</span>}
                    {!h.outOfRange && !h.lateEvidence && <StatusPill kind="ok">clean</StatusPill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>}
    </>
  );
}
