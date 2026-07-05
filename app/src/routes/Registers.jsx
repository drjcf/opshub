// src/routes/Registers.jsx — working-document registers (crash carts, par lists).
// Registers are callable-managed; this build creates them via a seed callable
// path is not yet exposed, so creation here writes a draft the admin edits.
// For Session E we surface list + item expiry state (the compliance signal);
// full item editor is Session F. Creation uses a dedicated callable when
// present, else falls back to guidance.
import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill } from '../components/ui.jsx';

const DAY = 86400000;

function itemStatus(item, leadDays = 30) {
  if (!item.expiresAt) return 'ok';
  const ms = item.expiresAt.toMillis ? item.expiresAt.toMillis() : new Date(item.expiresAt).getTime();
  const delta = ms - Date.now();
  if (delta <= 0) return 'alert';
  if (delta <= leadDays * DAY) return 'warn';
  return 'ok';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const ms = ts.toMillis ? ts.toMillis() : new Date(ts).getTime();
  return new Date(ms).toISOString().slice(0, 10);
}

export default function Registers() {
  const { orgId } = useAuth();
  const [items, setItems] = useState(null);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(collection(dbc, `orgs/${orgId}/registers`),
      (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [orgId]);

  function summarize(reg) {
    const its = reg.items || [];
    let worst = 'ok';
    for (const it of its) {
      const s = itemStatus(it, reg.leadTimeDays);
      if (s === 'alert') return 'alert';
      if (s === 'warn') worst = 'warn';
    }
    return worst;
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Registers</h1><p>Working-document logs. Each check verifies contents and records an immutable snapshot.</p></div>
      </div>

      <div className="card">
        {items === null ? <Loader /> : items.length === 0 ? (
          <Empty title="No registers yet">
            Registers (crash carts, par lists) are provisioned during setup. Once created, each links to a checkpoint QR.
          </Empty>
        ) : (
          <table>
            <thead><tr><th>Register</th><th>Kind</th><th>Items</th><th>Last checked</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((reg) => {
                const st = summarize(reg);
                const isOpen = expanded[reg.id];
                return (
                  <>
                    <tr key={reg.id}>
                      <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{reg.title}</td>
                      <td className="muted">{reg.kind || '—'}</td>
                      <td className="tnum">{(reg.items || []).length}</td>
                      <td className="muted tnum">{fmtDate(reg.lastCheckedAt)}</td>
                      <td>
                        <StatusPill kind={st}>
                          {st === 'ok' ? 'current' : st === 'warn' ? 'expiring' : 'expired item'}
                        </StatusPill>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost sm"
                          onClick={() => setExpanded((e) => ({ ...e, [reg.id]: !e[reg.id] }))}>
                          {isOpen ? 'Hide' : 'Items'}</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={reg.id + '-items'}>
                        <td colSpan={6} style={{ background: '#fafbfa', padding: 0 }}>
                          <table>
                            <thead><tr><th>Item</th><th>Lot</th><th>Qty / Par</th><th>Expires</th><th>Status</th></tr></thead>
                            <tbody>
                              {(reg.items || []).map((it) => {
                                const s = itemStatus(it, reg.leadTimeDays);
                                return (
                                  <tr key={it.key}>
                                    <td>{it.name}{it.required && <span className="muted"> · required</span>}</td>
                                    <td className="muted tnum">{it.lot || '—'}</td>
                                    <td className="tnum">{it.qty ?? '—'} / {it.par ?? '—'}</td>
                                    <td className="tnum">{fmtDate(it.expiresAt)}</td>
                                    <td><StatusPill kind={s}>
                                      {s === 'ok' ? 'ok' : s === 'warn' ? 'expiring' : 'expired'}</StatusPill></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        Registers are updated only through a scan-driven check — this view is read-only by design,
        so the working state always matches the signed evidence trail.
      </p>
    </>
  );
}
