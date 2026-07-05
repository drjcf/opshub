# OpsHub — Deployment Runbook

The three identifiers in play (independent; each must be internally consistent):
- **GCP project** — `edai-opshub`  (functions, Firestore, secrets live here)
- **Hosting site** — `tfc-ops`      (the public URL: tfc-ops.web.app)
- **Org ID**       — `ferguson`     (Firestore tenant key AND your auth claim)

The app needs project + org aligned; the QR needs the hosting site.
`app/.env.local` `VITE_ORG_ID` MUST equal the bootstrap `ORG_ID` MUST equal
your custom claim's `orgId`. Mismatch = "wrong organization" / empty data.

## First-time deployment (in order)

1. **Console:** create Firestore (Native mode) + enable Email/Password auth.

2. **Rules + indexes:**
       firebase deploy --only firestore

3. **Publisher signing key** (content org only — signs course packages):
       cd seed/tools && npm i @google-cloud/secret-manager && cd ../..
       node seed/tools/generate-publisher-key.js edai-opshub
       git add functions/src/publisherKey.js && git commit -m "publisher key"

4. **Functions:**
       cd functions && npm install && cd ..
       firebase deploy --only functions
   (Prompts for CATALOG_URL on first deploy — press Enter for empty.)

5. **IAM — the step fresh projects always miss:**
       ./seed/tools/iam-setup.sh edai-opshub      # runtime + build SA roles
       ./seed/tools/grant-invokers.sh edai-opshub # public invoke on callables
   Wait ~60s for propagation.

6. **Bootstrap** (org, owner account, seed crash cart):
       export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
       node seed/bootstrap/bootstrap.js
   Prints a temp password for the owner on first run.

7. **App config + deploy:**
       # app/.env.local: fill Firebase web config; set
       #   VITE_ORG_ID=ferguson
       #   VITE_APP_HOST=https://tfc-ops.web.app
       # firebase.json hosting block: "site": "tfc-ops"
       firebase hosting:sites:create tfc-ops   # if not already created
       cd app && npm install && npm run build && cd ..
       firebase deploy --only hosting

8. **Kick the scheduler once** so a task exists to scan:
       Cloud Scheduler console → materializetasks → Run now
   (Otherwise it fires hourly on its own.)

9. Sign in at tfc-ops.web.app (owner email + temp password), then scan a
   crash cart QR. Expect epinephrine flagged red, forcing a verdict.

## Redeploys
- Existing functions: `firebase deploy --only functions` — IAM persists, no re-grant.
- NEW callable added: re-run `./seed/tools/grant-invokers.sh` after deploy.
- App change: `cd app && npm run build && cd .. && firebase deploy --only hosting`.

## Debugging a function 500
    gcloud run services logs read <servicename-lowercase> \
      --project edai-opshub --region us-central1 --limit 30
Service names are LOWERCASE (scanResolve → scanresolve).

## Common failures & fixes
- CORS / preflight blocked → invoker not granted → grant-invokers.sh
- 500 PERMISSION_DENIED (Firestore) → runtime SA missing datastore.user → iam-setup.sh
- Build failed, missing build SA permission → iam-setup.sh (build roles)
- "wrong organization" / empty → VITE_ORG_ID ≠ ORG_ID ≠ claim orgId
- QR 404 → hosting site not created/targeted, or VITE_APP_HOST wrong
