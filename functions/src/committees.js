// functions/src/committees.js — committees & meeting minutes (governance loop).
// Committees run templated meetings; minutes finalize as immutable evidence and
// spawn action-item tasks. Templates are editable via meetingTemplate.save.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, audit, auditDirect,
} from './util.js';

const SECTION_TYPES = ['text', 'attendance', 'priorMinutes', 'qiReview', 'actionItems', 'checklist', 'vote'];

// ---------------- committee.create ----------------
export const committeeCreate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, name, purpose, cadence, members, chairUid, templateId, standardRefs } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!name) throw new HttpsError('invalid-argument', 'Committee name required.');
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/committees`).doc();
  await ref.set({
    name, purpose: purpose || '', cadence: cadence || 'monthly',
    members: Array.isArray(members) ? members : [],
    chairUid: chairUid || null, templateId: templateId || null,
    standardRefs: Array.isArray(standardRefs) ? standardRefs : [],
    status: 'active', createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'committee.create', ref.path, null, { name }, who);
  return { committeeId: ref.id };
});

// ---------------- committee.update ----------------
export const committeeUpdate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, committeeId, ...patch } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const allowed = {};
  for (const k of ['name', 'purpose', 'cadence', 'members', 'chairUid', 'templateId', 'standardRefs', 'status']) {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  }
  await db.doc(`orgs/${orgId}/committees/${committeeId}`).set(allowed, { merge: true });
  await auditDirect(orgId, 'committee.update', `orgs/${orgId}/committees/${committeeId}`, null, allowed, who);
  return { ok: true };
});

// ---------------- meetingTemplate.save (create or edit) ----------------
// Backs the template EDITOR. Validates the agenda structure server-side.
export const meetingTemplateSave = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, templateId, name, sections } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!name) throw new HttpsError('invalid-argument', 'Template name required.');
  if (!Array.isArray(sections) || sections.length === 0) throw new HttpsError('invalid-argument', 'At least one section required.');
  const who = actor(auth);

  // Validate + normalize each section.
  const seen = new Set();
  const normSections = sections.map((s, i) => {
    if (!SECTION_TYPES.includes(s.type)) throw new HttpsError('invalid-argument', `Section ${i}: bad type.`);
    const title = String(s.title || '').trim().slice(0, 120);
    if (!title) throw new HttpsError('invalid-argument', `Section ${i}: title required.`);
    let key = String(s.key || title).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    while (seen.has(key)) key += '_2';
    seen.add(key);
    return { key, title, type: s.type, prompt: String(s.prompt || '').slice(0, 300), required: !!s.required };
  });

  const ref = templateId
    ? db.doc(`orgs/${orgId}/meetingTemplates/${templateId}`)
    : db.collection(`orgs/${orgId}/meetingTemplates`).doc();

  const cur = templateId ? await ref.get() : null;
  await ref.set({
    name: String(name).trim(), sections: normSections,
    version: (cur?.get('version') || 0) + 1, active: true,
    createdBy: cur?.get('createdBy') || who, updatedBy: who, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await auditDirect(orgId, 'meetingTemplate.save', ref.path, null, { name, sections: normSections.length }, who);
  return { templateId: ref.id, version: (cur?.get('version') || 0) + 1 };
});

// ---------------- meetingTemplate.retire ----------------
export const meetingTemplateRetire = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, templateId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/meetingTemplates/${templateId}`).set({ active: false }, { merge: true });
  await auditDirect(orgId, 'meetingTemplate.retire', `orgs/${orgId}/meetingTemplates/${templateId}`, null, {}, who);
  return { ok: true };
});

// ---------------- meeting.create ----------------
// Snapshots the template so the agenda is frozen for this meeting.
export const meetingCreate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, committeeId, templateId, date, location } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  const committee = await db.doc(`orgs/${orgId}/committees/${committeeId}`).get();
  if (!committee.exists) throw new HttpsError('not-found', 'Committee not found.');

  const tId = templateId || committee.get('templateId');
  let templateSnapshot = { sections: [] };
  if (tId) {
    const t = await db.doc(`orgs/${orgId}/meetingTemplates/${tId}`).get();
    if (t.exists) templateSnapshot = { sections: t.get('sections') || [] };
  }

  // Seed attendance from the committee roster.
  const attendance = (committee.get('members') || []).map((m) => ({ uid: m.uid, name: m.name, status: 'absent' }));

  const ref = db.collection(`orgs/${orgId}/committees/${committeeId}/meetings`).doc();
  await ref.set({
    templateId: tId || null, templateSnapshot,
    date: date ? Timestamp.fromMillis(new Date(date).getTime()) : FieldValue.serverTimestamp(),
    location: location || '', attendance, quorumMet: false,
    sections: {}, reviewedStudyIds: [], reviewedIncidentIds: [], actionItems: [],
    priorMinutesApproved: null, status: 'draft', minutesEvidenceId: null,
    chairUid: committee.get('chairUid') || null, secretaryUid: null,
    createdBy: who, createdAt: FieldValue.serverTimestamp(),
    finalizedBy: null, finalizedAt: null,
  });
  await auditDirect(orgId, 'meeting.create', ref.path, null, { committeeId }, who);
  return { meetingId: ref.id, templateSnapshot };
});

// ---------------- meeting.saveSection ----------------
export const meetingSaveSection = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, committeeId, meetingId, sectionKey, content, reviewedStudyIds, reviewedIncidentIds, actionItems } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/committees/${committeeId}/meetings/${meetingId}`);
  const m = await ref.get();
  if (!m.exists) throw new HttpsError('not-found', 'Meeting not found.');
  if (m.get('status') === 'finalized') throw new HttpsError('failed-precondition', 'Minutes are finalized.');

  const patch = { [`sections.${sectionKey}`]: content ?? {} };
  if (reviewedStudyIds) patch.reviewedStudyIds = reviewedStudyIds;
  if (reviewedIncidentIds) patch.reviewedIncidentIds = reviewedIncidentIds;
  if (actionItems) patch.actionItems = actionItems;
  await ref.update(patch);
  return { ok: true };
});

// ---------------- meeting.setAttendance ----------------
export const meetingSetAttendance = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, committeeId, meetingId, attendance } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  const ref = db.doc(`orgs/${orgId}/committees/${committeeId}/meetings/${meetingId}`);
  const present = (attendance || []).filter((a) => a.status === 'present').length;
  const total = (attendance || []).length;
  const quorumMet = total > 0 && present > total / 2;   // simple majority quorum
  await ref.update({ attendance: attendance || [], quorumMet });
  return { ok: true, quorumMet, present, total };
});

// ---------------- meeting.finalizeMinutes ----------------
// The governance-completeness guard + evidence finalization + action-item tasks.
export const meetingFinalizeMinutes = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, committeeId, meetingId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  const ref = db.doc(`orgs/${orgId}/committees/${committeeId}/meetings/${meetingId}`);
  const [meeting, committee] = await Promise.all([
    ref.get(), db.doc(`orgs/${orgId}/committees/${committeeId}`).get(),
  ]);
  if (!meeting.exists) throw new HttpsError('not-found', 'Meeting not found.');
  if (meeting.get('status') === 'finalized') throw new HttpsError('failed-precondition', 'Already finalized.');

  // Governance-completeness guard.
  const problems = [];
  const attendance = meeting.get('attendance') || [];
  if (attendance.length === 0) problems.push('no attendance recorded');
  const chairPresent = attendance.some((a) => a.uid === meeting.get('chairUid') && a.status === 'present');
  if (!chairPresent) problems.push('chair not marked present');
  const snapshot = meeting.get('templateSnapshot') || { sections: [] };
  const sections = meeting.get('sections') || {};
  for (const s of snapshot.sections) {
    if (s.required && s.type === 'text' && !(sections[s.key]?.text || '').trim()) {
      problems.push(`required section "${s.title}" empty`);
    }
  }
  if (problems.length) throw new HttpsError('failed-precondition', `Cannot finalize: ${problems.join('; ')}.`);

  const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
  const spawnedTaskIds = [];

  await db.runTransaction(async (tx) => {
    // Minutes as immutable evidence.
    tx.set(evRef, {
      type: 'minutes',
      title: `Minutes: ${committee.get('name')} — ${new Date().toISOString().slice(0, 10)}`,
      standardRefs: committee.get('standardRefs') || [],
      obligationId: null, taskId: null,
      payload: {
        committeeId, meetingId,
        attendance, quorumMet: meeting.get('quorumMet'),
        sections, reviewedStudyIds: meeting.get('reviewedStudyIds') || [],
        reviewedIncidentIds: meeting.get('reviewedIncidentIds') || [],
        priorMinutesApproved: meeting.get('priorMinutesApproved'),
      },
      attachments: [], status: 'finalized',
      finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
      supersededBy: null, supersedes: null,
      createdBy: who, createdAt: FieldValue.serverTimestamp(),
    });

    // Materialize action items as tracked tasks.
    for (const ai of (meeting.get('actionItems') || [])) {
      if (!ai.description) continue;
      const tRef = db.collection(`orgs/${orgId}/tasks`).doc();
      tx.set(tRef, {
        obligationId: null,
        title: `Committee action: ${ai.description}`,
        standardRefs: committee.get('standardRefs') || [],
        checkpointId: null,
        dueAt: ai.dueDate ? Timestamp.fromMillis(new Date(ai.dueDate).getTime()) : Timestamp.fromMillis(Date.now() + 14 * 864e5),
        status: 'open',
        assignedUid: ai.assignedTo?.uid || null,
        assignedRole: ai.assignedTo ? null : 'clinicalDirector',
        source: 'committee-action', sourceMeetingId: meetingId,
        generatedAt: FieldValue.serverTimestamp(),
      });
      spawnedTaskIds.push(tRef.id);
    }

    tx.update(ref, {
      status: 'finalized', minutesEvidenceId: evRef.id,
      finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
    });
    audit(tx, orgId, 'meeting.finalizeMinutes', ref.path, null, { evidenceId: evRef.id, tasks: spawnedTaskIds.length }, who);
  });

  return { ok: true, minutesEvidenceId: evRef.id, actionTasksCreated: spawnedTaskIds.length };
});
