# OpsHub — Build Manifest
Single source of truth for build state. Update this file every session.
Workflow: built in Claude chat → push to GitHub → next session pulls repo.

## Repo layout
```
opshub/
  firebase.json, .firebaserc (set project id), storage.rules
  firestore.rules            # v0.2 — base + Deltas 01–05 merged
  firestore.indexes.json     # all composite indexes through Delta 05
  functions/
    package.json  index.js
    src/util.js               # shared helpers (auth, audit, checkpoint, notify)
    src/callables.js          # scan, evidence lifecycle, docs, surveyor, checkpoints
    src/registers.js          # registerCheck.submit, expirationSweep
    src/scheduler.js          # materializeTasks (rrule engine, missed-marking)
    src/notifier.js           # queue drainer + morning digest (Resend)
  docs/                       # SCHEMA.md + SCHEMA-DELTA-01..05 (canonical design)
  seed/packages/              # stock .opscourse.json packages (empty; Session C)
  app/                        # React+Vite PWA (not started)
```

## BUILT ✅ (syntax-verified; needs emulator pass — Session A)
- Firestore rules v0.2, indexes, storage rules
- Callables: scanResolve, taskCompleteFromScan, logAdhoc, evidenceFinalize,
  evidenceSupersede, documentApproveVersion, checkpointMint/RotateToken,
  surveyorGrant/Revoke
- registerCheckSubmit + expirationSweep (3-tier, dedup ledger)
- materializeTasks (hourly, deterministic task IDs, missed-marking)
- onNotificationCreated + morningDigest

## PENDING — session order
A. **Emulator verification pass**: firebase emulators + rules unit tests
   (@firebase/rules-unit-testing), smoke-test each callable. Zero-error gate
   before anything else builds on top.
B. **training.js** (Delta 03): onPersonnelCreate/RoleChange triggers,
   trainingSweep (merge into sweep runner), training.attest,
   training.approveExternal, matrix projection callable.
C. **lms.js** (Delta 04): course.publish (snapshot+hash), quiz.submit,
   lesson.markComplete, enrollment.lessonView, completion transaction,
   certificate mint, /verify/{code} public HTTPS endpoint.
D. **catalog.js** (Delta 05): importPackage (Ed25519 verify), exportPackage
   (content-org only), catalogSync scheduler. Author first stock packages
   (BBP, PPE, hand hygiene, fire safety, HIPAA, hazcom) into seed/packages/.
E. **App shell** (React+Vite PWA): auth, Today board, /s/:token scan flow
   (checklist + register-check forms), register admin, QR label print sheet.
F. **App modules**: Document Control, Training matrix, Course player,
   Authoring UI, Dashboard (chapter RAG), Surveyor portal.
G. **Seeding**: standardsEditions loader script (citation codes + shortRefs
   only — NO AAAHC verbatim text), Ferguson org bootstrap, first obligations.

## Standing decisions (do not relitigate)
- No PHI anywhere. Evidence append-only; missed stays missed; waivers/
  exemptions are records, never deletions.
- All protected transitions via callables; answer keys never client-readable.
- Config files never overwritten wholesale — delta patches only.
- Multi-tenant shape always; standalone = one org + config ORG_ID.
- Stock content: signed packages, pull-and-approve updates, site-specific
  slots must bind before publish.

## Environment per deployment
- Secrets: RESEND_API_KEY. Params: APP_HOST. Publisher pubkey (catalog) baked
  into functions config at Session D.
- Scheduler timezone: parameterize for licensees (HST default for customer zero).
