// functions/src/catalog.js — Session D (Delta 05)
// Signed content packages: import (Ed25519 verify), export (content org
// only), and the weekly update sync. One import path for catalog-pulled
// AND manually-uploaded packages.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import {
  db, FieldValue, sha256,
  requireAuth, requireOrg, requireRole,
  actor, auditDirect,
} from './util.js';
import { PUBLISHER_PUBLIC_KEY_PEM } from './publisherKey.js';

// Content-org only; absent in licensee deployments (export then refuses).
const PUBLISHER_PRIVATE_KEY = defineSecret('PUBLISHER_PRIVATE_KEY');
const CATALOG_URL = defineString('CATALOG_URL', { default: '' });

// Canonical JSON — MUST match lms.js canonical() byte-for-byte.
function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}

const signedPayload = (pkg) => Buffer.from(`${pkg.contentHash}|${pkg.catalogId}|${pkg.catalogVersion}`);

function verifyPackage(pkg) {
  if (pkg.format !== 'opscourse/1') throw new HttpsError('invalid-argument', 'Unknown package format.');
  for (const f of ['catalogId', 'catalogVersion', 'course', 'contentHash', 'signature']) {
    if (pkg[f] === undefined) throw new HttpsError('invalid-argument', `Package missing ${f}.`);
  }
  const computed = sha256(canonical(pkg.course));
  if (computed !== pkg.contentHash) {
    throw new HttpsError('failed-precondition', 'Content hash mismatch — package altered.');
  }
  const ok = verify(
    null,
    signedPayload(pkg),
    createPublicKey(PUBLISHER_PUBLIC_KEY_PEM),
    Buffer.from(pkg.signature, 'base64')
  );
  if (!ok) throw new HttpsError('permission-denied', 'Signature invalid — refusing import.');
}

// ---------------- catalog.importPackage ----------------
export const catalogImportPackage = onCall(
  { memory: '512MiB' },
  async (req) => {
    const auth = requireAuth(req);
    const { orgId, pkg } = req.data || {};
    requireOrg(auth, orgId);
    requireRole(auth, ['owner', 'admin']);
    const who = actor(auth);

    verifyPackage(pkg);

    // Locate existing course by catalogId.
    const existing = await db.collection(`orgs/${orgId}/courses`)
      .where('catalogId', '==', pkg.catalogId).limit(1).get();

    const { meta, sections, lessons, answerKeys } = pkg.course;
    const slots = pkg.siteSpecificSlots ?? [];
    const slotIds = new Set(slots.map((s) => s.lessonId));

    let courseRef;
    let carryBindings = {};

    if (existing.empty) {
      courseRef = db.collection(`orgs/${orgId}/courses`).doc();
    } else {
      const cur = existing.docs[0];
      if (cur.get('localFork')) {
        throw new HttpsError('failed-precondition',
          'Course is a local fork, detached from updates. Import as a copy instead.');
      }
      if ((cur.get('catalogVersion') ?? 0) >= pkg.catalogVersion) {
        throw new HttpsError('failed-precondition',
          `Installed catalogVersion ${cur.get('catalogVersion')} >= package ${pkg.catalogVersion}.`);
      }
      courseRef = cur.ref;
      // Carry slot bindings forward by lessonId.
      const oldLessons = await courseRef.collection('lessons').get();
      for (const l of oldLessons.docs) {
        if (slotIds.has(l.id) && l.get('content')?.documentId) {
          carryBindings[l.id] = l.get('content').documentId;
        }
      }
    }

    const batch = db.batch();
    batch.set(courseRef, {
      title: meta.title, description: meta.description ?? '',
      category: meta.category ?? 'custom',
      status: 'draft',                      // ALWAYS lands as draft; human publishes
      currentVersion: existing.empty ? 0 : existing.docs[0].get('currentVersion') ?? 0,
      sections, passingScore: meta.passingScore ?? null,
      standardRefs: meta.standardRefs ?? [],
      origin: 'stock', catalogId: pkg.catalogId, catalogVersion: pkg.catalogVersion,
      localFork: false,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existing.empty ? { createdBy: who, createdAt: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });

    // Replace draft lessons wholesale with package content (bindings re-applied).
    if (!existing.empty) {
      const oldLessons = await courseRef.collection('lessons').get();
      for (const l of oldLessons.docs) batch.delete(l.ref);
      const oldKeys = await courseRef.collection('answerKeys').get();
      for (const k of oldKeys.docs) batch.delete(k.ref);
    }
    for (const lesson of lessons) {
      const { id, ...rest } = lesson;
      if (slotIds.has(id) && carryBindings[id]) {
        rest.content = { ...(rest.content ?? {}), documentId: carryBindings[id] };
      }
      batch.set(courseRef.collection('lessons').doc(id), rest);
    }
    for (const [lessonId, key] of Object.entries(answerKeys ?? {})) {
      batch.set(courseRef.collection('answerKeys').doc(lessonId), key);
    }
    if (!existing.empty) {
      batch.set(db.doc(`orgs/${orgId}/catalogUpdates/${pkg.catalogId}`), {
        installedVersion: pkg.catalogVersion, status: 'imported',
        checkedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();

    await auditDirect(orgId, 'catalog.import', courseRef.path, null, {
      catalogId: pkg.catalogId, catalogVersion: pkg.catalogVersion,
      contentHash: pkg.contentHash, signatureFingerprint: sha256(pkg.signature).slice(0, 16),
      bindingsCarried: Object.keys(carryBindings).length,
    }, who);

    const unboundSlots = slots.filter((s) => s.required && !carryBindings[s.lessonId]);
    return {
      courseId: courseRef.id,
      staged: true,
      unboundSlots: unboundSlots.map((s) => ({ lessonId: s.lessonId, title: s.title, bindTo: s.bindTo })),
      note: unboundSlots.length
        ? 'Bind required site-specific slots to approved documents, then publish.'
        : 'Review and publish to make available to learners.',
    };
  }
);

// ---------------- catalog.exportPackage (content org only) ----------------
export const catalogExportPackage = onCall(
  { secrets: [PUBLISHER_PRIVATE_KEY] },
  async (req) => {
    const auth = requireAuth(req);
    const { orgId, courseId, catalogId, catalogVersion, siteSpecificSlots } = req.data || {};
    requireOrg(auth, orgId);
    requireRole(auth, ['owner']);

    const priv = PUBLISHER_PRIVATE_KEY.value();
    if (!priv) throw new HttpsError('failed-precondition', 'No publisher key in this deployment (not the content org).');

    const courseSnap = await db.doc(`orgs/${orgId}/courses/${courseId}`).get();
    const v = courseSnap.get('currentVersion') ?? 0;
    if (v === 0) throw new HttpsError('failed-precondition', 'Publish the course before exporting.');
    const verSnap = await db.doc(`orgs/${orgId}/courses/${courseId}/versions/${v}`).get();
    const { snapshot } = verSnap.data();

    // Strip any bound documentIds from slot lessons: licensees bind their own.
    const slotIds = new Set((siteSpecificSlots ?? []).map((s) => s.lessonId));
    const exportLessons = snapshot.lessons.map((l) =>
      slotIds.has(l.id)
        ? { ...l, content: { ...(l.content ?? {}), documentId: null } }
        : l
    );
    const course = { meta: snapshot.meta, sections: snapshot.sections, lessons: exportLessons, answerKeys: snapshot.answerKeys };
    const contentHash = sha256(canonical(course));
    const pkg = {
      format: 'opscourse/1',
      catalogId, catalogVersion,
      minAppVersion: '0.2.0',
      course,
      siteSpecificSlots: siteSpecificSlots ?? [],
      contentHash,
      publisher: 'EdAI Systems',
      signature: sign(null, signedPayload({ contentHash, catalogId, catalogVersion }), createPrivateKey(priv)).toString('base64'),
    };
    await auditDirect(orgId, 'catalog.export', `orgs/${orgId}/courses/${courseId}`, null, { catalogId, catalogVersion, contentHash });
    return { pkg };
  }
);

// ---------------- catalogSync (weekly) ----------------
export const catalogSync = onSchedule(
  { schedule: '0 4 * * 1', timeZone: 'Pacific/Honolulu' },
  async () => {
    const url = CATALOG_URL.value();
    if (!url) return; // standalone/dev deployment with no catalog configured

    const orgs = await db.collection('orgs').where('status', '==', 'active').get();
    for (const orgDoc of orgs.docs) {
      const orgId = orgDoc.id;
      const license = orgDoc.get('licenseKey');
      if (!license) continue;

      let index;
      try {
        const res = await fetch(`${url}/v1/catalog?license=${encodeURIComponent(license)}`);
        if (!res.ok) throw new Error(`catalog ${res.status}`);
        index = await res.json();
      } catch (e) {
        await auditDirect(orgId, 'catalog.syncError', 'catalog', null, { error: String(e) });
        continue;
      }

      let newUpdates = 0;
      for (const entry of index.packages ?? []) {
        const installed = await db.collection(`orgs/${orgId}/courses`)
          .where('catalogId', '==', entry.catalogId).limit(1).get();
        const installedVersion = installed.empty ? 0 : installed.docs[0].get('catalogVersion') ?? 0;
        if (entry.catalogVersion <= installedVersion) continue;
        if (!installed.empty && installed.docs[0].get('localFork')) continue;

        await db.doc(`orgs/${orgId}/catalogUpdates/${entry.catalogId}`).set({
          title: entry.title, category: entry.category ?? null,
          availableVersion: entry.catalogVersion,
          installedVersion,
          url: entry.url, sha256: entry.sha256 ?? null,
          status: 'available',
          checkedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        newUpdates += 1;
      }
      if (newUpdates > 0) {
        await db.collection(`orgs/${orgId}/notifications`).add({
          toRole: 'admin', kind: 'catalogUpdates', count: newUpdates,
          createdAt: FieldValue.serverTimestamp(), sentAt: null,
        });
      }
    }
  }
);
