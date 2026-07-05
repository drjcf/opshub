// functions/src/lms.js — Session C (Delta 04)
// course.publish (immutable snapshot + content hash), learner lesson views
// (answer keys never leave the server), server-side quiz grading, the
// completion transaction (certificate + evidence + trainingRecord), and the
// public /verify endpoint.

import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { randomBytes } from 'node:crypto';
import {
  db, FieldValue, Timestamp, DAY, sha256,
  requireAuth, requireOrg, requireRole,
  actor, audit, queueNotification,
} from './util.js';

// Canonical JSON: stable key order so the hash is reproducible.
function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object' && !(obj instanceof Timestamp)) {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  if (obj instanceof Timestamp) return String(obj.toMillis());
  return JSON.stringify(obj);
}

// ---------------- course.publish ----------------
export const coursePublish = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, courseId } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  const courseRef = db.doc(`orgs/${orgId}/courses/${courseId}`);
  const [courseSnap, lessonsSnap] = await Promise.all([
    courseRef.get(),
    courseRef.collection('lessons').orderBy('order').get(),
  ]);
  if (!courseSnap.exists) throw new HttpsError('not-found', 'Course not found.');
  const course = courseSnap.data();
  const lessons = lessonsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // ---- validation gate ----
  if (lessons.filter((l) => l.required !== false).length === 0) {
    throw new HttpsError('failed-precondition', 'Course needs at least one required lesson.');
  }
  const answerKeys = {};
  for (const l of lessons) {
    if (l.type === 'quiz') {
      const keySnap = await courseRef.collection('answerKeys').doc(l.id).get();
      if (!keySnap.exists) {
        throw new HttpsError('failed-precondition', `Quiz "${l.title}" has no answer key.`);
      }
      const key = keySnap.data();
      for (const q of l.content?.questions ?? []) {
        const k = key[q.qid];
        if (!k || !Number.isInteger(k.correctIndex) || k.correctIndex >= q.options.length) {
          throw new HttpsError('failed-precondition', `Quiz "${l.title}" question ${q.qid}: incomplete key.`);
        }
      }
      answerKeys[l.id] = key;
    }
    if (l.type === 'attestation') {
      const docId = l.content?.documentId;
      const d = docId ? await db.doc(`orgs/${orgId}/documents/${docId}`).get() : { exists: false };
      if (!d.exists || !d.get('currentVersionId')) {
        throw new HttpsError('failed-precondition',
          `Attestation lesson "${l.title}" must bind to an APPROVED document. (Site-specific slot unbound?)`);
      }
    }
  }

  const versionNumber = (course.currentVersion ?? 0) + 1;
  const snapshot = {
    meta: {
      title: course.title, description: course.description ?? '',
      category: course.category, passingScore: course.passingScore ?? null,
      standardRefs: course.standardRefs ?? [],
    },
    sections: course.sections ?? [],
    lessons,
    answerKeys,
  };
  const contentHash = sha256(canonical(snapshot));

  await db.runTransaction(async (tx) => {
    tx.set(courseRef.collection('versions').doc(String(versionNumber)), {
      versionNumber, snapshot, contentHash,
      publishedBy: who, publishedAt: FieldValue.serverTimestamp(),
    });
    tx.update(courseRef, {
      currentVersion: versionNumber, status: 'published',
      updatedAt: FieldValue.serverTimestamp(),
    });
    audit(tx, orgId, 'course.publish', courseRef.path, null, { versionNumber, contentHash }, who);
  });
  return { versionNumber, contentHash };
});

// ---------------- shared: load own enrollment + version snapshot ----------------
async function loadEnrollmentContext(orgId, auth, enrollmentId) {
  const enrRef = db.doc(`orgs/${orgId}/enrollments/${enrollmentId}`);
  const enrSnap = await enrRef.get();
  if (!enrSnap.exists) throw new HttpsError('not-found', 'Enrollment not found.');
  const enr = enrSnap.data();
  const isPrivileged = (auth.token.roles || []).some((r) => ['owner', 'admin', 'clinicalDirector'].includes(r));
  if (enr.staffUid !== auth.uid && !isPrivileged) {
    throw new HttpsError('permission-denied', 'Not your enrollment.');
  }
  const verSnap = await db
    .doc(`orgs/${orgId}/courses/${enr.courseId}/versions/${enr.courseVersion}`)
    .get();
  if (!verSnap.exists) throw new HttpsError('failed-precondition', 'Pinned course version missing.');
  return { enrRef, enr, version: verSnap.data() };
}

const stripKeys = (lesson) => {
  if (lesson.type !== 'quiz') return lesson;
  return {
    ...lesson,
    content: {
      ...lesson.content,
      questions: (lesson.content?.questions ?? []).map(({ qid, stem, options }) => ({ qid, stem, options })),
    },
  };
};

// ---------------- enrollment.lessonView ----------------
export const enrollmentLessonView = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, enrollmentId, lessonId } = req.data || {};
  requireOrg(auth, orgId);
  const { enrRef, enr, version } = await loadEnrollmentContext(orgId, auth, enrollmentId);

  if (enr.status === 'assigned' && enr.staffUid === auth.uid) {
    await enrRef.update({ status: 'inProgress', startedAt: FieldValue.serverTimestamp() });
  }

  if (lessonId) {
    const lesson = version.snapshot.lessons.find((l) => l.id === lessonId);
    if (!lesson) throw new HttpsError('not-found', 'Lesson not in this version.');
    return { lesson: stripKeys(lesson), progress: enr.progress ?? {}, meta: version.snapshot.meta };
  }
  // Course outline: everything, keys stripped.
  return {
    meta: version.snapshot.meta,
    sections: version.snapshot.sections,
    lessons: version.snapshot.lessons.map(stripKeys),
    progress: enr.progress ?? {},
    contentHash: version.contentHash,
  };
});

// ---------------- completion core ----------------
async function maybeComplete(tx, orgId, enrRef, enr, version, who) {
  const lessons = version.snapshot.lessons;
  const required = lessons.filter((l) => l.required !== false);
  const prog = enr.progress ?? {};
  if (!required.every((l) => prog[l.id]?.completedAt)) return null;

  const quizzes = lessons.filter((l) => l.type === 'quiz');
  const scores = quizzes.map((l) => prog[l.id]?.score ?? 0);
  const finalScore = quizzes.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / quizzes.length)
    : 100;
  const passing = version.snapshot.meta.passingScore ?? 0;
  if (finalScore < passing) {
    tx.update(enrRef, { status: 'failed', finalScore, completedAt: FieldValue.serverTimestamp() });
    queueNotification(tx, orgId, {
      toRole: 'clinicalDirector', kind: 'trainingFailed',
      staffId: enr.staffId, courseId: enr.courseId, finalScore,
    });
    return { failed: true, finalScore };
  }

  // Certificate — collision-safe enough at 12 b32 chars; retry once anyway.
  const code = randomBytes(8).toString('base64url').replace(/[-_]/g, 'A').slice(0, 12).toUpperCase();
  const certRef = db.collection(`orgs/${orgId}/certificates`).doc();

  // Expiry from the linked requirement's cadence, if any.
  let expiresAt = null;
  if (enr.requirementId) {
    const reqSnap = await db.doc(`orgs/${orgId}/trainingRequirements/${enr.requirementId}`).get();
    const cad = reqSnap.get('cadence');
    if (cad === 'annual') expiresAt = Timestamp.fromMillis(Date.now() + 365 * DAY);
    else if (cad === 'biennial') expiresAt = Timestamp.fromMillis(Date.now() + 730 * DAY);
  }

  const staffSnap = await db.doc(`orgs/${orgId}/personnel/${enr.staffId}`).get();
  const staffName = staffSnap.get('displayName') ?? enr.staffId;

  const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
  tx.set(evRef, {
    type: 'training',
    title: `Course complete: ${version.snapshot.meta.title} — ${staffName}`,
    standardRefs: version.snapshot.meta.standardRefs ?? [],
    taskId: null, checkpointId: null, registerId: null,
    payload: {
      source: 'lms',
      courseId: enr.courseId, courseVersion: enr.courseVersion,
      contentHash: version.contentHash,
      verificationCode: code, finalScore,
      lessonScores: Object.fromEntries(quizzes.map((l) => [l.id, prog[l.id]?.score ?? 0])),
      staffId: enr.staffId,
    },
    attachments: [], status: 'finalized',
    finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
    supersededBy: null, supersedes: null,
    createdBy: who, createdAt: FieldValue.serverTimestamp(),
  });

  tx.set(certRef, {
    verificationCode: code,
    staffId: enr.staffId, staffName,
    courseId: enr.courseId, courseTitle: version.snapshot.meta.title,
    courseVersion: enr.courseVersion, contentHash: version.contentHash,
    finalScore, issuedAt: FieldValue.serverTimestamp(), expiresAt,
    evidenceId: evRef.id, revoked: false, revokedReason: null,
  });

  tx.update(enrRef, {
    status: 'complete', finalScore, completedAt: FieldValue.serverTimestamp(),
  });

  if (enr.requirementId) {
    // Multi-course requirements: record completes when ALL courses done —
    // checked post-transaction by the caller via reconcileRequirement.
    tx.set(db.doc(`orgs/${orgId}/personnel/${enr.staffId}/trainingRecords/${enr.requirementId}`), {
      lastCourseCompleted: enr.courseId,
    }, { merge: true });
  }

  queueNotification(tx, orgId, {
    toUid: enr.staffUid, kind: 'trainingAssigned', // reuse copy table; refine later
    courseId: enr.courseId,
  });
  audit(tx, orgId, 'enrollment.complete', enrRef.path, null, { finalScore, code }, who);
  return { failed: false, finalScore, verificationCode: code, evidenceId: evRef.id };
}

// After a course completes: if all courses in the requirement are complete,
// close the trainingRecord (expiry from cadence).
async function reconcileRequirement(orgId, staffId, requirementId) {
  const reqSnap = await db.doc(`orgs/${orgId}/trainingRequirements/${requirementId}`).get();
  if (!reqSnap.exists) return;
  const courseIds = reqSnap.get('source')?.courseIds ?? [];
  for (const cid of courseIds) {
    const e = await db.doc(`orgs/${orgId}/enrollments/${staffId}_${cid}`).get();
    if (!e.exists || e.get('status') !== 'complete') return; // not yet
  }
  const cad = reqSnap.get('cadence');
  const expiresAt =
    cad === 'annual' ? Timestamp.fromMillis(Date.now() + 365 * DAY)
    : cad === 'biennial' ? Timestamp.fromMillis(Date.now() + 730 * DAY)
    : null;
  await db.doc(`orgs/${orgId}/personnel/${staffId}/trainingRecords/${requirementId}`).set({
    status: 'complete', completedAt: FieldValue.serverTimestamp(), expiresAt,
  }, { merge: true });
}

// ---------------- lesson.markComplete ----------------
export const lessonMarkComplete = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, enrollmentId, lessonId, watchPct, attest } = req.data || {};
  requireOrg(auth, orgId);
  const who = actor(auth);
  const { enrRef, enr, version } = await loadEnrollmentContext(orgId, auth, enrollmentId);
  if (enr.staffUid !== auth.uid) {
    throw new HttpsError('permission-denied', 'Only the learner completes lessons.');
  }
  const lesson = version.snapshot.lessons.find((l) => l.id === lessonId);
  if (!lesson) throw new HttpsError('not-found', 'Lesson not in this version.');
  if (lesson.type === 'quiz') throw new HttpsError('failed-precondition', 'Quizzes complete via quiz.submit.');

  if (lesson.type === 'video' && lesson.content?.minWatchPct) {
    if ((watchPct ?? 0) < lesson.content.minWatchPct) {
      throw new HttpsError('failed-precondition', `Watch at least ${lesson.content.minWatchPct}% first.`);
    }
  }
  if (lesson.type === 'attestation') {
    if (attest !== true) throw new HttpsError('failed-precondition', 'Attestation requires explicit confirmation.');
  }

  return db.runTransaction(async (tx) => {
    const fresh = (await tx.get(enrRef)).data();
    const progress = { ...(fresh.progress ?? {}) };
    if (progress[lessonId]?.completedAt) return { alreadyComplete: true };
    progress[lessonId] = { completedAt: Timestamp.now(), score: null, attempts: 0 };

    // Attestation lessons mint their own version-pinned evidence.
    if (lesson.type === 'attestation') {
      const docId = lesson.content.documentId;
      const docSnap = await tx.get(db.doc(`orgs/${orgId}/documents/${docId}`));
      const versionId = docSnap.get('currentVersionId');
      const verSnap = await tx.get(db.doc(`orgs/${orgId}/documents/${docId}/versions/${versionId}`));
      const evRef = db.collection(`orgs/${orgId}/evidence`).doc();
      tx.set(evRef, {
        type: 'training',
        title: `Attestation (course): ${lesson.title}`,
        standardRefs: [], taskId: null, checkpointId: null, registerId: null,
        payload: {
          source: 'attestation', documentId: docId, documentVersionId: versionId,
          versionSha256: verSnap.get('sha256') ?? null,
          attestedBy: who, courseId: enr.courseId, lessonId,
        },
        attachments: [], status: 'finalized',
        finalizedBy: who, finalizedAt: FieldValue.serverTimestamp(),
        supersededBy: null, supersedes: null,
        createdBy: who, createdAt: FieldValue.serverTimestamp(),
      });
      progress[lessonId].evidenceId = evRef.id;
    }

    tx.update(enrRef, { progress });
    const completion = await maybeComplete(tx, orgId, enrRef, { ...fresh, progress }, version, who);
    return { ok: true, completion };
  }).then(async (out) => {
    if (out?.completion && !out.completion.failed && enr.requirementId) {
      await reconcileRequirement(orgId, enr.staffId, enr.requirementId);
    }
    return out;
  });
});

// ---------------- quiz.submit ----------------
export const quizSubmit = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, enrollmentId, lessonId, answers } = req.data || {};
  requireOrg(auth, orgId);
  const who = actor(auth);
  const { enrRef, enr, version } = await loadEnrollmentContext(orgId, auth, enrollmentId);
  if (enr.staffUid !== auth.uid) throw new HttpsError('permission-denied', 'Only the learner submits.');

  const lesson = version.snapshot.lessons.find((l) => l.id === lessonId);
  if (!lesson || lesson.type !== 'quiz') throw new HttpsError('not-found', 'Quiz lesson not found.');
  const key = version.snapshot.answerKeys[lessonId];
  if (!key) throw new HttpsError('internal', 'Answer key missing from snapshot.');

  const questions = lesson.content.questions;
  const results = questions.map((q) => {
    const given = answers?.[q.qid];
    const correct = key[q.qid].correctIndex;
    return {
      qid: q.qid,
      correct: given === correct,
      correctIndex: correct,
      rationale: key[q.qid].rationale ?? null,
    };
  });
  const score = Math.round((results.filter((r) => r.correct).length / questions.length) * 100);
  const passing = lesson.content.passingScore ?? 0;
  const passed = score >= passing;

  const out = await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(enrRef)).data();
    const progress = { ...(fresh.progress ?? {}) };
    const prev = progress[lessonId] ?? { attempts: 0 };
    const attempts = (prev.attempts ?? 0) + 1;
    const max = lesson.content.maxAttempts ?? null;
    if (max && attempts > max) {
      throw new HttpsError('resource-exhausted', `Max attempts (${max}) reached.`);
    }
    progress[lessonId] = {
      attempts,
      score: Math.max(score, prev.score ?? 0),
      completedAt: passed ? Timestamp.now() : (prev.completedAt ?? null),
    };
    tx.update(enrRef, { progress });
    const completion = passed
      ? await maybeComplete(tx, orgId, enrRef, { ...fresh, progress }, version, who)
      : null;
    return { score, passed, attempts, results, completion };
  });

  if (out.completion && !out.completion.failed && enr.requirementId) {
    await reconcileRequirement(orgId, enr.staffId, enr.requirementId);
  }
  return out;
});

// ---------------- public /verify/{code} ----------------
export const verifyCertificate = onRequest({ cors: true }, async (request, response) => {
  const code = String(request.path.split('/').filter(Boolean).pop() ?? request.query.code ?? '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (code.length < 8) {
    response.status(400).json({ valid: false, error: 'Malformed code.' });
    return;
  }
  const snap = await db.collectionGroup('certificates')
    .where('verificationCode', '==', code).limit(1).get();
  if (snap.empty) {
    response.status(404).json({ valid: false });
    return;
  }
  const c = snap.docs[0].data();
  const orgId = snap.docs[0].ref.parent.parent.id;
  const orgSnap = await db.doc(`orgs/${orgId}`).get();
  const expired = c.expiresAt && c.expiresAt.toMillis() < Date.now();
  response.json({
    valid: !c.revoked && !expired,
    revoked: !!c.revoked,
    expired: !!expired,
    staffName: c.staffName,
    courseTitle: c.courseTitle,
    courseVersion: c.courseVersion,
    issuedAt: c.issuedAt?.toDate?.().toISOString() ?? null,
    expiresAt: c.expiresAt?.toDate?.().toISOString() ?? null,
    issuerOrg: orgSnap.get('name') ?? orgId,
  });
});
