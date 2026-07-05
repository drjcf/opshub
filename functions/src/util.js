// functions/src/util.js — shared helpers. Single source; no duplicates elsewhere.
import { HttpsError } from 'firebase-functions/v2/https';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

if (getApps().length === 0) initializeApp();
export const db = getFirestore();
export { FieldValue, Timestamp };

export const DAY = 24 * 3600 * 1000;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const daysFromNow = (d) => Timestamp.fromMillis(Date.now() + d * DAY);

export function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth;
}

export function requireOrg(auth, orgId) {
  if (!orgId || auth.token.orgId !== orgId) {
    throw new HttpsError('permission-denied', 'Wrong organization.');
  }
}

export function requireRole(auth, roles) {
  const have = auth.token.roles || [];
  if (!roles.some((r) => have.includes(r))) {
    throw new HttpsError('permission-denied', `Requires one of: ${roles.join(', ')}`);
  }
}

export const STAFF_ROLES = ['owner', 'admin', 'clinicalDirector', 'staff'];

export function actor(auth) {
  return {
    uid: auth.uid,
    displayNameSnapshot: auth.token.name || auth.token.email || auth.uid,
    at: Timestamp.now(),
  };
}

// Transactional audit write.
export function audit(tx, orgId, action, targetPath, before, after, who) {
  tx.set(db.collection(`orgs/${orgId}/auditLog`).doc(), {
    actor: who ?? 'system',
    action,
    targetPath,
    before: before ?? null,
    after: after ?? null,
    at: FieldValue.serverTimestamp(),
  });
}

// Non-transactional audit write (schedulers, triggers).
export async function auditDirect(orgId, action, targetPath, before, after, who) {
  await db.collection(`orgs/${orgId}/auditLog`).add({
    actor: who ?? 'system',
    action,
    targetPath,
    before: before ?? null,
    after: after ?? null,
    at: FieldValue.serverTimestamp(),
  });
}

export async function resolveCheckpointByToken(orgId, token) {
  if (!token) throw new HttpsError('invalid-argument', 'Missing token.');
  const snap = await db
    .collection(`orgs/${orgId}/checkpoints`)
    .where('qrToken', '==', token)
    .where('active', '==', true)
    .limit(1)
    .get();
  if (snap.empty) {
    throw new HttpsError('not-found', 'Label retired or unknown. Report this label.');
  }
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export function queueNotification(txOrBatch, orgId, payload) {
  txOrBatch.set(db.collection(`orgs/${orgId}/notifications`).doc(), {
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
    sentAt: null,
  });
}
