# OpsHub — Schema Delta 05: Content Catalog, Stock Courses, Distribution
Applies on top of SCHEMA.md v0.1 + Deltas 01–04.

Model: stock courses (BBP, PPE, hand hygiene, fire safety, HIPAA, etc.)
ship WITH every deployment as signed content packages, import into the
Delta 04 course machinery, and update through a catalog channel you host.
Subscription = catalog access tiers keyed to the license.

---

## Course provenance (field additions to courses/{courseId})
```
origin:         "stock" | "custom" | "subscribed"
catalogId:      "opshub.bbp" | null       // stable catalog identity
catalogVersion: number | null             // last imported package version
localFork:      bool                      // true = detached from updates
```

## Content package format (.opscourse.json)
A signed, self-contained bundle — structurally identical to a Delta 04
published version snapshot:
```
{
  format: "opscourse/1",
  catalogId: "opshub.bbp",
  catalogVersion: 7,
  minAppVersion: "0.4.0",
  course: { meta, sections, lessons[], answerKeys{} },
  siteSpecificSlots: [ {                 // the OSHA answer
    lessonId, title: "Facility Exposure Control Plan",
    type: "attestation",
    bindTo: { documentCategory: "plan", suggestedTitle: "Exposure Control Plan" },
    required: true
  } ],
  contentHash: sha256(canonical course JSON),
  publisher: "EdAI Systems",
  signature: base64(Ed25519 over contentHash + catalogId + catalogVersion)
}
```
- Publisher public key ships baked into the deployment (functions config).
  Import verifies signature before anything touches Firestore. A licensee
  cannot be fed tampered training content, and YOU can prove authorship.
- `siteSpecificSlots`: on import, unresolved slots render in authoring UI
  as "bind your facility document" — course cannot publish until every
  required slot is bound to an approved local document. Generic-only BBP
  training is structurally impossible, which is the point.

## Import pipeline
`catalog.importPackage` callable (admin only):
1. Verify signature + format + minAppVersion.
2. catalogId new → create course (origin per license entitlement:
   stock/subscribed), lessons + answerKeys written server-side, slots
   materialized unbound.
3. catalogId exists, higher catalogVersion → stage as a new DRAFT
   revision: slot bindings carried forward automatically; admin reviews
   diff summary → publish (normal Delta 04 publish; new version, new
   contentHash). In-flight learners finish their pinned version;
   renewals pick up the new one. NOTHING auto-publishes.
4. catalogId exists but localFork=true → import refused with "forked
   course; import as copy?" option.
5. Audit entry with package hash + signature fingerprint.

## Local customization policy
- **Slot binding** (site documents): the sanctioned customization path;
  survives updates (bindings carry forward by lessonId).
- **Fork**: full local editing freedom; sets localFork=true, origin
  "custom", detaches from update stream permanently. Warned loudly.
- Facility-specific extras beyond slots: recommended pattern is a
  companion course + multi-course requirement (see below), keeping the
  stock course update-clean.

## Requirement change (Delta 03 amendment)
`trainingRequirements.source` kind "lms" becomes:
```
{ kind: "lms", courseIds: [string], minScore }   // was single courseId
```
Completion = ALL listed courses complete. Enables "BBP (stock) + Our
Facility Practices (custom)" as one requirement, one matrix cell.

## Catalog service (your side — the licensing product)
Hosted endpoint (Cloud Run or Hosting + Function), OUTSIDE deployments:
```
GET /v1/catalog?license={key}
  -> { entitlementTier, packages: [ { catalogId, title, catalogVersion,
       category, sizeBytes, sha256, url } ] }
GET /v1/packages/{catalogId}/{version}   (signed URL, license-checked)
```
- Deployment-side scheduled function `catalogSync` (weekly) diffs local
  catalogVersions vs index → writes orgs/{orgId}/catalogUpdates docs →
  admin notification "3 course updates available". Pull + human-approve,
  never push. Air-gapped licensees: manual .opscourse.json upload into
  the same importPackage callable — one code path.
- License validation here doubles as your license heartbeat (Delta base
  license.validate can merge into this).
- Entitlements: "core" (ships free with license: the OSHA/HIPAA
  ubiquitous set), "subscription" tiers (specialty content — surgical
  fire safety, MH drills, moderate sedation, etc. — you author once,
  sell N times, update centrally).

## New collections (deployment side)
```
orgs/{orgId}/catalogUpdates/{catalogId}
  availableVersion, installedVersion, title, category
  status: "available" | "staged" | "imported" | "dismissed"
  checkedAt
```
Rules: read isAdmin; write false (sync + callables only).

## Seeding
Deployment bootstrap script imports the core package set from
/seed/packages/*.opscourse.json (repo-shipped, same signed format,
same import path). Day-one deployment has BBP, PPE, hand hygiene,
fire safety, HIPAA, hazcom ready to slot-bind and publish.

## Rules/index deltas
- courses: no rule changes (origin is data, not authorization).
- catalogUpdates as above.
- Index: courses (origin ASC, status ASC) for the "stock library" admin view.

## Authoring note (your content pipeline)
Package authoring = author course in YOUR org (Ferguson deployment or a
dedicated content org), publish, export version snapshot via
`catalog.exportPackage` (admin callable: wraps snapshot + signs with the
publisher private key held ONLY in your content org's function config).
Ferguson Clinic is customer zero; the export path makes every course you
build for yourself a sellable SKU the same day.
