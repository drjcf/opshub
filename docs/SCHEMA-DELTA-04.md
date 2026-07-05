# OpsHub — Schema Delta 04: Embedded LMS (Course Building + Delivery)
Applies on top of SCHEMA.md v0.1 + Deltas 01–03. Supersedes Delta 03's
external-LMS verification contract: source.kind "lms" is now an INTERNAL
course reference. External-cert and attestation sources unchanged.

Design anchors:
- Ships inside every deployment. Same Firebase project, same auth/claims,
  same evidence pipeline. Zero external dependencies.
- Publish = immutable snapshot (the EDAIPathways journey-snapshot pattern).
  Enrollments pin to a course VERSION; the certificate cites version + hash.
  "Trained on what, exactly?" has a cryptographic answer.
- Quiz answer keys NEVER ship to the client. Grading is server-side only.

---

## Authoring surface

### orgs/{orgId}/courses/{courseId}
```
title, description
category:     "orientation" | "annual" | "clinical" | "safety" | "custom"
status:       "draft" | "published" | "retired"
currentVersion: number          // latest published version; 0 = never published
sections:     [ { id, title, order } ]
passingScore: number | null     // course-level gate across quiz lessons
estimatedMinutes
standardRefs: [ { editionId, standardId } ]
createdBy: Actor, createdAt, updatedAt
```

### orgs/{orgId}/courses/{courseId}/lessons/{lessonId}
Draft working copies — authors edit these freely until publish.
```
sectionId, order, title
type: "reading" | "video" | "quiz" | "attestation" | "link" | "file"
required: bool                  // optional enrichment lessons allowed
content (by type):
  reading:     { markdown }
  video:       { url, provider: "youtube"|"gcs", minWatchPct: 90 | null }
  quiz:        { questionCount, passingScore, shuffle: bool,
                 allowRetake: bool, maxAttempts: number|null }
                 // question STEMS+OPTIONS live here for rendering;
                 // see answer-key isolation below
  attestation: { documentId }   // Document Control policy read + e-sign;
                                // reuses Delta 03 attestation evidence
  link:        { url, requireConfirm: bool }
  file:        { storagePath, fileName, sha256 }
```

### Answer-key isolation (the one non-negotiable)
Quiz questions split across two locations:
- `lessons/{lessonId}.content.questions`: [ { qid, stem, options[] } ] —
  client-renderable, NO correct index, NO rationale.
- `courses/{courseId}/answerKeys/{lessonId}`: { qid: { correctIndex,
  rationale } } — rules: read/write FALSE for all clients. Callable-only.
Rationale is returned per-question in the grade RESPONSE (post-submit
feedback), never pre-fetched.

## Publishing

### orgs/{orgId}/courses/{courseId}/versions/{versionNumber}
`course.publish` callable (admin/clinicalDirector):
1. Validates: ≥1 required lesson, every quiz has a complete key, attestation
   docs exist and are approved versions.
2. Deep-copies course meta + all lessons + answer keys into the version doc
   (single doc; lesson content embedded; crash-cart-scale content fits —
   if a course outgrows 1MB, publisher shards into versions/{n}/chunks).
3. contentHash = sha256(canonical JSON of the snapshot, keys sorted).
4. Sets course.currentVersion = n, status = "published".
5. Audit entry.
```
versionNumber, snapshot: { meta, sections, lessons[], answerKeys{} }
contentHash, publishedBy: Actor, publishedAt
```
Rules: versions readable false for non-admin (contains answer keys).
Learner delivery reads a PROJECTION (see enrollment.lessonView callable)
that serves version content minus keys.

## Delivery surface

### orgs/{orgId}/enrollments/{enrollmentId}
Doc ID = `{staffId}_{courseId}` (one live enrollment; retakes reset it,
history persists in evidence/certificates).
```
staffId, staffUid, courseId
courseVersion: number           // PINNED at enrollment
source: "requirement" | "manual"
requirementId: string | null    // links back to trainingRecords (Delta 03)
status: "assigned" | "inProgress" | "complete" | "failed"
progress: { [lessonId]: { completedAt, score: number|null, attempts } }
startedAt, completedAt, finalScore
assignedBy: Actor, assignedAt
```
Progress writes are callable-only:
- `lesson.markComplete` (reading/link/file/video; video passes watchPct,
  server checks against minWatchPct — advisory-honest, not DRM)
- `quiz.submit({ enrollmentId, lessonId, answers })` → grades against the
  VERSION's key, enforces maxAttempts, returns per-question rationale,
  records score.
- Attestation lessons complete via the existing `training.attest` path;
  the enrollment listens for that evidence.

### Completion transaction (fires when last required lesson completes)
1. finalScore computed (weighted across quiz lessons); pass/fail vs
   passingScore.
2. On pass: certificate minted, evidence (type "training") created
   FINALIZED with payload:
   `{ source: "lms", courseId, courseVersion, contentHash,
      verificationCode, finalScore, lessonScores }`
3. If requirementId present: trainingRecord → complete, expiresAt computed
   from the requirement's cadence (Delta 03 machinery unchanged).
4. Audit.

### orgs/{orgId}/certificates/{certId}
```
verificationCode: string        // 12-char b32, collision-checked
staffId, staffName (snapshot), courseId, courseTitle (snapshot)
courseVersion, contentHash
finalScore, issuedAt, expiresAt: Timestamp | null
evidenceId
revoked: bool, revokedReason    // revocation, never deletion
```

### Public verification: /verify/{code}
Unauthenticated HTTPS function (not a callable): returns
`{ valid, staffName, courseTitle, issuedAt, expiresAt, issuerOrg }` —
nothing else. Rate-limited. This is how a hospital HR office or another
facility validates a cert without any account. Revoked → valid:false.

## Integration wiring (already-built machinery, no changes)
- Requirement with source.kind "lms" → onPersonnelCreate materializes the
  trainingRecord AND auto-creates the enrollment (assigned).
- Today view: assigned/inProgress enrollments render as tasks →
  deep-link into the course player.
- trainingSweep: unchanged — reads trainingRecords; renewal task auto-
  re-enrolls at current published version (content updates propagate at
  renewal, never mid-enrollment).
- Training matrix cell click → certificate + evidence + which content hash.
- Notifications: assignment, 7-day nudge, completion congrats to staffer;
  completion + failure alerts to clinicalDirector. Same queue.

## Roles
No new roles. Authoring: admin | clinicalDirector. A dedicated "educator"
role is a licensing-tier upsell later — moduleGrants already supports it
(`courses: "rw"`) without schema change.

## Rules delta
```
match /courses/{courseId} {
  allow read: if isStaff(orgId) &&
    (resource.data.status == 'published' || isAdmin(orgId) ||
     hasRole(orgId,'clinicalDirector'));
  allow create, update: if isAdmin(orgId) || hasRole(orgId,'clinicalDirector');
  allow delete: if false;

  match /lessons/{lessonId} {
    allow read: if isAdmin(orgId) || hasRole(orgId,'clinicalDirector');
    // learners get lesson content via enrollment.lessonView projection
    allow write: if (isAdmin(orgId) || hasRole(orgId,'clinicalDirector'))
      && get(/databases/$(database)/documents/orgs/$(orgId)/courses/$(courseId)).data.status == 'draft'
      // published courses edit via new draft → republish as new version
  }
  match /answerKeys/{lessonId} {
    allow read, write: if false;          // callables only. Always.
  }
  match /versions/{v} {
    allow read: if isAdmin(orgId);        // contains keys
    allow write: if false;
  }
}
match /enrollments/{enrollmentId} {
  allow read: if isAdmin(orgId) || hasRole(orgId,'clinicalDirector')
              || resource.data.staffUid == request.auth.uid;
  allow write: if false;                  // callables only
}
match /certificates/{certId} {
  allow read: if canRead(orgId);          // surveyors browse certs
  allow write: if false;
}
```

## Indexes
- enrollments: (staffUid ASC, status ASC), (courseId ASC, status ASC)
- certificates: (verificationCode ASC) [single-field], (staffId ASC, issuedAt DESC)

## Build order for this module
1. course.publish + snapshot/hash (everything downstream trusts it)
2. quiz.submit + lesson.markComplete + completion transaction
3. enrollment.lessonView projection + course player UI
4. Authoring UI (sections/lessons editor, quiz builder)
5. /verify/{code} public endpoint
6. Optional later: Claude-assisted quiz drafting from a policy document
   (author reviews every item — AI suggests, human decides, per the
   Liability Rule).
