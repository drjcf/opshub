// src/routes/Incidents.jsx — incidents / occurrence reporting.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, doc } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';

const TYPES = ['adverse-event', 'near-miss', 'medication-error', 'equipment-failure', 'complaint', 'fall', 'infection', 'security', 'other'];
const SEVERITIES = ['no-harm', 'minor', 'moderate', 'severe', 'sentinel'];
const SEV_KIND = { 'no-harm': 'idle', minor: 'ok', moderate: 'warn', severe: 'alert', sentinel: 'alert' };
const STATUS_KIND = { reported: 'warn', investigating: 'warn', action: 'warn', closed: 'ok' };

export default function Incidents() {
  const { orgId } = useAuth();
  const mkCallable = useCallableFactory();
  const [list, setList] = useState(null);
  const [active, setActive] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(query(collection(dbc, `orgs/${orgId}/incidents`), orderBy('reportedAt', 'desc')),
      (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => setErr(e.message));
  }, [orgId]);

  if (active) return <IncidentView incidentId={active} onBack={() => setActive(null)} />;

  const open = (list || []).filter((i) => i.status !== 'closed');

  return (
    <>
      <div className="page-head">
        <div><h1>Incidents</h1><p>Occurrence reporting — adverse events, near-misses, complaints. Report → investigate → resolve.</p></div>
        <button className="btn" onClick={() => setReporting(true)}>Report occurrence</button>
      </div>
      {err && <div className="err">{err}</div>}

      {list === null ? <Loader /> : list.length === 0 ? (
        <div className="card"><Empty title="No incidents reported">A clean log — or file the first occurrence to start the record.</Empty></div>
      ) : (
        <div className="card">
          {open.length > 0 && <div className="card-pad" style={{ borderBottom: '1px solid var(--line)', color: 'var(--slate)', fontSize: 13 }}>
            {open.length} open · {list.length - open.length} closed</div>}
          <table>
            <thead><tr><th>Ref</th><th>Occurrence</th><th>Type</th><th>Severity</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td className="tnum muted">{i.refNumber}</td>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{i.title}
                    <div className="muted" style={{ fontWeight: 400 }}>{i.location}</div></td>
                  <td className="muted">{i.type}</td>
                  <td><StatusPill kind={SEV_KIND[i.severity]}>{i.severity}</StatusPill></td>
                  <td><StatusPill kind={STATUS_KIND[i.status]}>{i.status}</StatusPill></td>
                  <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => setActive(i.id)}>
                    {i.status === 'closed' ? 'View' : 'Open'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reporting && <ReportModal mkCallable={mkCallable} onClose={() => setReporting(false)}
        onDone={(id) => { setReporting(false); setActive(id); }} onErr={setErr} />}
    </>
  );
}

function IncidentView({ incidentId, onBack }) {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [inc, setInc] = useState(null);
  const [actions, setActions] = useState([]);
  const [studies, setStudies] = useState([]);
  const [modal, setModal] = useState(null); // investigate | action | close | qi
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const base = `orgs/${orgId}/incidents/${incidentId}`;
    const u0 = onSnapshot(doc(dbc, base), (d) => setInc({ id: d.id, ...d.data() }), (e) => setErr(e.message));
    const u1 = onSnapshot(collection(dbc, `${base}/actions`), (s) => setActions(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const u2 = onSnapshot(collection(dbc, `orgs/${orgId}/qiStudies`), (s) => setStudies(s.docs.map((d) => ({ id: d.id, title: d.get('title') }))));
    return () => { u0(); u1(); u2(); };
  }, [orgId, incidentId]);

  if (!inc) return <Loader />;
  const closed = inc.status === 'closed';
  const inv = inc.investigation;

  async function call(name, data) {
    setErr('');
    try { await mkCallable(name)({ incidentId, ...data }); }
    catch (e) { setErr(e.message); throw e; }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← Incidents</button>
          <h1>{inc.title}</h1>
          <p className="tnum">{inc.refNumber} · {inc.type} · {inc.location}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <StatusPill kind={SEV_KIND[inc.severity]}>{inc.severity}</StatusPill>{' '}
          <StatusPill kind={STATUS_KIND[inc.status]}>{inc.status}</StatusPill>
        </div>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="muted" style={{ fontSize: 12 }}>What happened</div>
        <p style={{ marginTop: 4 }}>{inc.description}</p>
        {inc.caseMarker && <p className="muted" style={{ fontSize: 12 }}>Case marker: {inc.caseMarker}</p>}
      </div>

      {/* status stepper */}
      {!closed && isAdmin && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="pdsa-stepper" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
            {['reported', 'investigating', 'action'].map((st) => (
              <button key={st} className={`stage ${inc.status === st ? 'active' : ''}`}
                onClick={() => call('incidentAdvanceStatus', { status: st })}>{st}</button>
            ))}
          </div>
        </div>
      )}

      {/* investigation */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head">
          <span>Investigation</span>
          {isAdmin && !closed && <button className="btn ghost sm" onClick={() => setModal('investigate')}>
            {inv ? 'Edit' : 'Add investigation'}</button>}
        </div>
        {!inv ? <div className="card-pad muted">Not yet investigated.</div> : (
          <div className="card-pad">
            <div className="muted" style={{ fontSize: 12 }}>Findings</div><p>{inv.findings}</p>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Root cause</div><p>{inv.rootCause}</p>
            {(inv.contributingFactors || []).length > 0 && <>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Contributing factors</div>
              <div>{inv.contributingFactors.map((f, i) => <span key={i} className="pill st-idle" style={{ marginRight: 4 }}>{f}</span>)}</div>
            </>}
          </div>
        )}
      </div>

      {/* corrective actions */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head">
          <span>Corrective / preventive actions ({actions.length})</span>
          {isAdmin && !closed && <button className="btn ghost sm" onClick={() => setModal('action')}>Add action</button>}
        </div>
        {actions.length === 0 ? <div className="card-pad muted">No CAPA logged.</div> : (
          <table><tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td>{a.description}<div className="muted" style={{ fontSize: 12 }}>{a.type}{a.result ? ` · ${a.result}` : ''}</div></td>
                <td style={{ width: 130, textAlign: 'right' }}>
                  {isAdmin && !closed && a.status !== 'done'
                    ? <select value={a.status} onChange={(e) => call('incidentUpdateAction', { actionId: a.id, status: e.target.value })}>
                        <option value="open">open</option><option value="in-progress">in-progress</option>
                        <option value="done">done</option><option value="cancelled">cancelled</option></select>
                    : <StatusPill kind={a.status === 'done' ? 'ok' : a.status === 'cancelled' ? 'idle' : 'warn'}>{a.status}</StatusPill>}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* QI feed + close */}
      {closed ? (
        <div className="card card-pad" style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>
          <StatusPill kind="ok">Closed</StatusPill>
          <div style={{ marginTop: 8 }}>{inc.outcome}</div>
          {inc.qiStudyId && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Fed into a QI study.</div>}
          {inc.evidenceId && <div className="muted" style={{ fontSize: 12 }}>Finalized as evidence.</div>}
        </div>
      ) : isAdmin && (
        <div style={{ textAlign: 'center', display: 'flex', gap: 10, justifyContent: 'center' }}>
          {studies.length > 0 && <button className="btn ghost" onClick={() => setModal('qi')}>Feed to QI study</button>}
          <button className="btn" onClick={() => setModal('close')}>Close incident → evidence</button>
        </div>
      )}

      {modal === 'investigate' && <InvestigationModal current={inv} onClose={() => setModal(null)}
        onSave={(d) => call('incidentSetInvestigation', d).then(() => setModal(null))} />}
      {modal === 'action' && <ActionModal onClose={() => setModal(null)}
        onSave={(d) => call('incidentAddAction', d).then(() => setModal(null))} />}
      {modal === 'close' && <CloseModal onClose={() => setModal(null)}
        onSave={(d) => call('incidentClose', d).then(() => setModal(null)).catch(() => {})} />}
      {modal === 'qi' && <QIFeedModal studies={studies} onClose={() => setModal(null)}
        onSave={(d) => call('incidentFeedToQI', d).then(() => setModal(null))} />}
    </>
  );
}

function ReportModal({ mkCallable, onClose, onDone, onErr }) {
  const [f, setF] = useState({ type: 'near-miss', severity: 'no-harm', title: '', description: '', location: '', occurredAt: '', caseMarker: '' });
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!f.title || !f.description) return;
    setBusy(true); onErr('');
    try { const r = await mkCallable('incidentReport')(f); onDone(r.incidentId); }
    catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Report an occurrence" onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !f.title || !f.description}>{busy ? 'Filing…' : 'File report'}</button></>}>
      <div className="grid2">
        <label className="field"><span>Type</span><select value={f.type} onChange={s('type')}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="field"><span>Severity</span><select value={f.severity} onChange={s('severity')}>{SEVERITIES.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      </div>
      <label className="field"><span>Title</span><input value={f.title} onChange={s('title')} placeholder="Brief summary" autoFocus /></label>
      <label className="field"><span>What happened (no patient identifiers)</span>
        <textarea rows={4} value={f.description} onChange={s('description')} /></label>
      <div className="grid2">
        <label className="field"><span>Location</span><input value={f.location} onChange={s('location')} placeholder="OR 1, recovery…" /></label>
        <label className="field"><span>Occurred</span><input type="datetime-local" value={f.occurredAt} onChange={s('occurredAt')} /></label>
      </div>
      <label className="field"><span>Case marker (optional, practice-controlled — not PHI)</span><input value={f.caseMarker} onChange={s('caseMarker')} /></label>
    </Modal>
  );
}

function InvestigationModal({ current, onClose, onSave }) {
  const [findings, setF] = useState(current?.findings || '');
  const [rootCause, setR] = useState(current?.rootCause || '');
  const [factors, setFac] = useState((current?.contributingFactors || []).join(', '));
  return (
    <Modal title="Investigation" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ findings, rootCause, contributingFactors: factors.split(',').map((x) => x.trim()).filter(Boolean) })}
          disabled={!findings || !rootCause}>Save</button></>}>
      <label className="field"><span>Findings</span><textarea rows={3} value={findings} onChange={(e) => setF(e.target.value)} /></label>
      <label className="field"><span>Root cause</span><textarea rows={2} value={rootCause} onChange={(e) => setR(e.target.value)} /></label>
      <label className="field"><span>Contributing factors (comma-separated)</span><input value={factors} onChange={(e) => setFac(e.target.value)} /></label>
    </Modal>
  );
}

function ActionModal({ onClose, onSave }) {
  const [description, setD] = useState(''); const [type, setT] = useState('corrective'); const [dueDate, setDue] = useState('');
  return (
    <Modal title="Corrective / preventive action" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ description, type, dueDate: dueDate || null })} disabled={!description}>Save</button></>}>
      <label className="field"><span>Action</span><input value={description} onChange={(e) => setD(e.target.value)} autoFocus /></label>
      <div className="grid2">
        <label className="field"><span>Type</span><select value={type} onChange={(e) => setT(e.target.value)}>
          <option value="corrective">corrective</option><option value="preventive">preventive</option></select></label>
        <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(e) => setDue(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

function CloseModal({ onClose, onSave }) {
  const [outcome, setO] = useState('');
  return (
    <Modal title="Close incident" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ outcome })} disabled={!outcome}>Close & finalize</button></>}>
      <p className="muted" style={{ marginBottom: 12 }}>Requires a completed investigation (findings + root cause) and no open corrective actions. The incident report is finalized as immutable evidence.</p>
      <label className="field"><span>Resolution / outcome</span><textarea rows={4} value={outcome} onChange={(e) => setO(e.target.value)} /></label>
    </Modal>
  );
}

function QIFeedModal({ studies, onClose, onSave }) {
  const [studyId, setS] = useState(studies[0]?.id || '');
  const [value, setV] = useState(''); const [period, setP] = useState(new Date().toISOString().slice(0, 7));
  return (
    <Modal title="Feed to QI study" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ studyId, value: Number(value), period })} disabled={!studyId || value === ''}>Add data point</button></>}>
      <p className="muted" style={{ marginBottom: 12 }}>Contribute this occurrence as a measurement in a quality study — it'll be tagged as incident-derived.</p>
      <label className="field"><span>Study</span><select value={studyId} onChange={(e) => setS(e.target.value)}>
        {studies.map((st) => <option key={st.id} value={st.id}>{st.title}</option>)}</select></label>
      <div className="grid2">
        <label className="field"><span>Value</span><input type="number" value={value} onChange={(e) => setV(e.target.value)} /></label>
        <label className="field"><span>Period</span><input value={period} onChange={(e) => setP(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
