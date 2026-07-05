#!/usr/bin/env bash
# Grant public invoke (roles/run.invoker to allUsers) on browser-callable
# Cloud Run services. v2 Firebase callables run on Cloud Run; on new projects
# they aren't publicly invokable by default, so the browser CORS preflight
# (OPTIONS) is rejected before the function runs — surfacing as a CORS error.
# Callables enforce auth internally via request.auth; public invoke is safe.
#
# Run after any deploy that ADDS a new browser-called callable.
# Usage: ./seed/tools/grant-invokers.sh [project-id] [region]
set -euo pipefail

PROJECT="${1:-edai-opshub}"
REGION="${2:-us-central1}"

# Browser-invoked callables + the public verify endpoint.
# Scheduled/triggered functions are intentionally EXCLUDED (not public).
SERVICES=(
  scanResolve taskCompleteFromScan logAdhoc registerCheckSubmit
  evidenceFinalize evidenceSupersede documentApproveVersion
  checkpointMint checkpointRotateToken surveyorGrant surveyorRevoke
  coursePublish enrollmentLessonView lessonMarkComplete quizSubmit
  trainingAttest trainingApproveExternal trainingMatrix
  catalogImportPackage catalogExportPackage
  verifyCertificate
)

echo "Granting run.invoker to allUsers on ${#SERVICES[@]} services in $PROJECT/$REGION…"
for FN in "${SERVICES[@]}"; do
  # Firebase v2 lowercases camelCase function names for Cloud Run service names.
  SVC=$(echo "$FN" | tr '[:upper:]' '[:lower:]')
  if gcloud run services add-iam-policy-binding "$SVC" \
       --region="$REGION" --project="$PROJECT" \
       --member=allUsers --role=roles/run.invoker --quiet >/dev/null 2>&1; then
    echo "  ✓ $SVC"
  else
    echo "  — $SVC (not deployed yet, skipped)"
  fi
done
echo "Done. IAM changes take effect within ~1 minute."
