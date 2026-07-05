# OpsHub — Schema Delta 03: Training & Orientation Module
Applies on top of SCHEMA.md v0.1 + Deltas 01–02. Delta only.

Stance: OpsHub owns REQUIREMENTS and PROOF; the EdAI LMS (or any provider)
owns DELIVERY. Sources are pluggable — LMS course, external certificate,
or in-app attestation — all landing in the same evidence pipeline.

---

## New: orgs/{orgId}/trainingRequirements/{reqId}
A rule stating who must complete what, how often.
```
title:        "HIPAA privacy & security training"
description
standardRefs: [ { editionId, standardId } ]
appliesTo: {
  roles:      ["staff","clinicalDirector"] | "all"
  categories: ["clinical","frontOffice"] | null   // personnel.category filter
}
source:
  { kind: "lms",         courseId, minScore: number|null }
| { kind: "external",    acceptedIssuers: ["AHA"], evidenceHint: "Upload card, both sides" }
| { kind: "attestation", documentId }              // read current policy version + e-sign
cadence:      "once" | "annual" | "biennial" | rrule
dueWithinDaysOfHire: 30 | null    // orientation items
gracePeriodDays: 14
active: bool
createdBy: Actor, createdAt
```
Orientation = a set of requirements with `cadence: "once"` +
`dueWithinDaysOfHire`. No special orientation machinery; the matrix and
sweep treat it uniformly.

## New: orgs/{orgId}/personnel/{staffId}/trainingRecords/{recordId}
Per-person lifecycle of one requirement. Doc ID = reqId (one live record
per requirement per person; renewals update in place, history lives in
evidence).
```
requirementId
status:      "due" | "inProgress" | "complete" | "expired" | "exempt"
assignedAt, dueAt
completedAt: Timestamp | null
expiresAt:   Timestamp | null      // completedAt + cadence for renewables
evidenceId:  string | null         // the proof artifact
exemption:   { reason, approvedBy: Actor } | null   // auditable, never silent
lmsEnrollment: { courseId, enrollmentId, lastSyncAt } | null
```

## Evidence payloads (type: "training")
LMS-verified completion:
```
payload: {
  source: "lms",
  courseId, courseTitle,
  verificationCode,                 // the LMS certificate code
  verifiedAt, verificationResponse: { learner, completedAt, score },
  learnerUid
}
```
External certificate:
```
payload: { source: "external", issuer: "AHA", credential: "ACLS",
           cardExpiresAt, attachmentSha256, reviewedBy: Actor }
```
Attestation:
```
payload: { source: "attestation", documentId, documentVersionId,
           versionSha256,          // proves WHICH policy text was attested
           attestedBy: Actor }
```

## Lifecycle machinery

### onPersonnelCreate / onPersonnelRoleChange (Firestore trigger)
New hire (or role change) → materialize trainingRecords for every active
requirement matching their roles/category:
- dueAt = hireDate + dueWithinDaysOfHire (orientation) or next cadence date
- notification to the new hire + clinicalDirector: "Orientation checklist
  assigned — N items, due {date}"
Role change diff: newly-applicable requirements added; no-longer-applicable
records marked `exempt` with reason "role change" (never deleted).

### trainingSweep (nightly; merges into existing sweep runner)
- record.expiresAt within lead window (30d) → renewal task + notification
  (same dedup-ledger pattern as Delta 02: `trn:{staffId}:{reqId}:{tier}`)
- record.dueAt passed, status still due/inProgress → task escalation to
  clinicalDirector; record flips to `expired` after grace
- ACLS/BLS card expirations here REPLACE the ad-hoc expiry tracking noted
  in the base schema's personnel section — one system, not two.

### Completion paths
1. **LMS**: callable `training.verifyLmsCompletion({ staffId, reqId,
   verificationCode })` → server-to-server GET against the LMS verification
   endpoint → on match (learner identity + course + completion date):
   evidence minted finalized, record → complete, expiresAt computed,
   renewal machinery armed. THE CONTRACT NEEDED FROM THE LMS BUILD:
   `GET /api/certificates/verify/{code}` →
   `{ valid, learnerEmail, courseId, completedAt, score }` — align this
   with the LMS chat; it's the only cross-system surface.
   Optional push mode later: LMS webhook on completion → same handler,
   HMAC-signed. Pull-verify ships first (works with zero LMS changes).
2. **External**: staff uploads card → draft evidence → clinicalDirector
   reviews (checks issuer/date/name) → `training.approveExternal` finalizes,
   sets expiresAt from card.
3. **Attestation**: staff opens current document version in-app → scroll +
   e-sign → `training.attest` mints evidence pinned to versionSha256.
   Policy update → optionally re-triggers the requirement for all staff
   (flag on requirement: `reattestOnNewVersion: bool`).

## Training Matrix (projection — the surveyor deliverable)
Route `/training/matrix`: grid of personnel × requirements.
Cell = record status color: green complete / amber due≤30d / red
expired-or-overdue / gray exempt (hover: reason). Click cell → evidence.
Export to PDF. Per-person view = their transcript; per-requirement view =
org compliance % (feeds dashboard + makes an easy QI study).
Surveyor portal gets the matrix READ-ONLY with evidence drill-down —
"show me everyone's HIPAA training" is answered in one screen.

## Today view integration
trainingRecords due/expiring surface as tasks like everything else:
"[ ] Complete HIPAA training (due Jul 20)" → deep-link: lms source →
LMS course URL; attestation → in-app doc; external → upload form.

## Rules delta
```
match /trainingRequirements/{reqId} {
  allow read: if canRead(orgId);
  allow create, update: if isAdmin(orgId) || hasRole(orgId,'clinicalDirector');
  allow delete: if false;
}
match /personnel/{staffId}/trainingRecords/{recordId} {
  // own transcript readable by the person; full access for admin/CD;
  // surveyors see the MATRIX projection, not raw personnel subtree
  allow read: if isAdmin(orgId) || hasRole(orgId,'clinicalDirector')
              || request.auth.uid == get(/databases/$(database)/documents/orgs/$(orgId)/personnel/$(staffId)).data.uid;
  allow write: if false;             // callables + triggers only
}
```
(Surveyor matrix access is served by a callable that projects
records + evidence refs without exposing the personnel subtree.)

## Indexes
- collectionGroup trainingRecords: (status ASC, expiresAt ASC),
  (status ASC, dueAt ASC), (requirementId ASC, status ASC)
