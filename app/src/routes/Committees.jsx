// src/routes/Committees.jsx — committees & meeting minutes.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, doc } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';
import MeetingTemplateEditor from '../components/MeetingTemplateEditor.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { exportToDoc } from '../lib/googleExport.js';
import { minutesDoc } from '../lib/exportContent.js';

export default function Committees() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [committees, setCommittees] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [active, setActive] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const u1 = onSnapshot(query(collection(dbc, `orgs/${orgId}/committees`), orderBy('createdAt', 'desc')),
      (s) => setCommittees(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => setErr(e.message));
    const u2 = onSnapshot(collection(dbc, `orgs/${orgId}/meetingTemplates`),
      (s) => setTemplates(s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.active !== false)));
    return () => { u1(); u2(); };
  }, [orgId]);

  if (active) return <CommitteeView committeeId={active} templates={templates} onBack={() => setActive(null)} />;

  return (
    <>
      <div className="page-head">
        <div><h1>Committees</h1><p>Governance committees, meetings, and minutes.</p></div>
        {isAdmin && <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={() => setEditingTemplate(null)}>New template</button>
          <button className="btn" onClick={() => setCreating(true)}>New committee</button>
        </div>}
      </div>
      {err && <div className="err">{err}</div>}

      {templates.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-pad section-head"><span>Meeting templates ({templates.length})</span></div>
          <table><tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{t.name}
                  <div className="muted" style={{ fontWeight: 400 }}>{(t.sections || []).length} sections · v{t.version}</div></td>
                <td style={{ textAlign: 'right' }}>{isAdmin &&
                  <button className="btn ghost sm" onClick={() => setEditingTemplate(t)}>Edit</button>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}

      {committees === null ? <Loader /> : committees.length === 0 ? (
        <div className="card"><Empty title="No committees yet">Create a committee, then hold templated meetings and finalize minutes.</Empty></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Committee</th><th>Cadence</th><th>Members</th><th></th></tr></thead>
            <tbody>
              {committees.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.name}
                    <div className="muted" style={{ fontWeight: 400 }}>{c.purpose}</div></td>
                  <td className="muted">{c.cadence}</td>
                  <td className="muted">{(c.members || []).length}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => setActive(c.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <NewCommittee mkCallable={mkCallable} templates={templates}
        onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); setActive(id); }} onErr={setErr} />}
      {editingTemplate !== undefined && <MeetingTemplateEditor existing={editingTemplate}
        mkCallable={mkCallable} onClose={() => setEditingTemplate(undefined)}
        onDone={() => setEditingTemplate(undefined)} onErr={setErr} />}
    </>
  );
}

function CommitteeView({ committeeId, templates, onBack }) {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [committee, setCommittee] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [activeMeeting, setActiveMeeting] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const base = `orgs/${orgId}/committees/${committeeId}`;
    const u0 = onSnapshot(doc(dbc, base), (d) => setCommittee({ id: d.id, ...d.data() }));
    const u1 = onSnapshot(query(collection(dbc, `${base}/meetings`), orderBy('date', 'desc')),
      (s) => setMeetings(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => { u0(); u1(); };
  }, [orgId, committeeId]);

  if (!committee) return <Loader />;
  if (activeMeeting) return <MeetingView committeeId={committeeId} meetingId={activeMeeting}
    committee={committee} onBack={() => setActiveMeeting(null)} />;

  async function newMeeting() {
    setErr('');
    try {
      const r = await mkCallable('meetingCreate')({ committeeId, date: new Date().toISOString() });
      setActiveMeeting(r.meetingId);
    } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← Committees</button>
          <h1>{committee.name}</h1><p>{committee.purpose}</p>
        </div>
        {isAdmin && <button className="btn" onClick={newMeeting}>New meeting</button>}
      </div>
      {err && <div className="err">{err}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-pad section-head"><span>Members ({(committee.members || []).length})</span></div>
        <div className="card-pad">
          {(committee.members || []).map((m) => (
            <span key={m.uid} className="pill st-idle" style={{ marginRight: 6 }}>
              {m.name}{m.uid === committee.chairUid ? ' · chair' : ''}</span>
          ))}
          {(committee.members || []).length === 0 && <span className="muted">No members yet.</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-pad section-head"><span>Meetings ({meetings.length})</span></div>
        {meetings.length === 0 ? <div className="card-pad muted">No meetings held.</div> : (
          <table>
            <thead><tr><th>Date</th><th>Quorum</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {meetings.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600, color: 'var(--ink)' }}>
                    {m.date?._seconds ? new Date(m.date._seconds * 1000).toLocaleDateString() : 'draft'}</td>
                  <td>{m.quorumMet ? <StatusPill kind="ok">quorum</StatusPill> : <StatusPill kind="idle">no quorum</StatusPill>}</td>
                  <td><StatusPill kind={m.status === 'finalized' ? 'ok' : 'warn'}>{m.status}</StatusPill></td>
                  <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => setActiveMeeting(m.id)}>
                    {m.status === 'finalized' ? 'View' : 'Open'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function MeetingView({ committeeId, meetingId, committee, onBack }) {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [meeting, setMeeting] = useState(null);
  const [studies, setStudies] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState('');

  useEffect(() => {
    if (!orgId) return;
    const u0 = onSnapshot(doc(dbc, `orgs/${orgId}/committees/${committeeId}/meetings/${meetingId}`),
      (d) => setMeeting({ id: d.id, ...d.data() }), (e) => setErr(e.message));
    const u1 = onSnapshot(collection(dbc, `orgs/${orgId}/qiStudies`),
      (s) => setStudies(s.docs.map((d) => ({ id: d.id, title: d.get('title'), status: d.get('status') }))));
    return () => { u0(); u1(); };
  }, [orgId, committeeId, meetingId]);

  if (!meeting) return <Loader />;
  const finalized = meeting.status === 'finalized';
  const sections = meeting.templateSnapshot?.sections || [];

  async function saveSection(key, content) {
    setSaving(key);
    try { await mkCallable('meetingSaveSection')({ committeeId, meetingId, sectionKey: key, content }); }
    catch (e) { setErr(e.message); }
    setSaving('');
  }
  async function setAttendance(attendance) {
    try { await mkCallable('meetingSetAttendance')({ committeeId, meetingId, attendance }); }
    catch (e) { setErr(e.message); }
  }
  async function saveActionItems(actionItems) {
    try { await mkCallable('meetingSaveSection')({ committeeId, meetingId, sectionKey: '_actions', content: {}, actionItems }); }
    catch (e) { setErr(e.message); }
  }
  async function saveReviewedStudies(ids) {
    try { await mkCallable('meetingSaveSection')({ committeeId, meetingId, sectionKey: '_qi', content: {}, reviewedStudyIds: ids }); }
    catch (e) { setErr(e.message); }
  }
  async function finalize() {
    setErr('');
    try {
      const r = await mkCallable('meetingFinalizeMinutes')({ committeeId, meetingId });
      setErr(''); // success — snapshot updates via listener
      if (r.actionTasksCreated) alert(`Minutes finalized. ${r.actionTasksCreated} action task(s) created.`);
    } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 6 }}>← {committee.name}</button>
          <h1>Meeting minutes</h1>
          <p>{meeting.date?._seconds ? new Date(meeting.date._seconds * 1000).toLocaleString() : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {finalized && <ExportButton label="Export minutes" ghost build={() => exportToDoc(`Minutes - ${committee.name}`, minutesDoc(committee, meeting))} />}
          <StatusPill kind={finalized ? 'ok' : 'warn'}>{meeting.status}</StatusPill>
        </div>
      </div>
      {err && <div className="err">{err}</div>}

      {sections.map((s) => (
        <div key={s.key} className="card" style={{ marginBottom: 14 }}>
          <div className="card-pad section-head">
            <span>{s.title}{s.required && ' *'}</span>
            <span className="muted" style={{ fontSize: 12 }}>{s.type}</span>
          </div>
          <div className="card-pad">
            {s.prompt && <p className="muted" style={{ marginBottom: 8, fontSize: 13 }}>{s.prompt}</p>}
            <SectionBody section={s} meeting={meeting} studies={studies} finalized={finalized}
              onSaveText={(text) => saveSection(s.key, { text })}
              onSetAttendance={setAttendance} onSaveActions={saveActionItems}
              onSaveStudies={saveReviewedStudies} saving={saving === s.key} />
          </div>
        </div>
      ))}

      {!finalized && isAdmin && (
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <button className="btn" onClick={finalize}>Finalize minutes → evidence</button>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Requires attendance, chair present, and required sections filled.</p>
        </div>
      )}
      {finalized && <div className="card card-pad" style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>
        <StatusPill kind="ok">Minutes finalized as evidence</StatusPill></div>}
    </>
  );
}

function SectionBody({ section, meeting, studies, finalized, onSaveText, onSetAttendance, onSaveActions, onSaveStudies, saving }) {
  const [text, setText] = useState(meeting.sections?.[section.key]?.text || '');

  if (section.type === 'attendance') {
    return <Attendance attendance={meeting.attendance || []} finalized={finalized}
      quorumMet={meeting.quorumMet} onSet={onSetAttendance} />;
  }
  if (section.type === 'actionItems') {
    return <ActionItems items={meeting.actionItems || []} finalized={finalized} onSave={onSaveActions} />;
  }
  if (section.type === 'qiReview') {
    return <QIReview studies={studies} selected={meeting.reviewedStudyIds || []} finalized={finalized} onSave={onSaveStudies} />;
  }
  // text / priorMinutes / checklist / vote → narrative capture (simple text)
  return (
    <div>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={finalized}
        placeholder={finalized ? '' : 'Enter minutes for this section…'} style={{ width: '100%' }} />
      {!finalized && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => onSaveText(text)}>
        {saving ? 'Saving…' : 'Save section'}</button>}
    </div>
  );
}

function Attendance({ attendance, finalized, quorumMet, onSet }) {
  const [list, setList] = useState(attendance);
  const cycle = (uid) => {
    const order = ['absent', 'present', 'excused'];
    setList((l) => l.map((a) => a.uid === uid ? { ...a, status: order[(order.indexOf(a.status) + 1) % 3] } : a));
  };
  return (
    <div>
      {list.length === 0 ? <span className="muted">No committee members to take attendance for.</span> : list.map((a) => (
        <button key={a.uid} className={`rating-opt ${a.status === 'present' ? 'sel' : ''}`} disabled={finalized}
          style={{ marginRight: 6, marginBottom: 6 }} onClick={() => cycle(a.uid)}>
          {a.name}: {a.status}</button>
      ))}
      {!finalized && <div style={{ marginTop: 8 }}>
        <button className="btn ghost sm" onClick={() => onSet(list)}>Save attendance</button>
        <span className="muted" style={{ marginLeft: 10 }}>{quorumMet ? '✓ quorum met' : 'quorum not met'}</span>
      </div>}
    </div>
  );
}

function ActionItems({ items, finalized, onSave }) {
  const [list, setList] = useState(items);
  const [desc, setDesc] = useState('');
  return (
    <div>
      {list.map((it, i) => (
        <div key={i} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span>{it.description}</span>
          {!finalized && <button className="btn ghost sm" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {!finalized && <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="New action item" style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => { if (desc.trim()) { const l = [...list, { description: desc.trim() }]; setList(l); setDesc(''); } }}>Add</button>
        <button className="btn sm" onClick={() => onSave(list)}>Save</button>
      </div>}
      {!finalized && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Action items become tracked tasks when minutes are finalized.</p>}
    </div>
  );
}

function QIReview({ studies, selected, finalized, onSave }) {
  const [sel, setSel] = useState(selected);
  const toggle = (id) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  return (
    <div>
      {studies.length === 0 ? <span className="muted">No QI studies to review.</span> : studies.map((st) => (
        <label key={st.id} className="row" style={{ padding: '3px 0' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(st.id)} disabled={finalized} onChange={() => toggle(st.id)} />
          <span>{st.title} <span className="muted">· {st.status}</span></span>
        </label>
      ))}
      {!finalized && studies.length > 0 && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => onSave(sel)}>Save reviewed studies</button>}
    </div>
  );
}

function NewCommittee({ mkCallable, templates, onClose, onDone, onErr }) {
  const [name, setName] = useState(''); const [purpose, setPurpose] = useState('');
  const [cadence, setCadence] = useState('monthly'); const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim()) return;
    setBusy(true); onErr('');
    try {
      const r = await mkCallable('committeeCreate')({ name: name.trim(), purpose, cadence, templateId: templateId || null });
      onDone(r.committeeId);
    } catch (e) { onErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="New committee" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button></>}>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Quality Improvement Committee" autoFocus /></label>
      <label className="field"><span>Purpose</span><input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label>
      <div className="grid2">
        <label className="field"><span>Cadence</span><select value={cadence} onChange={(e) => setCadence(e.target.value)}>
          <option value="monthly">monthly</option><option value="quarterly">quarterly</option>
          <option value="annual">annual</option><option value="ad-hoc">ad-hoc</option></select></label>
        <label className="field"><span>Default template</span><select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">None</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Add members after creating — you can assign the chair and roster from the committee page.</p>
    </Modal>
  );
}
