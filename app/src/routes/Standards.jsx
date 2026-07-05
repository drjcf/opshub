// src/routes/Standards.jsx — the compliance crosswalk / "digital handbook".
// Left: shipped citation tree (no AAAHC text). Right: this org's own handbook
// text (licensee-entered) + obligations + evidence coverage per standard.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Modal, Loader, Empty, StatusPill } from '../components/ui.jsx';
import HandbookUpload from '../components/HandbookUpload.jsx';
import AskBox from '../components/AskBox.jsx';

export default function Standards() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [edition, setEdition] = useState(null);
  const [license, setLicense] = useState(undefined); // undefined=loading, null=none
  const [standards, setStandards] = useState(null);
  const [selected, setSelected] = useState(null);
  const [crosswalk, setCrosswalk] = useState(null);
  const [editEntry, setEditEntry] = useState(false);
  const [attesting, setAttesting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  // Load license attestation for this org.
  useEffect(() => {
    if (!orgId) return;
    getDoc(doc(dbc, `orgs/${orgId}/handbookConfig/license`)).then((s) => {
      if (s.exists()) { setLicense(s.data()); setEdition(s.get('edition')); }
      else setLicense(null);
    });
  }, [orgId]);

  // Load the citation tree for the edition (from the global reference).
  useEffect(() => {
    if (!edition) return;
    return onSnapshot(collection(dbc, `standardsEditions/${edition}/standards`),
      (snap) => setStandards(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.sortKey || '').localeCompare(b.sortKey || ''))),
      (e) => setErr(e.message));
  }, [edition]);

  async function select(std) {
    setSelected(std); setCrosswalk(null);
    try {
      const r = await mkCallable('handbookGetCrosswalk')({ standardId: std.id });
      setCrosswalk(r);
    } catch (e) { setErr(e.message); }
  }

  // No license yet — prompt an owner to attest.
  if (license === undefined) return <Loader label="Loading standards…" />;
  if (license === null || license.status !== 'active') {
    return (
      <>
        <div className="page-head"><div><h1>Standards</h1>
          <p>Cross-reference AAAHC standards to your obligations and evidence.</p></div></div>
        <div className="card card-pad">
          <Empty title="Handbook not linked">
            To use the digital handbook, an owner attests that this organization holds a
            valid AAAHC handbook license. OpsHub stores your own purchased copy — it never
            distributes AAAHC's text.
          </Empty>
          {isAdmin && <div style={{ textAlign: 'center', paddingBottom: 20 }}>
            <button className="btn" onClick={() => setAttesting(true)}>Attest handbook license</button>
          </div>}
        </div>
        {attesting && <AttestModal mkCallable={mkCallable} onErr={setErr}
          onClose={() => setAttesting(false)}
          onDone={() => { setAttesting(false); window.location.reload(); }} />}
        {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Standards</h1><p>Edition {edition} · your handbook, obligations, and evidence per standard.</p></div>
        {isAdmin && <button className="btn ghost" onClick={() => setUploading(true)}>Upload handbook PDF</button>}
      </div>
      {err && <div className="err">{err}</div>}
      <AskBox mkCallable={mkCallable} />

      <div className="crosswalk">
        <div className="card std-tree">
          {standards === null ? <Loader /> : (
            <div>
              {standards.map((s) => (
                <button key={s.id} className={`std-item ${selected?.id === s.id ? 'active' : ''}`}
                  onClick={() => select(s)}>
                  <span className="std-code tnum">{s.code}</span>
                  <span className="std-ref">{s.shortRef}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card card-pad std-detail">
          {!selected ? (
            <Empty title="Select a standard">Choose a standard to see your handbook text, obligations, and evidence.</Empty>
          ) : !crosswalk ? <Loader /> : (
            <>
              <div className="std-detail-head">
                <div>
                  <div className="std-code-lg tnum">{selected.code}</div>
                  <div className="muted">{selected.chapterName}</div>
                </div>
                <CoveragePill coverage={crosswalk.coverage} />
              </div>
              <h3 className="std-shortref">{selected.shortRef}</h3>

              <section className="std-section">
                <div className="std-section-head">
                  <span>Your handbook text</span>
                  {isAdmin && <button className="btn ghost sm" onClick={() => setEditEntry(true)}>
                    {crosswalk.ownText ? 'Edit' : 'Add text'}</button>}
                </div>
                {crosswalk.ownText?.text || crosswalk.ownText?.elements?.length
                  ? <div className="handbook-text">
                      {crosswalk.ownText.designator && <div className="pill st-idle" style={{ marginBottom: 8 }}>{crosswalk.ownText.designator}</div>}
                      {crosswalk.ownText.text && <div>{crosswalk.ownText.text}
                        {crosswalk.ownText.rating && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>· Rating: {crosswalk.ownText.rating}</span>}</div>}
                      {crosswalk.ownText.elements?.map((el) => (
                        <div key={el.code} style={{ marginTop: 10 }}>
                          <span className="std-code tnum" style={{ marginRight: 8 }}>{el.code}</span>
                          {el.text}
                          {el.rating && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>· {el.rating}</span>}
                        </div>
                      ))}
                      {crosswalk.ownText.guidance?.length > 0 && (
                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Guidance</div>
                          {crosswalk.ownText.guidance.map((g, i) => <div key={i} style={{ marginTop: 4 }}>• {g}</div>)}
                        </div>
                      )}
                      {crosswalk.ownText.pageRef && <div className="muted" style={{ marginTop: 8 }}>{crosswalk.ownText.pageRef}</div>}
                    </div>
                  : <p className="muted">No text entered. Add the text from your purchased handbook for this standard.</p>}
              </section>

              <section className="std-section">
                <div className="std-section-head"><span>Obligations ({crosswalk.obligations.length})</span></div>
                {crosswalk.obligations.length === 0 ? <p className="muted">No obligations pinned to this standard.</p>
                  : crosswalk.obligations.map((o) => <div key={o.id} className="std-row">{o.title}</div>)}
              </section>

              <section className="std-section">
                <div className="std-section-head"><span>Evidence ({crosswalk.evidence.length})</span></div>
                {crosswalk.evidence.length === 0 ? <p className="muted">No evidence mapped yet.</p>
                  : crosswalk.evidence.map((e) => <div key={e.id} className="std-row">{e.title}</div>)}
              </section>
            </>
          )}
        </div>
      </div>

      {uploading && <HandbookUpload edition={edition}
        onClose={() => setUploading(false)}
        onDone={() => window.location.reload()} />}
      {editEntry && selected && <EntryModal standardId={selected.id} current={crosswalk?.ownText}
        mkCallable={mkCallable} onErr={setErr}
        onClose={() => setEditEntry(false)}
        onDone={() => { setEditEntry(false); select(selected); }} />}
    </>
  );
}

function CoveragePill({ coverage }) {
  const map = { covered: ['ok', 'covered'], obligated: ['warn', 'obligated, no evidence'], gap: ['alert', 'gap'] };
  const [kind, label] = map[coverage] || ['idle', coverage];
  return <StatusPill kind={kind}>{label}</StatusPill>;
}

function AttestModal({ mkCallable, onClose, onErr, onDone }) {
  const [edition, setEdition] = useState('aaahc-2026');
  const [source, setSource] = useState('purchased-pdf');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!confirm) return;
    setBusy(true); onErr('');
    try { await mkCallable('handbookAttestLicense')({ edition, source }); onDone(); }
    catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Attest handbook license" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={go} disabled={busy || !confirm}>{busy ? 'Recording…' : 'Attest'}</button>
      </>}>
      <label className="field"><span>Edition</span>
        <select value={edition} onChange={(e) => setEdition(e.target.value)}>
          <option value="aaahc-2026">AAAHC 2026</option>
        </select></label>
      <label className="field"><span>Source</span>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="purchased-pdf">Purchased PDF</option>
          <option value="print-transcribed">Print copy (transcribed)</option>
        </select></label>
      <label className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)} />
        <span className="muted">I confirm this organization holds a valid AAAHC handbook license
          for this edition. OpsHub stores our own purchased copy; it does not provide AAAHC's content.</span>
      </label>
    </Modal>
  );
}

function EntryModal({ standardId, current, mkCallable, onClose, onErr, onDone }) {
  const [text, setText] = useState(current?.text || '');
  const [pageRef, setPageRef] = useState(current?.pageRef || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); onErr('');
    try { await mkCallable('handbookSetEntry')({ standardId, text, pageRef }); onDone(); }
    catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={`Handbook text — ${standardId}`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <label className="field"><span>Text (from your purchased handbook)</span>
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Enter the standard's text from your own AAAHC handbook copy." /></label>
      <label className="field"><span>Page reference</span>
        <input value={pageRef} onChange={(e) => setPageRef(e.target.value)} placeholder="p. 84" /></label>
      <p className="muted">This text is stored privately in your organization only and is not shared with other OpsHub customers or with surveyors.</p>
    </Modal>
  );
}
