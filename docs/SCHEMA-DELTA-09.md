# OpsHub — Schema Delta 09: Document Library (controlled + archive)

Unifies two document classes under one library UI:
- **Controlled documents** (existing `documents` + `versions`, Delta base):
  policies & procedures with draft→approved versioning and supersession.
  The P&P manual. Approval via `documentApproveVersion` callable.
- **Archive files** (NEW `libraryFiles`): any stored file — contracts,
  certificates, reports, correspondence. Upload/organize, no formal version
  approval workflow, but still immutable-once-final and audited.

Both live in the same library, filterable by folder/tag/type. Files stored in
GCS under the org's tenant; metadata + search index in Firestore.

## NEW: orgs/{orgId}/libraryFiles/{fileId}
```
title:        string
kind:         "archive"                 // vs controlled docs which are kind:"controlled"
folderId:     string | null             // FK to folders
tags:         string[]                  // free tags, lowercased
storagePath:  "orgs/{orgId}/library/{fileId}/{filename}"
contentType:  string
size:         number
uploadedBy:   Actor, uploadedAt
status:       "active" | "archived"
searchTokens: string[]                  // denormalized: title words + tags + folder
                                        // (client/functions builds; enables prefix search)
standardRefs: [ {editionId, code} ]     // optional: pin an archive file to a standard
```

## NEW: orgs/{orgId}/folders/{folderId}
```
name:         string
parentId:     string | null             // nested folders
path:         "/Policies/Clinical"      // denormalized breadcrumb
order:        number
createdBy:    Actor, createdAt
```

## Controlled docs — surfaced in the same library
Existing `documents/{docId}` gets read-through in the library UI with
kind:"controlled". No schema change; the UI queries both collections and
merges. Controlled docs show their version/approval state; archive files show
upload metadata. A `folderId` + `tags` may be added to controlled docs too
(additive, optional) so they organize alongside archive files.

## Search
Prefix/tag search over `searchTokens` (Firestore array-contains on lowercased
tokens). For each file: tokens = title split on non-word + tags + folder path
segments. Good enough for a practice-sized library without a separate search
service. (If the library grows large, a later upgrade points at a real index;
the token approach is the JS/Firestore-native starting point.)

## Callables (NEW: library.js)
- library.createFolder     (admin/CD)
- library.renameFolder     (admin/CD)
- library.registerFile     (staff+; after client uploads to GCS, records
                            metadata + builds searchTokens; NEVER trusts
                            client-provided storagePath outside org prefix)
- library.moveFile         (admin/CD; folder/tag changes)
- library.archiveFile      (admin/CD; soft-archive, never hard delete —
                            audit/retention)
- library.search           (staff+; token + folder + tag filter, merges
                            controlled docs + archive files)

## Rules delta
```
match /libraryFiles/{fileId} {
  allow read: if canRead(orgId);
  allow write: if false;                 // callables only (metadata integrity)
}
match /folders/{folderId} {
  allow read: if canRead(orgId);
  allow write: if false;                 // callables only
}
```
Storage: orgs/{orgId}/library/** — org-member read/write, size-capped
(reuse the 25MB general cap; handbook path already has its own 100MB rule).

## Retention posture (compliance-relevant)
Nothing hard-deletes. `archiveFile` sets status:"archived"; the file stays in
GCS and Firestore. This matters for accreditation — document retention and the
ability to show historical policies is itself a survey concern. A future
retention-schedule feature can layer on top (auto-flag docs past retention),
but the immutable-by-default posture is set now.

## Why unified
A surveyor asks "show me your current infection-control policy" (controlled)
and "show me last year's fire drill report" (archive). Both are "documents" to
them. One library, one search, two lifecycles under the hood.
