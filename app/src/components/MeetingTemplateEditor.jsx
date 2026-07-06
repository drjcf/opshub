// src/components/MeetingTemplateEditor.jsx — build/edit a committee's agenda.
// Sections are typed (text, attendance, priorMinutes, qiReview, actionItems,
// checklist, vote); the editor lets you add, reorder, retitle, and mark required.
import { useState } from 'react';
import { Modal } from './ui.jsx';

const TYPE_OPTS = [
  { v: 'text', label: 'Text (narrative)' },
  { v: 'attendance', label: 'Attendance & quorum' },
  { v: 'priorMinutes', label: 'Approve prior minutes' },
  { v: 'qiReview', label: 'QI study review' },
  { v: 'actionItems', label: 'Action items' },
  { v: 'checklist', label: 'Checklist (yes/no)' },
  { v: 'vote', label: 'Motion / vote' },
];

let sid = 0;
const newSection = (type = 'text', title = '') => ({ _id: ++sid, title, type, prompt: '', required: false });

// A sensible default agenda for a new template.
const DEFAULT_SECTIONS = () => [
  { ...newSection('text', 'Call to Order'), required: true },
  newSection('attendance', 'Attendance'),
  newSection('priorMinutes', 'Approval of Prior Minutes'),
  newSection('qiReview', 'Quality Improvement Review'),
  newSection('text', 'Old Business'),
  newSection('text', 'New Business'),
  newSection('actionItems', 'Action Items'),
  { ...newSection('text', 'Adjournment'), required: true },
];

export default function MeetingTemplateEditor({ existing, mkCallable, onClose, onDone, onErr }) {
  const [name, setName] = useState(existing?.name || '');
  const [sections, setSections] = useState(
    existing?.sections?.map((s) => ({ _id: ++sid, ...s })) || DEFAULT_SECTIONS());
  const [busy, setBusy] = useState(false);

  const upd = (id, patch) => setSections((ss) => ss.map((s) => s._id === id ? { ...s, ...patch } : s));
  const move = (id, dir) => setSections((ss) => {
    const i = ss.findIndex((s) => s._id === id); const j = i + dir;
    if (j < 0 || j >= ss.length) return ss;
    const c = [...ss]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  async function save() {
    if (!name.trim() || sections.length === 0) return;
    setBusy(true); onErr('');
    try {
      const r = await mkCallable('meetingTemplateSave')({
        templateId: existing?.id || undefined,
        name: name.trim(),
        sections: sections.map((s) => ({ key: s.key, title: s.title, type: s.type, prompt: s.prompt, required: s.required })),
      });
      onDone(r);
    } catch (e) { onErr(e.message); setBusy(false); }
  }

  return (
    <Modal title={existing ? 'Edit meeting template' : 'New meeting template'} onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save template'}</button></>}>
      <label className="field"><span>Template name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard QI Committee Agenda" autoFocus /></label>

      <div className="builder-section">
        <div className="builder-head"><span>Agenda sections</span>
          <button className="btn ghost sm" onClick={() => setSections((s) => [...s, newSection()])}>+ Add section</button></div>
        {sections.map((s, idx) => (
          <div key={s._id} className="field-row">
            <div className="field-row-top">
              <input className="fr-label" value={s.title} placeholder="Section title"
                onChange={(e) => upd(s._id, { title: e.target.value })} />
              <select value={s.type} onChange={(e) => upd(s._id, { type: e.target.value })}>
                {TYPE_OPTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
              <label className="fr-req"><input type="checkbox" checked={s.required}
                onChange={(e) => upd(s._id, { required: e.target.checked })} /> req</label>
              <button className="btn ghost sm" onClick={() => move(s._id, -1)} disabled={idx === 0}>↑</button>
              <button className="btn ghost sm" onClick={() => move(s._id, 1)} disabled={idx === sections.length - 1}>↓</button>
              <button className="btn ghost sm" onClick={() => setSections((ss) => ss.filter((x) => x._id !== s._id))}>✕</button>
            </div>
            <div className="fr-extra">
              <input placeholder="Prompt / guidance for the minute-taker (optional)" value={s.prompt}
                onChange={(e) => upd(s._id, { prompt: e.target.value })} style={{ flex: 1 }} />
            </div>
          </div>
        ))}
        <div className="muted" style={{ fontSize: 12 }}>Section types drive how each part of the minutes is captured — attendance computes quorum, action items become tracked tasks, QI review links studies.</div>
      </div>
    </Modal>
  );
}
