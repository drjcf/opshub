// functions/src/llm-assist.js — LLM features for the handbook/compliance layer.
// EVERYTHING here DRAFTS; nothing auto-commits. Human confirms before any
// LLM output becomes live data (the Liability Rule).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  db, FieldValue,
  requireAuth, requireOrg, requireRole, actor, auditDirect,
} from './util.js';
import { chat, extractJson, ANTHROPIC_API_KEY } from './llm.js';

const withSecrets = { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300 };

// ---------------- llm.draftShortRefs ----------------
// Generate paraphrased shortRef labels for standards that lack them.
// shortRefs are OpsHub's OWN paraphrases (not AAAHC text) — the LLM writes
// a short neutral label from the licensee's entered text. Staged, not committed.
export const llmDraftShortRefs = onCall(withSecrets, async (req) => {
  const auth = requireAuth(req);
  const { orgId, codes } = req.data || {}; // optional: specific standard codes
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);

  const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
  if (!lic.exists || lic.get('status') !== 'active') {
    throw new HttpsError('failed-precondition', 'Attest a handbook license first.');
  }
  const edition = lic.get('edition');

  // Pull ALL entered handbook text for this edition (standards + elements).
  // v44 puts most requirement text on elements, so build each standard's
  // context from its own text PLUS its elements' text.
  const entries = await db.collection(`orgs/${orgId}/handbookEntries`)
    .where('edition', '==', edition).limit(1500).get();

  // Group text by standard code.
  const byStandard = {};
  for (const d of entries.docs) {
    const e = d.data();
    if (e.kind === 'guidance') continue;
    const sc = e.standardCode || e.code;
    (byStandard[sc] ||= { code: sc, parts: [] });
    if (e.text) byStandard[sc].parts.push(e.text);
  }

  // Which standards still need a shortRef? Read the citation tree.
  const stdSnap = await db.collection(`standardsEditions/${edition}/standards`).get();
  const needsLabel = stdSnap.docs
    .filter((d) => !d.get('shortRef') && !d.get('shortRefDraft'))
    .map((d) => d.get('code'))
    .filter((c) => !codes || codes.includes(c));

  const targets = needsLabel
    .map((sc) => ({ code: sc, text: (byStandard[sc]?.parts.join(' ') || '').slice(0, 500) }))
    .filter((t) => t.text.length > 10)
    .slice(0, 40);

  if (targets.length === 0) return { drafted: 0, note: 'No standards with text needing labels.' };

  const items = targets;
  const sys = 'You write concise neutral topic labels (max 8 words) summarizing what a ' +
    'medical accreditation standard covers. Return ONLY JSON: {"labels":[{"code","label"}]}. ' +
    'Labels are your own words, not quotes from the input.';
  const user = `Write a short label for each standard based on its text:\n${JSON.stringify(items)}`;

  const { text } = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 1500, json: true, temperature: 0.2 }
  );
  const parsed = extractJson(text);

  // Stage as drafts on the standards (shortRefDraft), not the live shortRef.
  let batch = db.batch();
  let n = 0;
  for (const { code, label } of parsed.labels || []) {
    const id = code.replace(/\./g, '-');
    batch.set(db.doc(`standardsEditions/${edition}/standards/${id}`),
      { shortRefDraft: String(label).slice(0, 80), shortRefDraftBy: who.displayNameSnapshot }, { merge: true });
    if (++n % 300 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  await auditDirect(orgId, 'llm.draftShortRefs', `standardsEditions/${edition}`, null, { drafted: n }, who);
  return { drafted: n, note: 'Draft labels staged. Review and confirm to publish as shortRefs.' };
});

// ---------------- llm.confirmShortRefs ----------------
export const llmConfirmShortRefs = onCall(async (req) => {
  const auth = requireAuth(req);
  const { orgId, edition, codes } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector']);
  const who = actor(auth);
  const stds = await db.collection(`standardsEditions/${edition}/standards`).get();
  let batch = db.batch(); let n = 0;
  for (const d of stds.docs) {
    const draft = d.get('shortRefDraft');
    if (!draft) continue;
    if (codes && !codes.includes(d.get('code'))) continue;
    batch.update(d.ref, { shortRef: draft, shortRefDraft: FieldValue.delete(), shortRefDraftBy: FieldValue.delete() });
    if (++n % 300 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  await auditDirect(orgId, 'llm.confirmShortRefs', `standardsEditions/${edition}`, null, { confirmed: n }, who);
  return { confirmed: n };
});

// ---------------- llm.ask ----------------
// In-app Q&A grounded in the org's own standards + evidence. Read-only:
// answers questions, never writes. Retrieves relevant context, asks the LLM,
// returns the answer with the standards it drew on.
export const llmAsk = onCall(withSecrets, async (req) => {
  const auth = requireAuth(req);
  const { orgId, question } = req.data || {};
  requireOrg(auth, orgId);
  requireRole(auth, ['owner', 'admin', 'clinicalDirector', 'staff']);
  if (!question || question.length < 3) throw new HttpsError('invalid-argument', 'Ask a question.');

  const lic = await db.doc(`orgs/${orgId}/handbookConfig/license`).get();
  const edition = lic.exists ? lic.get('edition') : null;

  // Lightweight retrieval: keyword-match standards by shortRef + domain, and
  // pull recent obligations. (A vector index is a later upgrade; keyword is
  // enough to ground answers for now.)
  const qWords = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const [stdsSnap, oblSnap] = await Promise.all([
    edition ? db.collection(`standardsEditions/${edition}/standards`).limit(400).get() : Promise.resolve({ docs: [] }),
    db.collection(`orgs/${orgId}/obligations`).where('status', '==', 'active').limit(100).get(),
  ]);

  const scored = stdsSnap.docs.map((d) => {
    const hay = `${d.get('code')} ${d.get('shortRef') || ''} ${d.get('domain') || ''}`.toLowerCase();
    const score = qWords.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    return { code: d.get('code'), shortRef: d.get('shortRef') || '', score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);

  const obligations = oblSnap.docs.map((d) => ({
    title: d.get('title'),
    refs: (d.get('standardRefs') || []).map((r) => r.code).filter(Boolean),
  })).slice(0, 30);

  const context = {
    standards: scored.map((s) => ({ code: s.code, topic: s.shortRef })),
    obligations,
  };
  const sys = 'You help clinic staff understand their AAAHC compliance setup. Answer using ' +
    'ONLY the provided context (their standards and obligations). If the answer is not in ' +
    'context, say so and suggest where to look. Be concise. Cite standard codes you use. ' +
    'You do NOT have the handbook text itself — refer to standards by code and topic.';
  const user = `Question: ${question}\n\nContext:\n${JSON.stringify(context)}`;

  const { text } = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 700, temperature: 0.3 }
  );

  return {
    answer: text,
    usedStandards: scored.map((s) => s.code),
    grounded: scored.length > 0 || obligations.length > 0,
  };
});
