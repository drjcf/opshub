// src/routes/QIStudies.jsx — QA/QI studies (PDSA cycle).
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, doc } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { exportToDoc, exportToSheet } from '../lib/googleExport.js';
import { qiStudyDoc, qiStudyCsv } from '../lib/exportContent.js';

const STATUS_KIND = { planning: 'idle', collecting: 'warn', analyzing: 'warn', acting: 'warn', remeasuring: 'warn', closed: 'ok' };
const STAGES = ['planning', 'collecting', 'analyzing', 'acting', 'remeasuring'];
const CATS = ['infection-control', 'clinical-outcome', 'patient-safety', 'medication', 'access', 'patient-experience', 'other'];

export default function QIStudies() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [list, setList] = useState(null);
  const [active, setActive] = useState(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(query(collection(dbc, `orgs/${orgId}/qiStudies`), orderBy('startedAt', 'desc')),
      (snap) => setList(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setErr(e.message));
  }, [orgId]);

  if (active) return <StudyView studyId={active} onBack={() => setActive(null)} />;

  return (
    <>
      <div className="page-head">
        <div><h1>QA / QI Studies</h1><p>Performance-improvement studies — measure, analyze, act, close the loop.</p></div>
        {isAdmin && <button className="btn" onClick={() => setCreating(true)}>New study</button>}
      </div>
      {err && <div className="err">{err}</div>}

      {list === null ? <Loader /> : list.length === 0 ? (
        <div className="card"><Empty title="No studies yet">Start a QI study to track a quality measure over time.</Empty></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Study</th><th>Category</th><th>Status</th><th>Latest</th><th>Goal</th><th></th></tr></thead>
            <tbody>
              {list.map((s) => {
                const m = s.measure || {}; const sum = s.summary || {};
                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.title}
                      <div className="muted" style={{ fontWeight: 400 }}>{s.aim}</div></td>
                    <td className="muted">{s.category}</td>
                    <td><StatusPill kind={STATUS_KIND[s.status]}>{s.status}</StatusPill></td>
                    <td className="tnum">{sum.latestValue != null ? `${sum.latestValue}${m.unit || ''}` : '—'}
                      {sum.latestPeriod && <div className="muted" style={{ fontSize: 12 }}>{sum.latestPeriod}</div>}</td>
                    <td className="tnum">{m.goal != null ? `${m.goal}${m.unit || ''}` : '—'}
                      {sum.goalMet != null && <StatusPill kind={sum.goalMet ? 'ok' : 'alert'}>{sum.goalMet ? 'met' : 'not met'}</StatusPill>}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => setActive(s.id)}>Open</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewStudy mkCallable={mkCallable} onClose={() => setCreating(false)}
        onDone={(id) => { setCreating(false); setActive(id); }} onErr={setErr} />}
    </>
  );
}

function StudyView({ studyId, onBack }) {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [study, setStudy] = useState(null);
  const [points, setPoints] = useState([]);
  const [actions, setActions] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [modal, setModal] = useState(null); // 'data' | 'action' | 'analysis' | 'baseline' | 'close'
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const base = `orgs/${orgId}/qiStudies/${studyId}`;
    const u0 = onSnapshot(doc(dbc, base), (d) => setStudy({ id: d.id, ...d.data() }), (e) => setErr(e.message));
    const u1 = onSnapshot(collection(dbc, `${base}/dataPoints`), (s) => setPoints(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const u2 = onSnapshot(collection(dbc, `${base}/actions`), (s) => setActions(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const u3 = onSnapshot(collection(dbc, `${base}/analyses`), (s) => setAnalyses(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => { u0(); u1(); u2(); u3(); };
  }, [orgId, studyId]);

  if (!study) return <Loader label="Loading study…" />;
  const m = study.measure || {};
  const sortedPoints = [...points].sort((a, b) => (a.period || '').localeCompare(b.period || ''));
  const closed = study.status === 'closed';

  async function call(name, data) {
    setErr('');
    try { await mkCallable(name)({ studyId, ...data }); }
    catch (e) { setErr(e.message); throw e; }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← All studies</button>
          <h1>{study.title}</h1><p>{study.aim}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ExportButton label="Export report" ghost build={() => exportToDoc(`QI Study - ${study.title}`, qiStudyDoc(study, points, actions, analyses))} />
          <ExportButton label="Export data" ghost build={() => exportToSheet(`QI Data - ${study.title}`, qiStudyCsv(study, points))} />
          <StatusPill kind={STATUS_KIND[study.status]}>{study.status}</StatusPill>
        </div>
      </div>
      {err && <div className="err">{err}</div>}

      {/* measure + goal + PDSA stepper */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="qi-measure">
          <div><div className="muted" style={{ fontSize: 12 }}>Measure</div><strong>{m.name || '—'}</strong> ({m.unit})</div>
          <div><div className="muted" style={{ fontSize: 12 }}>Goal</div><strong>{m.goal ?? '—'}{m.unit}</strong> ({m.direction})</div>
          <div><div className="muted" style={{ fontSize: 12 }}>Baseline</div><strong>{study.baseline ? `${study.baseline.value}${m.unit || ''}` : '—'}</strong></div>
          <div><div className="muted" style={{ fontSize: 12 }}>Latest</div><strong>{study.summary?.latestValue ?? '—'}{m.unit || ''}</strong></div>
        </div>
        {!closed && isAdmin && (
          <div className="pdsa-stepper">
            {STAGES.map((st) => (
              <button key={st} className={`stage ${study.status === st ? 'active' : ''}`}
                onClick={() => call('qiAdvanceStatus', { status: st })}>{st}</button>
            ))}
          </div>
        )}
      </div>

      {/* trend */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="section-head" style={{ border: 'none', paddingBottom: 8 }}>
          <span>Data points ({points.length})</span>
          {isAdmin && !closed && <div>
            {!study.baseline && <button className="btn ghost sm" onClick={() => setModal('baseline')}>Set baseline</button>}
            <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setModal('data')}>Add data point</button>
          </div>}
        </div>
        {sortedPoints.length === 0 ? <p className="muted">No measurements yet.</p> : (
          <Trend points={sortedPoints} goal={m.goal} unit={m.unit} direction={m.direction} />
        )}
      </div>

      {/* actions */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head">
          <span>Actions / interventions ({actions.length})</span>
          {isAdmin && !closed && <button className="btn ghost sm" onClick={() => setModal('action')}>Add action</button>}
        </div>
        {actions.length === 0 ? <div className="card-pad muted">No interventions logged.</div> : (
          <table><tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td>{a.description}{a.result && <div className="muted">{a.result}</div>}</td>
                <td style={{ width: 130, textAlign: 'right' }}>
                  {isAdmin && !closed && a.status !== 'done'
                    ? <select value={a.status} onChange={(e) => call('qiUpdateAction', { actionId: a.id, status: e.target.value })}>
                        <option value="open">open</option><option value="in-progress">in-progress</option>
                        <option value="done">done</option><option value="cancelled">cancelled</option></select>
                    : <StatusPill kind={a.status === 'done' ? 'ok' : a.status === 'cancelled' ? 'idle' : 'warn'}>{a.status}</StatusPill>}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* analyses */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head">
          <span>Analyses ({analyses.length})</span>
          {isAdmin && !closed && <button className="btn ghost sm" onClick={() => setModal('analysis')}>Add analysis</button>}
        </div>
        {analyses.length === 0 ? <div className="card-pad muted">No analysis authored.</div> : (
          <div>{[...analyses].sort((a, b) => (a.authoredAt?._seconds || 0) - (b.authoredAt?._seconds || 0)).map((an) => (
            <div key={an.id} className="card-pad" style={{ borderTop: '1px solid var(--line)' }}>
              <StatusPill kind={an.phase === 'final' ? 'ok' : 'idle'}>{an.phase}</StatusPill>
              <div style={{ marginTop: 6 }}>{an.narrative}</div>
            </div>
          ))}</div>
        )}
      </div>

      {/* closure */}
      {closed ? (
        <div className="card card-pad" style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>
          <StatusPill kind="ok">Closed · {study.outcome}</StatusPill>
          <div style={{ marginTop: 8 }}>{study.conclusion}</div>
          {study.evidenceId && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>Finalized as evidence.</div>}
        </div>
      ) : isAdmin && (
        <div style={{ textAlign: 'center' }}>
          <button className="btn" onClick={() => setModal('close')}>Close study & finalize report</button>
        </div>
      )}

      {modal === 'data' && <DataModal onClose={() => setModal(null)} onSave={(d) => call('qiAddDataPoint', d).then(() => setModal(null))} />}
      {modal === 'baseline' && <BaselineModal onClose={() => setModal(null)} onSave={(d) => call('qiSetBaseline', d).then(() => setModal(null))} />}
      {modal === 'action' && <ActionModal onClose={() => setModal(null)} onSave={(d) => call('qiAddAction', d).then(() => setModal(null))} />}
      {modal === 'analysis' && <AnalysisModal onClose={() => setModal(null)} onSave={(d) => call('qiAddAnalysis', d).then(() => setModal(null))} />}
      {modal === 'close' && <CloseModal onClose={() => setModal(null)} onSave={(d) => call('qiCloseStudy', d).then(() => setModal(null)).catch(() => {})} />}
    </>
  );
}

function Trend({ points, goal, unit, direction }) {
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals, goal ?? Infinity), max = Math.max(...vals, goal ?? -Infinity);
  const range = max - min || 1;
  const h = 120, w = Math.max(points.length * 60, 200);
  const x = (i) => 30 + i * ((w - 40) / Math.max(points.length - 1, 1));
  const y = (v) => h - 20 - ((v - min) / range) * (h - 40);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {goal != null && <line x1="30" x2={w - 10} y1={y(goal)} y2={y(goal)} stroke="var(--warn)" strokeDasharray="4 3" />}
        {goal != null && <text x={w - 10} y={y(goal) - 4} textAnchor="end" fontSize="10" fill="var(--warn)">goal {goal}{unit}</text>}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.value)} r="4" fill="var(--accent)" />
            <text x={x(i)} y={h - 5} textAnchor="middle" fontSize="10" fill="var(--slate)">{p.period}</text>
            <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" fontSize="10" fill="var(--ink)">{p.value}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function NewStudy({ mkCallable, onClose, onDone, onErr }) {
  const [f, setF] = useState({ title: '', aim: '', category: 'infection-control', measureName: '', unit: '%', goal: '', direction: 'decrease', population: '' });
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!f.title || !f.aim) return;
    setBusy(true); onErr('');
    try {
      const r = await mkCallable('qiCreateStudy')({
        title: f.title, aim: f.aim, category: f.category, population: f.population,
        measure: { name: f.measureName, unit: f.unit, goal: f.goal !== '' ? Number(f.goal) : null, direction: f.direction },
      });
      onDone(r.studyId);
    } catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="New QI study" onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !f.title || !f.aim}>{busy ? 'Creating…' : 'Create'}</button></>}>
      <label className="field"><span>Title</span><input value={f.title} onChange={s('title')} placeholder="Reduce surgical site infections" autoFocus /></label>
      <label className="field"><span>Aim</span><input value={f.aim} onChange={s('aim')} placeholder="Reduce SSI rate to <1% within 2 quarters" /></label>
      <div className="grid2">
        <label className="field"><span>Category</span><select value={f.category} onChange={s('category')}>{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label className="field"><span>Population</span><input value={f.population} onChange={s('population')} placeholder="all surgical cases" /></label>
      </div>
      <div className="builder-section"><div className="builder-head"><span>Measure</span></div>
        <label className="field"><span>Measure name</span><input value={f.measureName} onChange={s('measureName')} placeholder="SSI rate" /></label>
        <div className="grid2">
          <label className="field"><span>Unit</span><input value={f.unit} onChange={s('unit')} placeholder="%" /></label>
          <label className="field"><span>Goal</span><input type="number" value={f.goal} onChange={s('goal')} /></label>
        </div>
        <label className="field"><span>Direction</span><select value={f.direction} onChange={s('direction')}>
          <option value="decrease">decrease (lower is better)</option><option value="increase">increase</option><option value="maintain">maintain</option></select></label>
      </div>
    </Modal>
  );
}

function DataModal({ onClose, onSave }) {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [value, setValue] = useState(''); const [num, setNum] = useState(''); const [den, setDen] = useState(''); const [note, setNote] = useState('');
  return (
    <Modal title="Add data point" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ period, value: Number(value), numerator: num !== '' ? Number(num) : null, denominator: den !== '' ? Number(den) : null, note })} disabled={value === ''}>Save</button></>}>
      <label className="field"><span>Period</span><input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07 or 2026-Q2" /></label>
      <label className="field"><span>Value</span><input type="number" value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></label>
      <div className="grid2">
        <label className="field"><span>Numerator</span><input type="number" value={num} onChange={(e) => setNum(e.target.value)} /></label>
        <label className="field"><span>Denominator</span><input type="number" value={den} onChange={(e) => setDen(e.target.value)} /></label>
      </div>
      <label className="field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </Modal>
  );
}

function BaselineModal({ onClose, onSave }) {
  const [value, setValue] = useState(''); const [period, setPeriod] = useState(''); const [note, setNote] = useState('');
  return (
    <Modal title="Set baseline" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ value: Number(value), period, note })} disabled={value === ''}>Save baseline</button></>}>
      <label className="field"><span>Baseline value</span><input type="number" value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></label>
      <label className="field"><span>Period</span><input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-Q1" /></label>
      <label className="field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </Modal>
  );
}

function ActionModal({ onClose, onSave }) {
  const [description, setD] = useState(''); const [dueDate, setDue] = useState('');
  return (
    <Modal title="Add action" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ description, dueDate: dueDate || null })} disabled={!description}>Save</button></>}>
      <label className="field"><span>Intervention</span><input value={description} onChange={(e) => setD(e.target.value)} placeholder="Implement pre-op chlorhexidine protocol" autoFocus /></label>
      <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(e) => setDue(e.target.value)} /></label>
    </Modal>
  );
}

function AnalysisModal({ onClose, onSave }) {
  const [phase, setPhase] = useState('interim'); const [narrative, setN] = useState('');
  return (
    <Modal title="Add analysis" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ phase, narrative })} disabled={!narrative}>Save</button></>}>
      <label className="field"><span>Phase</span><select value={phase} onChange={(e) => setPhase(e.target.value)}>
        <option value="baseline">baseline</option><option value="interim">interim</option>
        <option value="post-intervention">post-intervention</option><option value="final">final (required to close)</option></select></label>
      <label className="field"><span>Analysis</span><textarea rows={5} value={narrative} onChange={(e) => setN(e.target.value)} placeholder="Interpretation of the data and trend…" /></label>
    </Modal>
  );
}

function CloseModal({ onClose, onSave }) {
  const [conclusion, setC] = useState(''); const [outcome, setO] = useState('goal-met');
  return (
    <Modal title="Close study" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ conclusion, outcome })} disabled={!conclusion}>Close & finalize</button></>}>
      <p className="muted" style={{ marginBottom: 12 }}>Closing requires: baseline set, ≥2 data points, a final analysis, and no open actions. The study report is finalized as immutable evidence.</p>
      <label className="field"><span>Outcome</span><select value={outcome} onChange={(e) => setO(e.target.value)}>
        <option value="goal-met">goal met</option><option value="improved">improved</option>
        <option value="no-change">no change</option><option value="worsened">worsened</option></select></label>
      <label className="field"><span>Conclusion</span><textarea rows={4} value={conclusion} onChange={(e) => setC(e.target.value)} placeholder="Summary of the cycle and its result…" /></label>
    </Modal>
  );
}
