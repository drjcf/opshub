# OpsHub — LLM Layer Setup

Provider abstraction: OpsHub calls `chat()`; the backend is per-deployment.
EVERYTHING drafts; humans confirm before LLM output becomes live data.

## Config (functions params + secret)
    LLM_PROVIDER   "local" | "anthropic"        (default: local)
    LLM_BASE_URL   OpenAI-compatible base URL    (local only)
    LLM_MODEL      model id
    ANTHROPIC_API_KEY   secret                   (anthropic only)

## Option A — your local model (MedGemma / DeepSeek), inference stays on-prem
Run an OpenAI-compatible server in front of the model:

  # Ollama (simplest)
  ollama serve
  ollama pull medgemma            # or your local model name
  # exposes http://localhost:11434/v1

  # vLLM (higher throughput)
  vllm serve <model> --api-key ... # exposes /v1

Cloud Functions can't reach a home-lab localhost directly. Make it reachable:
  - Cloud Run service proxying to the model, OR
  - a tunnel (Cloud Run + Tailscale, ngrok, or a static endpoint on DUDESTER)
Then set:
  firebase functions:config unavailable in v2 — use .env or params:
  echo 'LLM_PROVIDER=local'                  >> functions/.env.edai-opshub
  echo 'LLM_BASE_URL=https://your-endpoint/v1' >> functions/.env.edai-opshub
  echo 'LLM_MODEL=medgemma'                   >> functions/.env.edai-opshub

Handbook text sent to a LOCAL provider never leaves your infrastructure.

## Option B — Claude API (best quality; text transits Anthropic)
  echo 'LLM_PROVIDER=anthropic' >> functions/.env.edai-opshub
  echo 'LLM_MODEL=claude-sonnet-4-6' >> functions/.env.edai-opshub
  firebase functions:secrets:set ANTHROPIC_API_KEY   # paste key

Use for your own org if comfortable; for licensees under handbook terms that
restrict redistribution, prefer Option A (on-prem).

## Features wired
- llmDraftShortRefs / llmConfirmShortRefs — paraphrased standard labels
  (drafted → reviewed → published). shortRefs are OpsHub's own words.
- llmAsk — in-app Q&A grounded in the org's standards + obligations.
  Read-only; cites standard codes; says so when unsure.
- handbookIngestFromUpload — parses the licensee's PDF (pdfjs, in-tenant);
  the LLM is NOT required for parsing (deterministic), but can assist labels
  after.

## After deploy: grant invoke on the new callables
  for FN in llmdraftshortrefs llmconfirmshortrefs llmask \
            handbookattestlicense handbooksetentry handbookremoveedition \
            handbookgetcrosswalk handbookingestfromupload handbookconfirmdrafts; do
    gcloud run services add-iam-policy-binding \$FN --region=us-central1 \
      --project=edai-opshub --member=allUsers --role=roles/run.invoker --quiet
  done
