// functions/src/logs-hub.js — the Logs & Checklists management view.
// Assembles every checklist/log obligation with its cadence, last completion,
// and provides a history query per obligation. Read-only aggregation.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, requireAuth, requireOrg, requireRole,
} from './util.js';

// ---------------- logsHub.roster ----------------
// All active obligations of type checklist/register, each with its template,
// cadence, and most-recent completion (from evidence).
export const logsHubRoster = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  const oblSnap = await db.collection(`orgs/${orgId}/obligations`)
    .where('status', '==', 'active').get();

  const obligations = oblSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((o) => ['checklist', 'register'].includes(o.evidenceType));

  // Most-recent finalized evidence per obligation (by obligationId link).
  // Evidence carries obligationId when materialized from an obligation's task.
  const evSnap = await db.collection(`orgs/${orgId}/evidence`)
    .where('status', '==', 'finalized').limit(1000).get();
  const lastByObligation = {};
  for (const e of evSnap.docs) {
    const oid = e.get('obligationId');
    if (!oid) continue;
    const fa = e.get('finalizedAt');
    const ms = fa?._seconds ? fa._seconds * 1000 : (fa?.toMillis ? fa.toMillis() : 0);
    if (!lastByObligation[oid] || ms > lastByObligation[oid].ms) {
      lastByObligation[oid] = { ms, evidenceId: e.id, by: e.get('createdBy')?.displayNameSnapshot || null };
    }
  }

  // Open task count per obligation (what's currently due/overdue).
  const taskSnap = await db.collection(`orgs/${orgId}/tasks`)
    .where('status', 'in', ['open', 'missed']).limit(1000).get();
  const openByObligation = {};
  for (const t of taskSnap.docs) {
    const oid = t.get('obligationId');
    if (oid) openByObligation[oid] = (openByObligation[oid] || 0) + 1;
  }

  const rows = obligations.map((o) => ({
    obligationId: o.id,
    title: o.title,
    evidenceType: o.evidenceType,
    cadence: o.cadence || '',
    catalogId: o.catalogId || null,
    templateId: o.checklistTemplateId || null,
    checkpointId: o.checkpointId || null,
    requireScan: !!o.requireScan,
    standardRefs: (o.standardRefs || []).map((r) => r.code || r.standardId).filter(Boolean),
    lastCompletedMs: lastByObligation[o.id]?.ms || null,
    lastCompletedBy: lastByObligation[o.id]?.by || null,
    openCount: openByObligation[o.id] || 0,
  })).sort((a, b) => a.title.localeCompare(b.title));

  return { rows, count: rows.length };
});

// ---------------- logsHub.history ----------------
// Completion history for one obligation (finalized evidence, newest first).
export const logsHubHistory = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, obligationId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!obligationId) throw new HttpsError('invalid-argument', 'obligationId required.');

  const snap = await db.collection(`orgs/${orgId}/evidence`)
    .where('obligationId', '==', obligationId)
    .where('status', '==', 'finalized')
    .limit(200).get();

  const rows = snap.docs.map((d) => {
    const fa = d.get('finalizedAt');
    return {
      evidenceId: d.id,
      finalizedMs: fa?._seconds ? fa._seconds * 1000 : (fa?.toMillis ? fa.toMillis() : 0),
      by: d.get('createdBy')?.displayNameSnapshot || null,
      outOfRange: d.get('outOfRange') || false,
      lateEvidence: d.get('lateEvidence') || false,
      title: d.get('title') || null,
    };
  }).sort((a, b) => b.finalizedMs - a.finalizedMs);

  return { rows, count: rows.length };
});
