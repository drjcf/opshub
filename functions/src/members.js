// functions/src/members.js — staff provisioning.
// Creates the Auth user, stamps orgId+roles custom claims (the authorization
// source of truth), writes the members mirror (UI) and a personnel doc (which
// triggers training materialization). Only owner/admin may provision.
//
// Roles a member may hold: owner, admin, clinicalDirector, staff.
// 'surveyor' is NOT settable here — it's time-boxed via surveyorGrant only.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { randomBytes } from 'node:crypto';
import {
  db, FieldValue, Timestamp,
  requireAuth, requireOrg, requireRole, actor, auditDirect,
} from './util.js';

const ASSIGNABLE = ['owner', 'admin', 'clinicalDirector', 'staff'];

function sanitizeRoles(roles) {
  const set = [...new Set((roles || []).filter((r) => ASSIGNABLE.includes(r)))];
  if (set.length === 0) set.push('staff'); // never leave a member role-less
  return set;
}

// ---------------- member.create ----------------
// data: { orgId, email, displayName, title, roles[], category, sendReset }
export const memberCreate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, email, displayName, title, roles, category, sendReset } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  if (!email) throw new HttpsError('invalid-argument', 'Email required.');
  const who = actor(auth);
  const finalRoles = sanitizeRoles(roles);

  // Only an owner may mint another owner/admin.
  const wantsElevated = finalRoles.some((r) => ['owner', 'admin'].includes(r));
  if (wantsElevated && !(auth.token.roles || []).includes('owner')) {
    throw new HttpsError('permission-denied', 'Only an owner can grant owner/admin.');
  }

  // Reuse existing Auth user if the email already exists; else create.
  let user;
  let tempPassword = null;
  try {
    user = await getAuth().getUserByEmail(email);
  } catch {
    tempPassword = randomBytes(9).toString('base64url');
    user = await getAuth().createUser({ email, password: tempPassword, displayName: displayName || undefined });
  }

  // Claims are the authorization source of truth.
  await getAuth().setCustomUserClaims(user.uid, { orgId, roles: finalRoles });
  // Force token refresh so old sessions pick up the new claim.
  await getAuth().revokeRefreshTokens(user.uid);

  const batch = db.batch();
  // members mirror (UI / roster / notifications)
  batch.set(db.doc(`orgs/${orgId}/members/${user.uid}`), {
    displayName: displayName || email, email, title: title || '',
    roles: finalRoles, active: true,
    createdBy: who, createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // personnel doc — its creation triggers onPersonnelCreated → training materialization
  batch.set(db.doc(`orgs/${orgId}/personnel/${user.uid}`), {
    uid: user.uid, displayName: displayName || email, email,
    title: title || '', category: category || 'clinical',
    appRoles: finalRoles,
    hireDate: FieldValue.serverTimestamp(),
    active: true, createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await batch.commit();

  let resetLink = null;
  if (sendReset && !tempPassword) {
    // Existing user: offer a reset link rather than a temp password.
    try { resetLink = await getAuth().generatePasswordResetLink(email); } catch { /* non-fatal */ }
  }

  await auditDirect(orgId, 'member.create', `orgs/${orgId}/members/${user.uid}`, null,
    { email, roles: finalRoles, reused: tempPassword === null }, who);

  return {
    uid: user.uid, roles: finalRoles,
    tempPassword,              // present only for brand-new users
    resetLink,                 // present only if requested for an existing user
    note: tempPassword
      ? 'New user created. Share the temp password; they should change it on first sign-in.'
      : 'Existing user added to this org.',
  };
});

// ---------------- member.setRoles ----------------
export const memberSetRoles = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid, roles } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);
  const finalRoles = sanitizeRoles(roles);

  const wantsElevated = finalRoles.some((r) => ['owner', 'admin'].includes(r));
  if (wantsElevated && !(auth.token.roles || []).includes('owner')) {
    throw new HttpsError('permission-denied', 'Only an owner can grant owner/admin.');
  }
  // Guard: don't let the last owner be demoted (lockout prevention).
  const target = await db.doc(`orgs/${orgId}/members/${uid}`).get();
  if (target.exists && (target.get('roles') || []).includes('owner') && !finalRoles.includes('owner')) {
    const owners = await db.collection(`orgs/${orgId}/members`)
      .where('active', '==', true).where('roles', 'array-contains', 'owner').get();
    if (owners.size <= 1) throw new HttpsError('failed-precondition', 'Cannot remove the last owner.');
  }

  await getAuth().setCustomUserClaims(uid, { orgId, roles: finalRoles });
  await getAuth().revokeRefreshTokens(uid);
  await db.doc(`orgs/${orgId}/members/${uid}`).set({ roles: finalRoles }, { merge: true });
  await db.doc(`orgs/${orgId}/personnel/${uid}`).set({ appRoles: finalRoles }, { merge: true });
  await auditDirect(orgId, 'member.setRoles', `orgs/${orgId}/members/${uid}`, null, { roles: finalRoles }, who);
  return { uid, roles: finalRoles };
});

// ---------------- member.deactivate ----------------
// Revokes access without deleting the person (evidence/attribution must persist).
export const memberDeactivate = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, uid } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin']);
  const who = actor(auth);

  const target = await db.doc(`orgs/${orgId}/members/${uid}`).get();
  if (target.exists && (target.get('roles') || []).includes('owner')) {
    const owners = await db.collection(`orgs/${orgId}/members`)
      .where('active', '==', true).where('roles', 'array-contains', 'owner').get();
    if (owners.size <= 1) throw new HttpsError('failed-precondition', 'Cannot deactivate the last owner.');
  }

  // Strip claims (kills authz) and disable the Auth account.
  await getAuth().setCustomUserClaims(uid, { orgId, roles: [] });
  await getAuth().revokeRefreshTokens(uid);
  await getAuth().updateUser(uid, { disabled: true });
  await db.doc(`orgs/${orgId}/members/${uid}`).set({ active: false }, { merge: true });
  await db.doc(`orgs/${orgId}/personnel/${uid}`).set({ active: false }, { merge: true });
  await auditDirect(orgId, 'member.deactivate', `orgs/${orgId}/members/${uid}`, null, { active: false }, who);
  return { uid, active: false };
});
