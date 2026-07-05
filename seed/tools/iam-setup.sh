#!/usr/bin/env bash
# iam-setup.sh — grant a fresh OpsHub deployment every IAM role it needs.
# New GCP projects start the compute default service account with almost no
# roles; each capability (build, Firestore, secrets, token signing) must be
# granted explicitly the first time a function uses it. This applies the full
# set in one pass so a deployment doesn't rediscover each wall at runtime.
#
# Run once per deployment, after `firebase deploy`, before first real use.
# Usage: ./seed/tools/iam-setup.sh [project-id]
#
# Requires: you are an Owner/Editor on the project (uses your gcloud identity).
set -euo pipefail

PROJECT="${1:-edai-opshub}"

# Resolve the project NUMBER → compute default SA (used by v2 functions).
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
RUNTIME_SA="${NUM}-compute@developer.gserviceaccount.com"
BUILD_SA="${NUM}-compute@developer.gserviceaccount.com"  # same SA does builds by default

echo "Project:      $PROJECT ($NUM)"
echo "Runtime SA:   $RUNTIME_SA"
echo

# --- roles the RUNTIME service account needs to execute functions ---
RUNTIME_ROLES=(
  roles/datastore.user                 # Firestore read/write (Admin SDK)
  roles/secretmanager.secretAccessor   # read PUBLISHER_PRIVATE_KEY, RESEND_API_KEY
  roles/iam.serviceAccountTokenCreator # setCustomUserClaims (surveyorGrant/Revoke)
  roles/eventarc.eventReceiver         # Firestore-trigger functions
  roles/run.invoker                    # trigger functions invoke each other / eventarc
)

# --- roles the BUILD path needs (fresh projects miss these) ---
BUILD_ROLES=(
  roles/cloudbuild.builds.builder
  roles/logging.logWriter
  roles/artifactregistry.writer
  roles/storage.objectAdmin
)

grant() {
  local sa="$1" role="$2"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$sa" --role="$role" \
    --condition=None --quiet >/dev/null \
    && echo "  ✓ $role" \
    || echo "  — $role (failed)"
}

echo "Runtime roles → $RUNTIME_SA"
for R in "${RUNTIME_ROLES[@]}"; do grant "$RUNTIME_SA" "$R"; done
echo
echo "Build roles → $BUILD_SA"
for R in "${BUILD_ROLES[@]}"; do grant "$BUILD_SA" "$R"; done

echo
echo "Done. IAM propagation takes ~1 minute."
echo "Next: ./seed/tools/grant-invokers.sh $PROJECT   # public invoke on callables"
