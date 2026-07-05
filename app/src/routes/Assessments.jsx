// src/routes/Assessments.jsx — self-assessment / mock survey scoring.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, doc } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';

const pct = (v) => v == null ? '—' : `${Math.round(v * 100)}%`;
const scoreKind = (v) => v == null ? 'idle' : v >= 0.85 ? 'ok' : v >= 0.5 ? 'warn' : 'alert';

export default function Assessments() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [list, setList] = useState(null);
  const [active, setActive] = useState(null);   // assessmentId being scored
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(
      query(collection(dbc, `orgs/${orgId}/assessments`), orderBy('startedAt', 'desc')),
      (snap) => setList(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setErr(e.message));
  }, [orgId]);

  async function create() {
    setCreating(true); setErr('');
    try {
      const r = await mkCallable('assessmentCreate')({ title: '' });
      setActive(r.assessmentId);
    } catch (e) { setErr(e.message); }
    setCreating(false);
  }

  if (active) return <ScoreView assessmentId={active} onBack={() => setActive(null)} />;

  return (
    <>
      <div className="page-head">
        <div><h1>Self-Assessment</h1><p>Mock-survey scoring against your AAAHC standards, with evidence as support.</p></div>
        {isAdmin && <button className="btn" onClick={create} disabled={creating}>
          {creating ? 'Creating…' : 'New assessment'}</button>}
      </div>
      {err && <div className="err">{err}</div>}

      {list === null ? <Loader /> : list.length === 0 ? (
        <div className="card"><Empty title="No assessments yet">
          Start a self-assessment to score your readiness standard by standard.</Empty></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Assessment</th><th>Status</th><th>Overall</th><th>Rated</th><th></th></tr></thead>
            <tbody>
              {list.map((a) => {
                const c = a.summary?.counts || {};
                const total = (c.compliant || 0) + (c.partial || 0) + (c.noncompliant || 0) + (c.unrated || 0) + (c.na || 0);
                const rated = total - (c.unrated || 0);
                return (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{a.title}
                      <div className="muted" style={{ fontWeight: 400 }}>{a.edition}</div></td>
                    <td><StatusPill kind={a.status === 'complete' ? 'ok' : 'idle'}>{a.status}</StatusPill></td>
                    <td><StatusPill kind={scoreKind(a.summary?.overall)}>{pct(a.summary?.overall)}</StatusPill></td>
                    <td className="muted tnum">{rated}/{total}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost sm" onClick={() => setActive(a.id)}>
                        {a.status === 'complete' ? 'View' : 'Score'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ScoreView({ assessmentId, onBack }) {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [assessment, setAssessment] = useState(null);
  const [ratings, setRatings] = useState(null);
  const [selStd, setSelStd] = useState(null);
  const [textByCode, setTextByCode] = useState({}); // code -> requirement text
  const [stdText, setStdText] = useState(null);      // standard-level text + evidence
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const u1 = onSnapshot(doc(dbc, `orgs/${orgId}/assessments/${assessmentId}`),
      (d) => setAssessment({ id: d.id, ...d.data() }), (e) => setErr(e.message));
    const u2 = onSnapshot(collection(dbc, `orgs/${orgId}/assessments/${assessmentId}/ratings`),
      (snap) => setRatings(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => setErr(e.message));
    return () => { u1(); u2(); };
  }, [orgId, assessmentId]);

  async function rate(code, rating) {
    try { await mkCallable('assessmentRateItem')({ assessmentId, code, rating }); }
    catch (e) { setErr(e.message); }
  }
  async function complete() {
    try { await mkCallable('assessmentComplete')({ assessmentId }); }
    catch (e) { setErr(e.message); }
  }

  // Load requirement text + evidence for the selected standard (from crosswalk).
  const currentCode = selStd || (ratings && ratings.find((r) => r.kind === 'standard')?.standardCode);
  useEffect(() => {
    if (!currentCode) return;
    const id = currentCode.replace(/\./g, '-');
    setStdText(null);
    mkCallable('handbookGetCrosswalk')({ standardId: id })
      .then((r) => {
        const map = {};
        // standard-level text
        if (r.ownText?.text) map[currentCode] = r.ownText.text;
        // element-level text
        for (const el of r.ownText?.elements || []) map[el.code] = el.text;
        setTextByCode((prev) => ({ ...prev, ...map }));
        setStdText({ evidence: r.evidence || [], ownText: r.ownText || null });
      })
      .catch((e) => setErr(e.message));
  }, [currentCode]);

  if (!assessment || ratings === null) return <Loader label="Loading assessment…" />;

  // group ratings by standard
  const standards = {};
  for (const r of ratings) {
    const sc = r.standardCode || r.code;
    (standards[sc] ||= { code: sc, domain: r.domain, standard: null, elements: [] });
    if (r.kind === 'standard') standards[sc].standard = r;
    else standards[sc].elements.push(r);
  }
  const stdList = Object.values(standards).sort((a, b) => a.code.localeCompare(b.code));
  const current = selStd ? standards[selStd] : stdList[0];
  const s = assessment.summary || {};

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← All assessments</button>
          <h1>{assessment.title}</h1>
          <p>{assessment.status === 'complete' ? 'Completed' : 'In progress'} · {assessment.edition}</p>
        </div>
        {isAdmin && assessment.status !== 'complete' &&
          <button className="btn" onClick={complete}>Complete assessment</button>}
      </div>
      {err && <div className="err">{err}</div>}

      {/* readiness rollup */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="readiness">
          <div className="readiness-overall">
            <div className="tnum" style={{ fontSize: 34, fontWeight: 700, color: 'var(--ink)' }}>{pct(s.overall)}</div>
            <div className="muted">overall readiness</div>
          </div>
          <div className="readiness-counts">
            <Count label="Compliant" n={s.counts?.compliant} kind="ok" />
            <Count label="Partial" n={s.counts?.partial} kind="warn" />
            <Count label="Non-compliant" n={s.counts?.noncompliant} kind="alert" />
            <Count label="Unrated" n={s.counts?.unrated} kind="idle" />
          </div>
        </div>
        {s.byDomain && Object.keys(s.byDomain).length > 0 && (
          <div className="domain-bars">
            {Object.entries(s.byDomain).sort().map(([dom, v]) => (
              <div key={dom} className="domain-bar">
                <span className="tnum" style={{ width: 44 }}>{dom}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: pct(v), background: `var(--${scoreKind(v) === 'ok' ? 'ok' : scoreKind(v) === 'warn' ? 'warn' : 'alert'})` }} /></div>
                <span className="muted tnum" style={{ width: 44, textAlign: 'right' }}>{pct(v)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* scoring grid */}
      <div className="crosswalk">
        <div className="card std-tree">
          {stdList.map((st) => {
            const rated = st.elements.filter((e) => e.rating != null).length;
            return (
              <button key={st.code} className={`std-item ${current?.code === st.code ? 'active' : ''}`}
                onClick={() => setSelStd(st.code)}>
                <span className="std-code tnum">{st.code}</span>
                <span className="std-ref">{rated}/{st.elements.length} rated</span>
              </button>
            );
          })}
        </div>
        <div className="card card-pad std-detail">
          {!current ? <Empty title="Select a standard" /> : (
            <>
              <div className="std-code-lg tnum">{current.code}</div>
              {textByCode[current.code] && (
                <div className="handbook-text" style={{ marginTop: 10 }}>{textByCode[current.code]}</div>
              )}
              {current.standard?.scale && (
                <div style={{ margin: '14px 0' }}>
                  <RatingRow item={current.standard} label="Standard rating"
                    disabled={assessment.status === 'complete'} onRate={rate} />
                </div>
              )}
              {stdText?.evidence?.length > 0 && (
                <div className="std-section" style={{ paddingTop: 12 }}>
                  <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                    Supporting evidence ({stdText.evidence.length})</div>
                  {stdText.evidence.map((ev) => <div key={ev.id} className="std-row">{ev.title}</div>)}
                </div>
              )}
              {current.elements.sort((a, b) => a.code.localeCompare(b.code)).map((el) => (
                <div key={el.code} className="std-section" style={{ paddingTop: 12 }}>
                  <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{el.code}</div>
                  {textByCode[el.code] && (
                    <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>{textByCode[el.code]}</div>
                  )}
                  <RatingRow item={el} disabled={assessment.status === 'complete'} onRate={rate} />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function RatingRow({ item, label, disabled, onRate }) {
  return (
    <div>
      {label && <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>}
      <div className="rating-opts">
        {(item.scale || ['Yes', 'No', 'N/A']).map((opt) => (
          <button key={opt} disabled={disabled}
            className={`rating-opt ${item.rating === opt ? 'sel' : ''}`}
            onClick={() => onRate(item.code, opt)}>{opt}</button>
        ))}
      </div>
    </div>
  );
}

function Count({ label, n, kind }) {
  return (
    <div className="count-cell">
      <div className={`count-n st-${kind}`}>{n ?? 0}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
