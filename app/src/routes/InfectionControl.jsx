// src/routes/InfectionControl.jsx — the IC program dashboard.
// Pure assembly: pulls the infection-control surveillance logs, IC-category QI
// studies, infection-type incidents, and IC library policies into one program
// view. Read-only aggregation (all sources are canRead) — no new backend.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill } from '../components/ui.jsx';

// The surveillance logs that constitute IC monitoring (by catalogId).
const IC_LOG_CATALOG_IDS = ['sterilizer_autoclave', 'sterilizer_spore', 'biohazard_sharps', 'hand_hygiene_audit'];

function ms(ts) { return ts?._seconds ? ts._seconds * 1000 : (ts?.toMillis ? ts.toMillis() : 0); }
function daysAgo(m) {
  if (!m) return null;
  const d = Math.floor((Date.now() - m) / 86400000);
  return d;
}
function freshness(m, cadenceDays) {
  const d = daysAgo(m);
  if (d == null) return { label: 'never', kind: 'alert' };
  if (d <= cadenceDays) return { label: `${d}d ago`, kind: 'ok' };
  if (d <= cadenceDays * 2) return { label: `${d}d ago`, kind: 'warn' };
  return { label: `${d}d ago`, kind: 'alert' };
}

export default function InfectionControl() {
  const { orgId } = useAuth();
  const [obligations, setObligations] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [studies, setStudies] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    // Obligations (to find IC logs by catalogId).
    const u1 = onSnapshot(collection(dbc, `orgs/${orgId}/obligations`),
      (s) => setObligations(s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => IC_LOG_CATALOG_IDS.includes(o.catalogId))),
      (e) => setErr(e.message));
    // Finalized evidence (to compute last-done per IC log).
    const u2 = onSnapshot(query(collection(dbc, `orgs/${orgId}/evidence`), where('status', '==', 'finalized')),
      (s) => setEvidence(s.docs.map((d) => ({ id: d.id, obligationId: d.get('obligationId'), finalizedAt: d.get('finalizedAt'), payload: d.get('payload') }))),
      () => {});
    // IC-category QI studies.
    const u3 = onSnapshot(query(collection(dbc, `orgs/${orgId}/qiStudies`), where('category', '==', 'infection-control')),
      (s) => setStudies(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => {});
    // Infection-type incidents.
    const u4 = onSnapshot(query(collection(dbc, `orgs/${orgId}/incidents`), where('type', '==', 'infection')),
      (s) => setIncidents(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => {});
    // IC policies from the library (tag match).
    const u5 = onSnapshot(collection(dbc, `orgs/${orgId}/libraryFiles`),
      (s) => setPolicies(s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((f) => (f.tags || []).some((t) => /infection|steriliz|ipc|exposure/i.test(t)) || /infection|steriliz|exposure/i.test(f.title || ''))),
      () => {});
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, [orgId]);

  if (obligations === null) return <Loader label="Assembling IC program…" />;

  // last-done per IC obligation
  const lastByOb = {};
  for (const e of evidence) {
    if (!e.obligationId) continue;
    const m = ms(e.finalizedAt);
    if (!lastByOb[e.obligationId] || m > lastByOb[e.obligationId]) lastByOb[e.obligationId] = m;
  }

  // spore-test result signal (from the most recent spore evidence payload)
  const sporeOb = obligations.find((o) => o.catalogId === 'sterilizer_spore');
  let lastSpore = null;
  if (sporeOb) {
    const sporeEv = evidence.filter((e) => e.obligationId === sporeOb.id).sort((a, b) => ms(b.finalizedAt) - ms(a.finalizedAt))[0];
    if (sporeEv) lastSpore = sporeEv.payload?.answers?.result || null;
  }

  const openStudies = studies.filter((s) => s.status !== 'closed');
  const openIncidents = incidents.filter((i) => i.status !== 'closed');

  // Program health: are all IC logs current, spore passing, no open sentinel infections?
  const cadenceDays = { sterilizer_autoclave: 1, sterilizer_spore: 7, biohazard_sharps: 1, hand_hygiene_audit: 7 };
  const staleLogsCount = obligations.filter((o) => {
    const f = freshness(lastByOb[o.id], cadenceDays[o.catalogId] || 7);
    return f.kind === 'alert';
  }).length;

  return (
    <>
      <div className="page-head">
        <div><h1>Infection Control</h1><p>Surveillance, prevention program, and infection-related quality &amp; safety — assembled in one view.</p></div>
      </div>
      {err && <div className="err">{err}</div>}

      {/* program status banner */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="ic-status">
          <StatusChip ok={staleLogsCount === 0} okText="Surveillance current" badText={`${staleLogsCount} log(s) overdue`} />
          <StatusChip ok={lastSpore !== 'Fail'} okText={lastSpore === 'Pass' ? 'Last spore test passed' : 'Spore status pending'} badText="Spore test FAILED — recall loads" />
          <StatusChip ok={openIncidents.length === 0} okText="No open infection events" badText={`${openIncidents.length} open infection event(s)`} />
        </div>
      </div>

      {/* surveillance logs */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head"><span>Surveillance logs ({obligations.length})</span></div>
        {obligations.length === 0 ? (
          <div className="card-pad muted">No IC surveillance logs found. Seed the ASC catalog to add sterilization, spore, hand-hygiene, and biohazard logs.</div>
        ) : (
          <table>
            <thead><tr><th>Log</th><th>Cadence</th><th>Last done</th><th></th></tr></thead>
            <tbody>
              {obligations.map((o) => {
                const f = freshness(lastByOb[o.id], cadenceDays[o.catalogId] || 7);
                return (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{o.title}</td>
                    <td className="muted">{(o.cadence || '').includes('WEEKLY') ? 'weekly' : (o.cadence || '').includes('DAILY') ? 'daily' : 'periodic'}</td>
                    <td><StatusPill kind={f.kind}>{f.label}</StatusPill>
                      {o.catalogId === 'sterilizer_spore' && lastSpore &&
                        <StatusPill kind={lastSpore === 'Pass' ? 'ok' : 'alert'} >{lastSpore}</StatusPill>}</td>
                    <td style={{ textAlign: 'right' }}><a className="btn ghost sm" href="#/logs">Open in Logs</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* IC quality studies */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head"><span>Infection-control studies ({studies.length})</span>
          <a className="btn ghost sm" href="#/qi">Go to QA / QI</a></div>
        {studies.length === 0 ? (
          <div className="card-pad muted">No infection-control QI studies. Start one (category “infection-control”) to trend surveillance data — e.g. SSI rate, hand-hygiene compliance.</div>
        ) : (
          <table><tbody>
            {studies.map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.title}
                  <div className="muted" style={{ fontWeight: 400 }}>{s.aim}</div></td>
                <td><StatusPill kind={s.status === 'closed' ? 'ok' : 'warn'}>{s.status}</StatusPill></td>
                <td className="tnum">{s.summary?.latestValue != null ? `${s.summary.latestValue}${s.measure?.unit || ''}` : '—'}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* infection incidents */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head"><span>Infection events ({incidents.length})</span>
          <a className="btn ghost sm" href="#/incidents">Go to Incidents</a></div>
        {incidents.length === 0 ? (
          <div className="card-pad muted">No infection-type occurrences reported.</div>
        ) : (
          <table><tbody>
            {incidents.map((i) => (
              <tr key={i.id}>
                <td className="tnum muted">{i.refNumber}</td>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{i.title}</td>
                <td><StatusPill kind={i.status === 'closed' ? 'ok' : 'warn'}>{i.status}</StatusPill></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* IC policies */}
      <div className="card">
        <div className="card-pad section-head"><span>IC policies &amp; procedures ({policies.length})</span>
          <a className="btn ghost sm" href="#/library">Go to Library</a></div>
        {policies.length === 0 ? (
          <div className="card-pad muted">No infection-control policies tagged in the library. Add your IPC plan, exposure-control plan, and sterilization SOPs, tagged “infection-control”.</div>
        ) : (
          <table><tbody>
            {policies.map((p) => (
              <tr key={p.id}><td style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.title}</td>
                <td className="muted">{(p.tags || []).join(', ')}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>
    </>
  );
}

function StatusChip({ ok, okText, badText }) {
  return (
    <div className={`ic-chip ${ok ? 'ok' : 'bad'}`}>
      <span className="ic-dot">{ok ? '✓' : '!'}</span>
      <span>{ok ? okText : badText}</span>
    </div>
  );
}
