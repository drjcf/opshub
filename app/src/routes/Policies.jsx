// src/routes/Policies.jsx — controlled P&P + required-document coverage.
import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { getStorage, ref as sref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { app } from '../lib/firebase.js';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';

const DOC_TYPES = ['policy', 'procedure', 'plan', 'form', 'manual'];
const CATEGORIES = ['infection-control', 'governance', 'clinical', 'safety', 'hr', 'emergency', 'quality', 'medication', 'facility', 'other'];
const REVIEW_KIND = { current: 'ok', 'review-due': 'alert', 'draft-only': 'warn' };
const COVERAGE_KIND = { met: 'ok', 'review-due': 'warn', unmet: 'alert' };

export default function Policies() {
  const { orgId, isAdmin } = useAuth();
  const [tab, setTab] = useState('manual');
  return (
    <>
      <div className="page-head">
        <div><h1>Policies & Procedures</h1><p>The controlled policy manual — organized in sections, mapped to standards, with review cycles.</p></div>
      </div>
      <div className="tab-bar">
        <button className={`tab ${tab === 'manual' ? 'active' : ''}`} onClick={() => setTab('manual')}>Manual</button>
        <button className={`tab ${tab === 'coverage' ? 'active' : ''}`} onClick={() => setTab('coverage')}>Coverage</button>
      </div>
      {tab === 'manual' ? <Manual isAdmin={isAdmin} orgId={orgId} /> : <Coverage orgId={orgId} />}
    </>
  );
}

function Manual({ isAdmin, orgId }) {
  const mkCallable = useCallableFactory();
  const [manual, setManual] = useState(null);
  const [active, setActive] = useState(null);      // open a document
  const [creating, setCreating] = useState(false);
  const [addSection, setAddSection] = useState(false);
  const [placing, setPlacing] = useState(null);     // { docId } to assign a section
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    try { const r = await mkCallable('manualGet')({}); setManual(r); }
    catch (e) { setErr(e.message); setManual({ sections: [], unfiled: [] }); }
  }
  useEffect(() => { if (orgId) load(); }, [orgId]); // eslint-disable-line

  if (active) return <PolicyDetail docId={active} onBack={() => { setActive(null); load(); }} />;
  if (manual === null) return <Loader label="Assembling manual…" />;

  const hasContent = manual.sections.length > 0 || manual.unfiled.length > 0;

  async function moveSection(idx, dir) {
    const ids = manual.sections.map((s) => s.id);
    const j = idx + dir; if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await mkCallable('manualSectionReorder')({ orderedIds: ids }); load();
  }

  return (
    <>
      {err && <div className="err">{err}</div>}
      {isAdmin && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn ghost" onClick={() => setAddSection(true)}>New section</button>
          <button className="btn" onClick={() => setCreating(true)}>New policy</button>
        </div>
      )}

      {!hasContent ? (
        <div className="card"><Empty title="Empty manual">Create sections (chapters), then add policies into them.</Empty></div>
      ) : (
        <div className="manual-layout">
          {/* Table of contents */}
          <aside className="manual-toc">
            <div className="toc-head">Contents</div>
            <ol className="toc-list">
              {manual.sections.map((sec) => (
                <li key={sec.id}>
                  <a href={`#sec-${sec.id}`} className="toc-sec">{sec.number}. {sec.title}</a>
                  {sec.documents.length > 0 && (
                    <ol className="toc-docs">
                      {sec.documents.map((d) => (
                        <li key={d.docId}><a href={`#doc-${d.docId}`}>{d.number} {d.title}</a></li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
              {manual.unfiled.length > 0 && <li><a href="#sec-unfiled" className="toc-sec muted">Unfiled ({manual.unfiled.length})</a></li>}
            </ol>
          </aside>

          {/* Manual body */}
          <div className="manual-body">
            {manual.sections.map((sec, si) => (
              <section key={sec.id} id={`sec-${sec.id}`} className="manual-section">
                <div className="manual-sec-head">
                  <h2>{sec.number}. {sec.title}</h2>
                  {isAdmin && <div className="sec-actions">
                    <button className="btn ghost sm" onClick={() => moveSection(si, -1)} disabled={si === 0}>↑</button>
                    <button className="btn ghost sm" onClick={() => moveSection(si, 1)} disabled={si === manual.sections.length - 1}>↓</button>
                  </div>}
                </div>
                {sec.description && <p className="muted">{sec.description}</p>}
                {sec.documents.length === 0 ? <p className="muted" style={{ fontStyle: 'italic' }}>No documents in this section.</p> : (
                  <table className="manual-docs">
                    <tbody>
                      {sec.documents.map((d) => (
                        <tr key={d.docId} id={`doc-${d.docId}`}>
                          <td className="doc-num tnum">{d.number}</td>
                          <td><button className="linklike" onClick={() => setActive(d.docId)}>{d.title}</button>
                            <div className="muted" style={{ fontSize: 12 }}>{d.docType} · {d.storageMode}</div></td>
                          <td>{d.currentVersion
                            ? <StatusPill kind={d.currentVersion.status === 'approved' ? 'ok' : 'warn'}>{d.currentVersion.versionLabel}</StatusPill>
                            : <StatusPill kind="idle">draft</StatusPill>}</td>
                          <td><StatusPill kind={REVIEW_KIND[d.reviewState] || 'idle'}>{d.reviewState}</StatusPill></td>
                          <td>{d.standardRefs.slice(0, 2).map((c) => <span key={c} className="pill st-idle" style={{ marginRight: 3 }}>{c}</span>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            ))}

            {manual.unfiled.length > 0 && (
              <section id="sec-unfiled" className="manual-section">
                <h2 className="muted">Unfiled documents</h2>
                <p className="muted">Assign these to a section to place them in the manual.</p>
                <table className="manual-docs"><tbody>
                  {manual.unfiled.map((d) => (
                    <tr key={d.docId}>
                      <td className="doc-num muted">—</td>
                      <td><button className="linklike" onClick={() => setActive(d.docId)}>{d.title}</button></td>
                      <td>{isAdmin && <button className="btn ghost sm" onClick={() => setPlacing({ docId: d.docId })}>Place in section →</button>}</td>
                    </tr>
                  ))}
                </tbody></table>
              </section>
            )}
          </div>
        </div>
      )}

      {creating && <NewPolicy mkCallable={mkCallable} orgId={orgId} sections={manual.sections}
        onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); setActive(id); }} onErr={setErr} />}
      {addSection && <SectionModal mkCallable={mkCallable}
        onClose={() => setAddSection(false)} onDone={() => { setAddSection(false); load(); }} onErr={setErr} />}
      {placing && <PlaceModal mkCallable={mkCallable} docId={placing.docId} sections={manual.sections}
        onClose={() => setPlacing(null)} onDone={() => { setPlacing(null); load(); }} onErr={setErr} />}
    </>
  );
}

function SectionModal({ mkCallable, onClose, onDone, onErr }) {
  const [title, setTitle] = useState(''); const [description, setDesc] = useState(''); const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim()) return; setBusy(true); onErr('');
    try { await mkCallable('manualSectionCreate')({ title: title.trim(), description }); onDone(); }
    catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="New manual section" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Adding…' : 'Add section'}</button></>}>
      <label className="field"><span>Section title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Infection Prevention & Control" autoFocus /></label>
      <label className="field"><span>Description (optional)</span><input value={description} onChange={(e) => setDesc(e.target.value)} /></label>
    </Modal>
  );
}

function PlaceModal({ mkCallable, docId, sections, onClose, onDone, onErr }) {
  const [sectionId, setSectionId] = useState(sections[0]?.id || ''); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); onErr('');
    try { await mkCallable('policyPlaceInSection')({ docId, sectionId }); onDone(); }
    catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Place in section" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !sectionId}>Place</button></>}>
      <label className="field"><span>Section</span><select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
        {sections.map((s) => <option key={s.id} value={s.id}>{s.number}. {s.title}</option>)}</select></label>
    </Modal>
  );
}

function PolicyDetail({ docId, onBack }) {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [doc, setDoc] = useState(null);
  const [versions, setVersions] = useState([]);
  const [minutes, setMinutes] = useState([]);
  const [modal, setModal] = useState(null); // version | approve
  const [err, setErr] = useState('');

  async function load() {
    try {
      const [dSnap, vSnap] = await Promise.all([
        getDocs(collection(dbc, `orgs/${orgId}/documents`)),
        getDocs(collection(dbc, `orgs/${orgId}/documents/${docId}/versions`)),
      ]);
      const d = dSnap.docs.find((x) => x.id === docId);
      setDoc(d ? { id: d.id, ...d.data() } : null);
      setVersions(vSnap.docs.map((x) => ({ id: x.id, ...x.data() }))
        .sort((a, b) => (b.authoredAt?._seconds || 0) - (a.authoredAt?._seconds || 0)));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { if (orgId) load(); }, [orgId, docId]); // eslint-disable-line

  // GB minutes for approval linkage
  useEffect(() => {
    if (!orgId) return;
    getDocs(collection(dbc, `orgs/${orgId}/evidence`)).then((s) => {
      setMinutes(s.docs.filter((d) => d.get('type') === 'minutes' && d.get('status') === 'finalized')
        .map((d) => ({ id: d.id, title: d.get('title') })));
    }).catch(() => {});
  }, [orgId]);

  if (!doc) return err ? <div className="err">{err}</div> : <Loader />;

  async function call(name, data) {
    setErr('');
    try { await mkCallable(name)({ docId, ...data }); await load(); }
    catch (e) { setErr(e.message); throw e; }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← Policies</button>
          <h1>{doc.title}</h1>
          <p>{doc.docType} · {doc.category} · reviews every {doc.reviewIntervalMonths}mo</p>
        </div>
        {isAdmin && <button className="btn" onClick={() => setModal('version')}>New version</button>}
      </div>
      {err && <div className="err">{err}</div>}

      {isAdmin && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <button className="btn ghost sm" onClick={() => call('policyMarkReviewed', {})}>Mark reviewed (no change)</button>
          <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>Refreshes the review clock without a new version.</span>
        </div>
      )}

      <div className="card">
        <div className="card-pad section-head"><span>Versions ({versions.length})</span></div>
        {versions.length === 0 ? <div className="card-pad muted">No versions yet. Add the first draft.</div> : (
          <table>
            <thead><tr><th>Version</th><th>Status</th><th>Change</th><th></th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{v.versionLabel}
                    {doc.currentVersionId === v.id && <StatusPill kind="ok">current</StatusPill>}</td>
                  <td><StatusPill kind={v.status === 'approved' ? 'ok' : v.status === 'draft' ? 'warn' : 'idle'}>{v.status}</StatusPill></td>
                  <td className="muted">{v.changeSummary || '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {v.storageMode === 'linked' && v.driveLink && <a className="btn ghost sm" href={v.driveLink} target="_blank" rel="noreferrer">Drive ↗</a>}
                    {v.storageMode === 'linked' && v.storagePath && <StorageLink path={v.storagePath} />}
                    {v.storageMode === 'authored' && <button className="btn ghost sm" onClick={() => setModal({ view: v })}>Read</button>}
                    {isAdmin && v.status === 'draft' && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setModal({ approve: v })}>Approve</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal === 'version' && <VersionModal doc={doc} orgId={orgId} onClose={() => setModal(null)}
        onSave={(d) => call('policySaveVersion', d).then(() => setModal(null))} onErr={setErr} />}
      {modal?.view && <Modal title={`${doc.title} — ${modal.view.versionLabel}`} onClose={() => setModal(null)} wide
        footer={<button className="btn ghost" onClick={() => setModal(null)}>Close</button>}>
        {(modal.view.driveLink || doc.inddUrl) &&
          <p style={{ marginBottom: 12 }}><a className="btn ghost sm" href={modal.view.driveLink || doc.inddUrl} target="_blank" rel="noreferrer">Open InDesign source ↗</a></p>}
        {Array.isArray(modal.view.sections) && modal.view.sections.length > 0
          ? modal.view.sections.map((s, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                {s.heading && <h3 style={{ margin: '0 0 4px', color: 'var(--ink)' }}>{s.heading}</h3>}
                <div style={{ whiteSpace: 'pre-wrap' }}>{s.text}</div>
              </div>
            ))
          : <div style={{ whiteSpace: 'pre-wrap' }}>{modal.view.body}</div>}
      </Modal>}
      {modal?.approve && <ApproveModal version={modal.approve} minutes={minutes} onClose={() => setModal(null)}
        onSave={(gbMinutesEvidenceId) => call('documentApproveVersion', { versionId: modal.approve.id, gbMinutesEvidenceId }).then(() => setModal(null))} />}
    </>
  );
}

function Coverage({ orgId }) {
  const mkCallable = useCallableFactory();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!orgId) return;
    mkCallable('requirementCoverage')({}).then(setData).catch((e) => { setErr(e.message); setData({ rows: [] }); });
  }, [orgId]); // eslint-disable-line

  if (!data) return err ? <div className="err">{err}</div> : <Loader label="Computing coverage…" />;
  if (data.rows.length === 0) return <div className="card"><Empty title="No requirements seeded">
    Seed the required-document registry to see coverage against AAAHC's expected set.</Empty></div>;

  const pct = data.total ? Math.round((data.met / data.total) * 100) : 0;
  return (
    <>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: pct >= 80 ? 'var(--ok)' : pct >= 50 ? 'var(--warn)' : 'var(--alert, #dc2626)' }}>{pct}%</div>
          <div><strong>{data.met} of {data.total}</strong> required documents met
            <div className="muted" style={{ fontSize: 13 }}>met = approved current version, not past review</div></div>
        </div>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Required document</th><th>Category</th><th>Standards</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key}>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.title}
                  {!r.required && <span className="muted" style={{ fontWeight: 400 }}> · recommended</span>}
                  {r.docTitle && <div className="muted" style={{ fontWeight: 400 }}>→ {r.docTitle}</div>}</td>
                <td className="muted">{r.category}</td>
                <td>{r.standardRefs.slice(0, 2).map((c) => <span key={c} className="pill st-idle" style={{ marginRight: 4 }}>{c}</span>)}</td>
                <td><StatusPill kind={COVERAGE_KIND[r.status]}>{r.status}</StatusPill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StorageLink({ path }) {
  async function open() {
    try { const u = await getDownloadURL(sref(getStorage(app), path)); window.open(u, '_blank'); } catch { /* ignore */ }
  }
  return <button className="btn ghost sm" onClick={open}>File ↗</button>;
}

function NewPolicy({ mkCallable, orgId, sections = [], onClose, onDone, onErr }) {
  const [f, setF] = useState({ title: '', docType: 'policy', category: 'governance', storageMode: 'authored', reviewIntervalMonths: 12 });
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [sectionId, setSectionId] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [reqs, setReqs] = useState([]);
  const [refs, setRefs] = useState([]);
  const [refCode, setRefCode] = useState('');
  const [allStd, setAllStd] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    getDocs(collection(dbc, `orgs/${orgId}/documentRequirements`)).then((s) =>
      setReqs(s.docs.map((d) => ({ id: d.id, title: d.get('title'), standardRefs: d.get('standardRefs') || [] })))).catch(() => {});
    getDocs(collection(dbc, `standardsEditions/aaahc-2026/standards`)).then((s) =>
      setAllStd(s.docs.map((d) => ({ code: d.get('code'), shortRef: d.get('shortRef') || '' })))).catch(() => {});
  }, [orgId]);

  const suggestions = refCode.trim()
    ? allStd.filter((x) => !refs.some((r) => r.code === x.code))
      .filter((x) => x.code.toLowerCase().includes(refCode.toLowerCase()) || x.shortRef.toLowerCase().includes(refCode.toLowerCase())).slice(0, 6)
    : [];

  // When a requirement is picked, prefill title + standards.
  function pickReq(id) {
    setRequirementId(id);
    const r = reqs.find((x) => x.id === id);
    if (r) { setF((cur) => ({ ...cur, title: cur.title || r.title })); setRefs(r.standardRefs.map((x) => ({ editionId: x.editionId, code: x.code }))); }
  }

  async function save() {
    if (!f.title.trim()) return;
    setBusy(true); onErr('');
    try {
      const r = await mkCallable('policyCreate')({ ...f, standardRefs: refs, requirementId: requirementId || null });
      if (sectionId) await mkCallable('policyPlaceInSection')({ docId: r.docId, sectionId });
      onDone(r.docId);
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="New policy" onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !f.title.trim()}>{busy ? 'Creating…' : 'Create'}</button></>}>
      {reqs.length > 0 && <label className="field"><span>Satisfies required document (optional)</span>
        <select value={requirementId} onChange={(e) => pickReq(e.target.value)}>
          <option value="">— none / custom —</option>
          {reqs.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>}
      <label className="field"><span>Title</span><input value={f.title} onChange={s('title')} autoFocus /></label>
      {sections.length > 0 && <label className="field"><span>Manual section</span>
        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
          <option value="">— unfiled —</option>
          {sections.map((sec) => <option key={sec.id} value={sec.id}>{sec.number}. {sec.title}</option>)}</select></label>}
      <div className="grid2">
        <label className="field"><span>Type</span><select value={f.docType} onChange={s('docType')}>{DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="field"><span>Category</span><select value={f.category} onChange={s('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <div className="grid2">
        <label className="field"><span>Content</span><select value={f.storageMode} onChange={s('storageMode')}>
          <option value="authored">Authored in-app</option><option value="linked">Linked (Drive / file)</option></select></label>
        <label className="field"><span>Review every (months)</span><input type="number" value={f.reviewIntervalMonths} onChange={s('reviewIntervalMonths')} /></label>
      </div>
      <div className="field"><span>Standards</span>
        <div style={{ position: 'relative' }}>
          <input placeholder="Search code or topic" value={refCode} onChange={(e) => setRefCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && suggestions[0]) { e.preventDefault(); setRefs((r) => [...r, { editionId: 'aaahc-2026', code: suggestions[0].code }]); setRefCode(''); } }} />
          {suggestions.length > 0 && <div className="ac-dropdown">
            {suggestions.map((x) => <button key={x.code} className="ac-item" onClick={() => { setRefs((r) => [...r, { editionId: 'aaahc-2026', code: x.code }]); setRefCode(''); }}>
              <span className="std-code tnum">{x.code}</span><span className="ac-ref">{x.shortRef}</span></button>)}
          </div>}
        </div>
        {refs.length > 0 && <div style={{ marginTop: 6 }}>{refs.map((r, i) => <span key={i} className="pill st-idle" style={{ marginRight: 4 }}
          onClick={() => setRefs((x) => x.filter((_, j) => j !== i))}>{r.code} ✕</span>)}</div>}
      </div>
    </Modal>
  );
}

function VersionModal({ doc, orgId, onClose, onSave, onErr }) {
  const [mode, setMode] = useState(doc.storageMode || 'authored');
  const [versionLabel, setLabel] = useState('1.0');
  const [changeSummary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [driveLink, setDriveLink] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); onErr('');
    try {
      const payload = { versionLabel, changeSummary, storageMode: mode };
      if (mode === 'authored') payload.body = body;
      else {
        if (file) {
          const path = `orgs/${orgId}/documents/${doc.id}/${Date.now()}_${file.name}`;
          await new Promise((res, rej) => {
            const t = uploadBytesResumable(sref(getStorage(app), path), file, { contentType: file.type });
            t.on('state_changed', null, rej, res);
          });
          payload.storagePath = path;
        }
        if (driveLink) {
          payload.driveLink = driveLink;
          const m = driveLink.match(/[-\w]{25,}/); if (m) payload.driveFileId = m[0];
        }
      }
      await onSave(payload);
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="New version" onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button></>}>
      <div className="grid2">
        <label className="field"><span>Version label</span><input value={versionLabel} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="field"><span>Content mode</span><select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="authored">Authored in-app</option><option value="linked">Linked (Drive / file)</option></select></label>
      </div>
      <label className="field"><span>Change summary</span><input value={changeSummary} onChange={(e) => setSummary(e.target.value)} placeholder="What changed in this version" /></label>
      {mode === 'authored' ? (
        <label className="field"><span>Policy text</span><textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      ) : (
        <>
          <label className="field"><span>Google Drive link (or paste a Doc URL)</span><input value={driveLink} onChange={(e) => setDriveLink(e.target.value)} placeholder="https://docs.google.com/document/d/…" /></label>
          <label className="field"><span>…or upload a file</span><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        </>
      )}
    </Modal>
  );
}

function ApproveModal({ version, minutes, onClose, onSave }) {
  const [gb, setGb] = useState('');
  return (
    <Modal title={`Approve version ${version.versionLabel}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave(gb || null)}>Approve</button></>}>
      <p className="muted" style={{ marginBottom: 12 }}>Approval makes this the current version, supersedes the prior one, and starts the review clock. Optionally link the governing-body minutes that approved it.</p>
      <label className="field"><span>Governing-body minutes (optional)</span>
        <select value={gb} onChange={(e) => setGb(e.target.value)}>
          <option value="">— none —</option>
          {minutes.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
    </Modal>
  );
}
