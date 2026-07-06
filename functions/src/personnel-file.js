// functions/src/personnel-file.js — employee file: credentials + HR documents.
// Credentials are survey-visible (competency proof); HR docs are private
// (isHR + subject only). employeeFileGet assembles the whole thing with
// graduated visibility. Extends existing personnel + credentialFiles.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  db, FieldValue, Timestamp, DAY, daysFromNow,
  requireAuth, requireOrg, requireRole, actor, auditDirect, queueNotification,
} from './util.js';

// HR access: owner/admin/hr. (hr is an optional custom role a licensee may add.)
function requireHR(auth, orgId) {
  requireOrg(auth, orgId);
  const roles = auth.token.roles || [];
  if (!roles.some((r) => ['owner', 'admin', 'hr', 'clinicalDirector'].includes(r))) {
    throw new HttpsError('permission-denied', 'HR access required.');
  }
}

// ---------------- credential.upsertItem ----------------
export const credentialUpsertItem = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid, itemId, type, name, number, issuer, issuedOn, expiresOn, storagePath, standardRefs, note } = req.data || {};
  requireHR(auth, orgId);
  if (!uid || !name) throw new HttpsError('invalid-argument', 'uid and name required.');
  const who = actor(auth);

  if (storagePath && !storagePath.startsWith(`orgs/${orgId}/personnel/${uid}/`)) {
    throw new HttpsError('invalid-argument', 'storagePath must be within this person\'s prefix.');
  }

  const ref = itemId
    ? db.doc(`orgs/${orgId}/credentialFiles/${uid}/items/${itemId}`)
    : db.collection(`orgs/${orgId}/credentialFiles/${uid}/items`).doc();

  // Ensure the parent credentialFile doc exists.
  await db.doc(`orgs/${orgId}/credentialFiles/${uid}`).set(
    { uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  const exp = expiresOn ? Timestamp.fromMillis(new Date(expiresOn).getTime()) : null;
  const status = !exp ? 'active' : (exp.toMillis() < Date.now() ? 'expired' : 'active');

  await ref.set({
    type: type || 'other', name, number: number || null, issuer: issuer || '',
    issuedOn: issuedOn ? Timestamp.fromMillis(new Date(issuedOn).getTime()) : null,
    expiresOn: exp, status,
    storagePath: storagePath || null,
    standardRefs: Array.isArray(standardRefs) ? standardRefs : [],
    note: note || '', updatedBy: who, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await auditDirect(orgId, 'credential.upsert', ref.path, null, { uid, type, name }, who);
  return { itemId: ref.id, status };
});

// ---------------- credential.verify ----------------
// Records primary-source verification (a real credentialing requirement).
export const credentialVerify = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid, itemId } = req.data || {};
  requireHR(auth, orgId);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/credentialFiles/${uid}/items/${itemId}`).set({
    verifiedBy: who, verifiedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await auditDirect(orgId, 'credential.verify', `orgs/${orgId}/credentialFiles/${uid}/items/${itemId}`, null, { uid }, who);
  return { ok: true };
});

// ---------------- credential.sweep (scheduled) ----------------
// Flip expired, queue lead/critical/expired notifications. Runs daily.
export const credentialSweep = onSchedule('0 7 * * *', async () => {
  const orgs = await db.collection('orgs').get();
  for (const org of orgs.docs) {
    const orgId = org.id;
    const files = await db.collection(`orgs/${orgId}/credentialFiles`).get();
    for (const f of files.docs) {
      const items = await f.ref.collection('items').get();
      for (const it of items.docs) {
        const exp = it.get('expiresOn');
        if (!exp) continue;
        const days = Math.floor((exp.toMillis() - Date.now()) / DAY);
        let tier = null;
        if (days < 0) tier = 'expired';
        else if (days <= 14) tier = 'critical';
        else if (days <= 60) tier = 'lead';
        if (!tier) continue;
        const newStatus = days < 0 ? 'expired' : it.get('status');
        if (newStatus !== it.get('status')) await it.ref.set({ status: newStatus }, { merge: true });
        // dedup ledger key: one notice per item per tier
        const ledgerId = `cred_${f.id}_${it.id}_${tier}`;
        const ledgerRef = db.doc(`orgs/${orgId}/sweepLedger/${ledgerId}`);
        const seen = await ledgerRef.get();
        if (seen.exists) continue;
        await ledgerRef.set({ at: FieldValue.serverTimestamp(), tier });
        await queueNotification(db, orgId, {
          kind: 'credentialExpiry', tier, uid: f.id, itemId: it.id,
          title: `${it.get('name')} — ${tier === 'expired' ? 'EXPIRED' : `expires in ${days}d`}`,
        });
      }
    }
  }
});

// ---------------- hrDoc.register ----------------
export const hrDocRegister = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid, category, title, storagePath, contentType, size, effectiveDate, confidential } = req.data || {};
  requireHR(auth, orgId);
  if (!uid || !title || !storagePath) throw new HttpsError('invalid-argument', 'uid, title, storagePath required.');
  if (!storagePath.startsWith(`orgs/${orgId}/personnel/${uid}/hr/`)) {
    throw new HttpsError('invalid-argument', 'HR doc storagePath must be within the person\'s private hr prefix.');
  }
  const who = actor(auth);
  const ref = db.collection(`orgs/${orgId}/personnel/${uid}/hrDocuments`).doc();
  await ref.set({
    category: category || 'other', title,
    storagePath, contentType: contentType || 'application/octet-stream', size: size || 0,
    effectiveDate: effectiveDate ? Timestamp.fromMillis(new Date(effectiveDate).getTime()) : null,
    confidential: !!confidential, status: 'active',
    uploadedBy: who, uploadedAt: FieldValue.serverTimestamp(),
  });
  await auditDirect(orgId, 'hrDoc.register', ref.path, null, { uid, category, confidential: !!confidential }, who);
  return { docId: ref.id };
});

// ---------------- hrDoc.archive ----------------
export const hrDocArchive = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid, docId } = req.data || {};
  requireHR(auth, orgId);
  const who = actor(auth);
  await db.doc(`orgs/${orgId}/personnel/${uid}/hrDocuments/${docId}`).set({ status: 'archived' }, { merge: true });
  await auditDirect(orgId, 'hrDoc.archive', `orgs/${orgId}/personnel/${uid}/hrDocuments/${docId}`, null, { uid }, who);
  return { ok: true };
});

// ---------------- employeeFile.get ----------------
// Assembles the full file with graduated visibility. isHR sees everything;
// the subject sees their own non-confidential HR docs; others are denied.
export const employeeFileGet = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid } = req.data || {};
  requireOrg(auth, orgId);
  const roles = auth.token.roles || [];
  const isHR = roles.some((r) => ['owner', 'admin', 'hr', 'clinicalDirector'].includes(r));
  const isSubject = auth.uid === uid;
  if (!isHR && !isSubject) throw new HttpsError('permission-denied', 'Not authorized for this file.');

  const [profileSnap, credItems, training, hrDocs, linked] = await Promise.all([
    db.doc(`orgs/${orgId}/personnel/${uid}`).get(),
    db.collection(`orgs/${orgId}/credentialFiles/${uid}/items`).get(),
    db.collection(`orgs/${orgId}/personnel/${uid}/trainingRecords`).get().catch(() => ({ docs: [] })),
    db.collection(`orgs/${orgId}/personnel/${uid}/hrDocuments`).where('status', '==', 'active').get().catch(() => ({ docs: [] })),
    db.collection(`orgs/${orgId}/libraryFiles`).where('personRefs', 'array-contains', uid).get().catch(() => ({ docs: [] })),
  ]);

  const credentials = credItems.docs.map((d) => ({ id: d.id, ...d.data() }));
  const trainingRecords = training.docs.map((d) => ({ id: d.id, ...d.data() }));

  // HR docs: HR sees all active; subject sees only non-confidential.
  let hrDocuments = hrDocs.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!isHR) hrDocuments = hrDocuments.filter((d) => d.confidential !== true);

  const linkedFiles = linked.docs.map((d) => ({ id: d.id, title: d.get('title'), storagePath: d.get('storagePath') }));

  return {
    profile: profileSnap.exists ? { id: profileSnap.id, ...profileSnap.data() } : null,
    credentials,
    trainingRecords,
    hrDocuments,
    linkedFiles,
    viewerIsHR: isHR,
  };
});
