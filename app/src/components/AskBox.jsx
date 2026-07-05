// src/components/AskBox.jsx — grounded Q&A over the org's standards/obligations.
// Calls llmAsk (read-only). Shows the answer and which standards it drew on.
import { useState } from 'react';

export default function AskBox({ mkCallable }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState('');

  async function ask() {
    if (q.trim().length < 3) return;
    setBusy(true); setErr(''); setResp(null);
    try {
      const r = await mkCallable('llmAsk')({ question: q.trim() });
      setResp(r);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="card card-pad askbox">
      <div className="row" style={{ gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask about your standards — e.g. which standard covers crash cart checks?" />
        <button className="btn" onClick={ask} disabled={busy || q.trim().length < 3}>
          {busy ? 'Thinking…' : 'Ask'}</button>
      </div>
      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
      {resp && (
        <div className="ask-answer">
          <div className="ask-text">{resp.answer}</div>
          {resp.usedStandards?.length > 0 && (
            <div className="ask-cites">
              {resp.usedStandards.map((c) => <span key={c} className="pill st-idle">{c}</span>)}
            </div>
          )}
          {!resp.grounded && <div className="muted" style={{ marginTop: 8 }}>
            No matching standards found — answer may be limited. Try different terms or ingest your handbook.</div>}
          <div className="muted ask-disclaimer">AI-assisted answer from your own standards and obligations. Verify against your handbook.</div>
        </div>
      )}
    </div>
  );
}
