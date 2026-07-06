# OpsHub — Schema Delta 10: Employee File (credentials + HR documents)

A unified per-person file: profile + credentials (regulated, expiring, survey-
checked) + training rollup + HR documents (evals, letters, discipline). Two
storage tiers by sensitivity, distinct access from everything else in OpsHub.

## Access model (new, stricter than staff-wide)
HR content is NOT staff-readable. New predicate: **isHR** = owner/admin, plus
optionally a designated HR role. Sensitive per-person docs are readable only by
isHR + the subject themselves (their own file). Surveyors see CREDENTIALS
(competency proof is a survey concern) but NOT evals/letters/discipline.

- Credentials: canRead(org) — staff+surveyor (proof of competency).
- HR documents: isHR OR the subject (own file only). Never surveyors, never
  general staff.

## Credentials — first-class, expiration-tracked
Reuses/extends existing `credentialFiles/{uid}` + `items/`. Each item:
### orgs/{orgId}/credentialFiles/{uid}/items/{itemId}
```
type:        "license" | "certification" | "dea" | "boardCert" | "cpr" |
             "insurance" | "immunization" | "backgroundCheck" | "other"
name:        "State Medical License"
number:      string | null
issuer:      string
issuedOn:    Timestamp | null
expiresOn:   Timestamp | null          // THE survey-critical field
status:      "active" | "expired" | "pending" | "revoked"  // derived on sweep
storagePath: string | null            // scan of the credential (GCS, per-tenant)
standardRefs:[ {editionId, code} ]     // pins to credentialing standards
verifiedBy:  Actor | null, verifiedAt  // primary-source verification record
note:        string
```
Expiration sweep (extends the existing sweep pattern) flips status and queues
notifications at lead/critical/expired thresholds — same 3-tier ledger as
register expirations, so a license lapsing surfaces on the Today board.

## HR documents — private per-person
### orgs/{orgId}/personnel/{uid}/hrDocuments/{docId}
```
category:    "evaluation" | "letter" | "offer" | "discipline" |
             "acknowledgement" | "competency" | "other"
title:       string
storagePath: "orgs/{orgId}/personnel/{uid}/hr/{docId}/{filename}"  // PRIVATE prefix
contentType, size
effectiveDate: Timestamp | null
uploadedBy:  Actor, uploadedAt
confidential:boolean                    // extra-restricted (discipline) — isHR only,
                                        // NOT visible to the subject
status:      "active" | "archived"
```
Sensitive docs live under the personnel subtree with tighter rules. Storage
path is a PRIVATE prefix, separate from the org-wide library.

## General docs — linked from the library
The library (Delta 09) libraryFiles may carry `personRefs: [uid]` so a general,
non-sensitive person-related doc (e.g. a public bio, a signed general policy
acknowledgement) shows in BOTH the library and the person's file without
duplicating storage. Additive field on libraryFiles.

## The employee-file view assembles (per uid):
- profile (personnel/{uid})
- credentials (credentialFiles/{uid}/items) with expiry status chips
- training rollup (personnel/{uid}/trainingRecords + matrix)
- HR documents (personnel/{uid}/hrDocuments) — gated by isHR/subject
- linked library files (libraryFiles where personRefs contains uid)

## Callables (personnel.js — extends existing)
- credential.upsertItem   (isHR/CD; add/update a credential + expiry)
- credential.verify       (isHR/CD; record primary-source verification)
- credential.sweep        (scheduled; flip expired, queue notifications)
- hrDoc.register          (isHR; after client uploads to private prefix)
- hrDoc.archive           (isHR; soft-archive)
- employeeFile.get        (isHR or subject; assembles the full file, enforces
                          confidential-doc filtering for the subject)

## Rules delta
```
match /credentialFiles/{uid} {
  allow read: if canRead(orgId);                 // surveyors see competency proof
  allow write: if false;                          // callables only
  match /items/{itemId} {
    allow read: if canRead(orgId);
    allow write: if false;
  }
}
match /personnel/{uid} {
  ...
  match /hrDocuments/{docId} {
    allow read: if isHR(orgId)
      || (inOrg(orgId) && get(.../personnel/$(uid)).data.uid == request.auth.uid
          && resource.data.confidential != true);   // subject sees own non-confidential
    allow write: if false;                            // callables only
  }
}
```
isHR(orgId) := hasRole(orgId,'owner') || hasRole(orgId,'admin') || hasRole(orgId,'hr')

Storage: orgs/{orgId}/personnel/{uid}/hr/** — isHR + subject read only, never
org-wide. Distinct from orgs/{orgId}/library/** (org-member) and
orgs/{orgId}/handbook/** (org-member).

## Why this matters for survey
A surveyor asks "show me Dr. X's file": you show profile + current-and-verified
credentials (with expiry) + completed training — the competency package —
WITHOUT exposing evals or discipline. The access split is the point: one file,
graduated visibility.
