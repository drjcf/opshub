# Bootstrap — one-time deployment setup

Stands up the org, your owner account, and seed data so the admin console
renders a real crash cart (with expirations that exercise the status system).

## Prereqs
1. Firebase project `edai-opshub` exists (Firestore in Native mode, Auth
   with Email/Password enabled).
2. Service account JSON at /home/drjcf/opshub/serviceaccount.json
   (Firebase console → Project settings → Service accounts → Generate key).
   This file is gitignored — never commit it.
3. Rules + indexes deployed:  firebase deploy --only firestore

## Run
    cd seed/bootstrap && npm install && cd ../..
    export GOOGLE_APPLICATION_CREDENTIALS=/home/drjcf/opshub/serviceaccount.json
    node seed/bootstrap/bootstrap.js

Prints a temp password on first run (owner account). Sign in, then change it.
Idempotent — safe to re-run; updates in place.
