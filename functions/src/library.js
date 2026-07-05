// functions/src/library.js — document library (general archive) callables.
// Complements the existing controlled-document backend. Files land in GCS
// (client upload), metadata + search tokens recorded here. Nothing hard-deletes.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue,
  requireAuth, requireOrg, requireRole, actor, auditDirect,
} from './util.js';

// Build lowercased search tokens from title + tags + folder path.
function buildTokens(title, tags, folderPath) {
  const words = String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const tagToks = (tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const pathToks = String(folderPath || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  return [...new Set([...words, ...tagToks, ...pathToks])].slice(0, 60);
}

// ---------------- library.createFolder ----------------
export const libraryCreateFolder = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, name, parentId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  if (!name) throw new HttpsError('invalid-argument', 'Folder name required.');
  const who = actor(auth);

  let path = `/${name}`;
  if (parentId) {
    const parent = await db.doc(`orgs/${orgId}/folders/${parentId}`).get();
    if (!parent.exists) throw new HttpsError('not-found', 'Parent folder missing.');
    path = `${parent.get('path')}/${name}`;
  }
  const ref = db.collection(`orgs/${orgId}/folders`).doc();
  await ref.set({
    name, parentId: parentId || null, path,
    order: Date.now(), createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'library.createFolder', ref.path, null, { name, path }, who);
  return { folderId: ref.id, path };
});

// ---------------- library.renameFolder ----------------
export const libraryRenameFolder = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, folderId, name } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/folders/${folderId}`);
  const cur = await ref.get();
  if (!cur.exists) throw new HttpsError('not-found', 'Folder not found.');
  const parentPath = cur.get('parentId')
    ? (await db.doc(`orgs/${orgId}/folders/${cur.get('parentId')}`).get()).get('path')
    : '';
  await ref.set({ name, path: `${parentPath}/${name}` }, { merge: true });
  await auditDirect(orgId, 'library.renameFolder', ref.path, null, { name }, who);
  return { ok: true };
});

// ---------------- library.registerFile ----------------
// Called AFTER the client uploads to GCS. Records metadata; validates the
// storagePath is within the org's library prefix (never trust arbitrary paths).
export const libraryRegisterFile = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, title, storagePath, contentType, size, folderId, tags, standardRefs } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!title || !storagePath) throw new HttpsError('invalid-argument', 'title and storagePath required.');
  if (!storagePath.startsWith(`orgs/${orgId}/library/`)) {
    throw new HttpsError('invalid-argument', 'storagePath must be within this org\'s library prefix.');
  }
  const who = actor(auth);

  let folderPath = '';
  if (folderId) {
    const f = await db.doc(`orgs/${orgId}/folders/${folderId}`).get();
    folderPath = f.exists ? f.get('path') : '';
  }
  const cleanTags = [...new Set((tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 20);

  const ref = db.collection(`orgs/${orgId}/libraryFiles`).doc();
  await ref.set({
    title, kind: 'archive', folderId: folderId || null, tags: cleanTags,
    storagePath, contentType: contentType || 'application/octet-stream', size: size || 0,
    standardRefs: Array.isArray(standardRefs) ? standardRefs : [],
    searchTokens: buildTokens(title, cleanTags, folderPath),
    status: 'active', uploadedBy: who, uploadedAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'library.registerFile', ref.path, null, { title, folderId: folderId || null }, who);
  return { fileId: ref.id };
});

// ---------------- library.moveFile ----------------
export const libraryMoveFile = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, fileId, folderId, tags, title } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const ref = db.doc(`orgs/${orgId}/libraryFiles/${fileId}`);
  const cur = await ref.get();
  if (!cur.exists) throw new HttpsError('not-found', 'File not found.');

  let folderPath = '';
  if (folderId) {
    const f = await db.doc(`orgs/${orgId}/folders/${folderId}`).get();
    folderPath = f.exists ? f.get('path') : '';
  }
  const newTitle = title ?? cur.get('title');
  const newTags = tags ? [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 20)
                       : (cur.get('tags') || []);
  await ref.set({
    folderId: folderId ?? cur.get('folderId'), tags: newTags, title: newTitle,
    searchTokens: buildTokens(newTitle, newTags, folderPath),
  }, { merge: true });
  await auditDirect(orgId, 'library.moveFile', ref.path, null, { folderId: folderId || null }, who);
  return { ok: true };
});

// ---------------- library.archiveFile ----------------
// Soft-archive only. Files never hard-delete (retention/compliance).
export const libraryArchiveFile = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, fileId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/libraryFiles/${fileId}`).set({ status: 'archived' }, { merge: true });
  await auditDirect(orgId, 'library.archiveFile', `orgs/${orgId}/libraryFiles/${fileId}`, null, {}, who);
  return { ok: true };
});

// ---------------- library.search ----------------
// Merges controlled documents + archive files. Token prefix / tag / folder.
export const librarySearch = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, q, folderId, tag, includeArchived } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);

  // Archive files: filter by token/tag/folder in Firestore where possible.
  let fq = db.collection(`orgs/${orgId}/libraryFiles`);
  if (folderId) fq = fq.where('folderId', '==', folderId);
  if (tag) fq = fq.where('tags', 'array-contains', String(tag).toLowerCase());
  const fileSnap = await fq.limit(300).get();
  const qToks = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

  let files = fileSnap.docs.map((d) => ({ id: d.id, kind: 'archive', ...d.data() }))
    .filter((f) => includeArchived || f.status !== 'archived')
    .filter((f) => qToks.length === 0 || qToks.every((t) => (f.searchTokens || []).some((st) => st.startsWith(t))));

  // Controlled documents: title match (simpler; they're the P&P set).
  const docSnap = await db.collection(`orgs/${orgId}/documents`).limit(300).get();
  let docs = docSnap.docs.map((d) => ({ id: d.id, kind: 'controlled', ...d.data() }))
    .filter((d) => qToks.length === 0 ||
      qToks.every((t) => String(d.title || '').toLowerCase().includes(t)));

  // Shape a common result row.
  const rows = [
    ...docs.map((d) => ({
      id: d.id, kind: 'controlled', title: d.title,
      status: d.status, currentVersionId: d.currentVersionId || null,
      folderId: d.folderId || null, tags: d.tags || [],
    })),
    ...files.map((f) => ({
      id: f.id, kind: 'archive', title: f.title, status: f.status,
      storagePath: f.storagePath, contentType: f.contentType, size: f.size,
      folderId: f.folderId || null, tags: f.tags || [],
    })),
  ].sort((a, b) => a.title.localeCompare(b.title));

  return { rows, count: rows.length };
});
