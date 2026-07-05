# OpsHub — Schema Delta 01: Checkpoints, Checklist Templates, QR Scan Flow
Applies on top of SCHEMA.md v0.1. Delta only — no existing collections modified
except one field addition to `obligations` (noted below).

---

## New: orgs/{orgId}/checkpoints/{checkpointId}
A physical scan point — a fridge, a sink, a fire extinguisher, an OR door.
```
label:        "Med Fridge #1"
assetId:      string | null          // link into asset registry when applicable
location:     "Clean utility, Suite 1011"
obligationIds: [string]              // recurring duties served at this point
allowAdhocLog: bool                  // permit logging outside an open task
adhocTemplateId: string | null       // template for ad-hoc entries (e.g. temp reading)
qrToken:      string                 // opaque random (128-bit b64url); PRINTED value
tokenRotatedAt: Timestamp
active:       bool
createdBy: Actor, createdAt
```
- QR encodes `https://{appHost}/s/{qrToken}` (standalone; orgId from app config)
  or `/s/{orgId}/{qrToken}` (hosted multi-tenant).
- `qrToken` is not the doc ID → rotate/reprint freely; history stays on checkpointId.
- Lookup is server-side (`scan.resolve` callable). Client never queries by token.

## New: orgs/{orgId}/checklistTemplates/{templateId}
Typed form definitions. Server validates every submission against these —
the client form is a convenience, not the enforcement.
```
title:        "Refrigerator temperature log"
evidenceType: "log" | "checklist" | "drill"
fields: [ {
  key:      "tempF"
  label:    "Temperature (°F)"
  type:     "number" | "bool" | "select" | "text"
  required: bool
  unit:     "°F" | null
  range:    { min: 36, max: 46 } | null      // out-of-range trigger
  options:  [string] | null                  // for select
} ]
onOutOfRange: {                              // corrective-action wiring
  createFollowupTask: bool                   // "Investigate fridge #1 excursion"
  followupRole: "clinicalDirector"
  notifyRole:  "admin"
} | null
standardRefs: [ { editionId, standardId } ]
active: bool
```
Out-of-range submissions are still recorded (never block the truth) —
they finalize as evidence flagged `outOfRange: true`, spawn the corrective
task, and notify. A temp excursion with documented follow-up is a QI asset;
a suppressed one is a survey finding.

## Field addition: obligations
```
checkpointId: string | null    // when set, this obligation's tasks are
                               // completable via that checkpoint's QR flow
```

## Evidence payload for scan-originated artifacts
`evidence.payload` for type "log"/"checklist" gains:
```
templateId, templateVersionHash        // provenance of the form itself
answers: { key: value }
outOfRange: bool
scanContext: {
  checkpointId, qrTokenUsed: sha256,   // hash, not the live token
  clientAt: Timestamp,                 // device clock (advisory)
  geo: { lat, lng, accuracyM } | null  // optional, permission-gated
}
```
Server timestamp remains authoritative; `clientAt`/`geo` are corroboration.

## Scan flow (PWA route /s/:token)
1. Route hits `scan.resolve({ token })` (auth required; unauthenticated →
   sign-in, then resume).
2. Response: checkpoint + open task(s) due at this point + template(s).
3. One open task → form opens directly. Multiple → picker. None + adhoc
   allowed → ad-hoc log form. None + no adhoc → "nothing due" + last-completed
   summary (still useful: staff see the point's status at a glance).
4. Submit → `task.completeFromScan` (or `log.adhoc`) → server validation →
   evidence created **finalized** (the authenticated submit IS the attestation
   for scan logs — no draft stage) → task closed → audit entry → out-of-range
   side effects if triggered.

## QR label production
Admin UI "Print labels": client-side `qrcode` npm render into a printable
sheet (Avery 22806 grid or similar), label text = checkpoint label + location.
Rotation = new token, `tokenRotatedAt` set, old token resolves to a
"label retired — report this" page (catches stale photocopies).

## Firestore rules delta
```
match /checkpoints/{checkpointId} {
  allow read: if isStaff(orgId);        // NOT surveyors; tokens are semi-secret
  allow write: if false;                // managed via callables (token minting)
}
match /checklistTemplates/{templateId} {
  allow read: if canRead(orgId);        // surveyors may inspect form definitions
  allow create, update: if isAdmin(orgId);
  allow delete: if false;               // retire via active:false
}
```

## Honest note on presence proof
A QR photographed once can be scanned from the break room. Baseline controls:
authenticated attribution + server timestamp + token rotation + optional geo.
That already exceeds the paper logs surveyors accept today (initials on a
clipboard prove even less). If a licensee later demands hard presence proof,
the upgrade path is NFC tags (NDEF counter) — same checkpoint model, different
token transport. Don't build it now.
