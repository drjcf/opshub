# OpsHub — Schema Delta 14: Controlled Policies & Procedures + Required Documents

Extends the existing documents/versions backend into a full P&P system:
authored or Drive-linked policies, versioned and approved, mapped to standards,
on a review cadence — plus a REQUIRED-DOCUMENT registry so the practice sees
coverage against what AAAHC requires (what exists, what's missing, what's due).

## Builds on existing (Delta pre-existing)
- orgs/{orgId}/documents/{docId} with currentVersionId
- orgs/{orgId}/documents/{docId}/versions/{versionId}: status draft|approved|
  superseded, approval{approvedBy, gbMinutesEvidenceId}, effectiveAt
- documentApproveVersion callable (draft → approved, links GB minutes)

## Extended document doc: orgs/{orgId}/documents/{docId}
```
title:          "Infection Prevention & Control Plan"
docType:        "policy" | "procedure" | "plan" | "form" | "manual"
category:       "infection-control" | "governance" | "clinical" | "safety" |
                "hr" | "emergency" | "quality" | "medication" | "facility" | "other"
standardRefs:   [ {editionId, code} ]      // standards this document satisfies
storageMode:    "authored" | "linked"       // in-app body OR external file
currentVersionId: string | null
reviewIntervalMonths: number                // e.g. 12 or 36 (AAAHC review cadence)
lastReviewedAt: Timestamp | null
nextReviewDue:  Timestamp | null            // computed on approval
owner:          Actor
status:         "active" | "retired"
requirementId:  string | null              // links to a required-document slot
createdBy, createdAt, updatedAt
```

## Extended version doc: .../versions/{versionId}
```
versionLabel:   "1.0" | "2.1"
status:         "draft" | "approved" | "superseded"
storageMode:    "authored" | "linked"
body:           string | null               // authored: rich text / markdown-ish
storagePath:    string | null               // linked: GCS path (uploaded file)
driveFileId:    string | null               // linked: a Google Drive file id
driveLink:      string | null               // linked: the Drive webViewLink
changeSummary:  string                       // what changed this version
authoredBy:     Actor, authoredAt
approval:       { approvedBy, gbMinutesEvidenceId, effectiveAt } | null
```
storageMode "authored" → body holds the policy text (edited in-app, versioned).
storageMode "linked"   → the content lives in Drive/GCS; OpsHub tracks the
                         pointer + review lifecycle. Fits Workspace: a policy
                         maintained as a Google Doc is linked by driveFileId.

## Required-document registry: orgs/{orgId}/documentRequirements/{requirementId}
The AAAHC-expected document set (seedable). Drives the coverage dashboard.
```
key:            "ipc-plan"
title:          "Infection Prevention & Control Plan"
description:    string
category:       (as above)
standardRefs:   [ {editionId, code} ]
required:       boolean                       // vs recommended
reviewIntervalMonths: number                  // expected cadence
docId:          string | null                 // the document that satisfies it
status:         "unmet" | "met" | "review-due" // computed
```
A requirement is **met** when a document links to it with an approved current
version whose nextReviewDue is in the future; **review-due** when past due;
**unmet** when no document is linked.

## Callables (policies.js — extends documentApproveVersion)
- policy.create             (admin/CD; creates document, optional requirementId)
- policy.saveVersion        (admin/CD; new draft version — authored body OR
                            linked Drive/GCS pointer; changeSummary)
- policy.list               (staff+; documents with current version + review state)
- policy.markReviewed       (admin/CD; refresh lastReviewedAt/nextReviewDue
                            without a content change — the "reviewed, no change"
                            attestation AAAHC accepts)
- policy.retire             (admin/CD)
- requirement.seed          (admin; seed/update the required-document registry)
- requirement.coverage      (staff+; the dashboard — every requirement with its
                            linked doc + met/unmet/review-due status)
(existing) documentApproveVersion — draft → approved, links GB minutes evidence.

## Review-cadence computation
On approval, nextReviewDue = effectiveAt + reviewIntervalMonths. A scheduled
sweep (policyReviewSweep) flags documents past nextReviewDue and queues a
notification (kind: "policyReviewDue") to the Today board — same pattern as
credential/register expirations.

## Coverage dashboard (the interactive part)
requirement.coverage returns, per required document:
- the requirement (title, standards, required/recommended)
- the linked document + current version status + review state
- an overall met/unmet/review-due verdict
So "show me your policies for standard ASG.160" resolves to the exact documents,
and "what are we missing" is answerable at a glance — the survey-prep view.

## Rules delta
```
match /documents/{docId} {
  allow read: if canRead(orgId);
  allow write: if false;                      // policy callables only
  match /versions/{versionId} {
    allow read: if canRead(orgId);
    allow write: if false;
  }
}
match /documentRequirements/{reqId} {
  allow read: if canRead(orgId);
  allow write: if false;                      // requirement callables only
}
```

## Standards ↔ documents, closed
Each standard can now resolve to the documents that satisfy it (via standardRefs
on both the requirement and the document). The crosswalk gains a documents
dimension: standard → required docs → actual policies → current approved version.
That's "policies tied to standards," interactive and coverage-aware.
```
