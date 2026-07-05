// functions/src/llm.js — provider abstraction. OpsHub calls chat(); the
// concrete backend is chosen per-deployment via config, so the same code runs
// on Claude (Ferguson) or an on-prem MedGemma/DeepSeek (privacy-strict
// licensee). Handbook text sent to the LLM never leaves the licensee's chosen
// provider — for local models, that means it never leaves their infra.
//
// Config (functions params / secrets):
//   LLM_PROVIDER   = "local" | "anthropic"    (default "local")
//   LLM_BASE_URL   = OpenAI-compatible base, e.g. http://ollama.internal:11434/v1
//   LLM_MODEL      = model id, e.g. "medgemma" | "deepseek-r1" | "claude-sonnet-4-6"
//   ANTHROPIC_API_KEY (secret, only if provider=anthropic)

import { defineString, defineSecret } from 'firebase-functions/params';
import { HttpsError } from 'firebase-functions/v2/https';

export const LLM_PROVIDER = defineString('LLM_PROVIDER', { default: 'local' });
export const LLM_BASE_URL = defineString('LLM_BASE_URL', { default: '' });
export const LLM_MODEL = defineString('LLM_MODEL', { default: 'medgemma' });
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Unified call. messages: [{role:'system'|'user'|'assistant', content}]
// Returns { text }.
export async function chat(messages, { maxTokens = 1024, temperature = 0.2, json = false } = {}) {
  const provider = LLM_PROVIDER.value();
  if (provider === 'anthropic') return chatAnthropic(messages, { maxTokens, temperature, json });
  return chatLocalOpenAI(messages, { maxTokens, temperature, json });
}

// ---- Local / any OpenAI-compatible server (Ollama, vLLM, LM Studio) ----
async function chatLocalOpenAI(messages, { maxTokens, temperature, json }) {
  const base = LLM_BASE_URL.value();
  if (!base) throw new HttpsError('failed-precondition',
    'LLM_BASE_URL not set. Point it at your OpenAI-compatible endpoint (Ollama/vLLM).');
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL.value(),
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new HttpsError('internal', `LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? '' };
}

// ---- Anthropic Claude ----
async function chatAnthropic(messages, { maxTokens, temperature }) {
  const key = ANTHROPIC_API_KEY.value();
  if (!key) throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY secret not set.');
  // Split system from turns (Anthropic takes system separately).
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LLM_MODEL.value() || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: turns,
    }),
  });
  if (!res.ok) throw new HttpsError('internal', `Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text };
}

// Parse a JSON object from an LLM response that may be fenced or chatty.
export function extractJson(text) {
  const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new HttpsError('internal', 'LLM did not return valid JSON.');
  }
}
