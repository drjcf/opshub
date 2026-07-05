// src/routes/HandbookDrafts.jsx — review parser output before it goes live.
// Staged draft entries (from handbookIngestFromUpload) are the parser's guess;
// the licensee confirms them into live handbookEntries. Nothing auto-commits.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { dbc } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill } from '../components/ui.jsx';

const KIND_KIND = { standard: 'ok', element: 'idle', guidance: 'warn' };

export default function HandbookDrafts() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [drafts, setDrafts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(
      query(collection(dbc, `orgs/${orgId}/handbookEntriesDraft`), orderBy('code')),
      (snap) => setDrafts(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setErr(e.message)
    );
  }, [orgId]);

  async function confirmAll() {
    setBusy(true); setErr('');
    try {
      const r = await mkCallable('handbookConfirmDrafts')({ codes: null });
      // list clears via listener as drafts are deleted
      setErr('');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  const shown = (drafts || []).filter((d) =>
    !filter || d.code.toLowerCase().includes(filter.toLowerCase()) || (d.domain || '').toLowerCase().includes(filter.toLowerCase()));

  const byDomain = {};
  for (const d of shown) (byDomain[d.domain || '—'] ||= []).push(d);

  return (
    <>
      <div className="page-head">
        <div><h1>Review handbook entries</h1>
          <p>Parsed from your uploaded PDF. Confirm to publish into your live handbook.</p></div>
        {isAdmin && drafts?.length > 0 &&
          <button className="btn" onClick={confirmAll} disabled={busy}>
            {busy ? 'Confirming…' : `Confirm all (${drafts.length})`}</button>}
      </div>
      {err && <div className="err">{err}</div>}

      {drafts === null ? <Loader /> : drafts.length === 0 ? (
        <div className="card"><Empty title="No drafts to review">
          Upload a handbook PDF from the Standards page to stage entries here.</Empty></div>
      ) : (
        <>
          <div className="card card-pad" style={{ marginBottom: 14 }}>
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by code or domain (ADM, ASG, …)" />
          </div>
          {Object.entries(byDomain).map(([domain, items]) => (
            <div className="card" key={domain} style={{ marginBottom: 14 }}>
              <div className="card-pad" style={{ borderBottom: '1px solid var(--line)', fontWeight: 700, color: 'var(--ink)' }}>
                {domain} <span className="muted tnum">· {items.length}</span>
              </div>
              <table>
                <thead><tr><th>Code</th><th>Kind</th><th>Text (parsed)</th><th>Page</th></tr></thead>
                <tbody>
                  {items.map((d) => (
                    <tr key={d.id}>
                      <td style={{ fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{d.code}</td>
                      <td><StatusPill kind={KIND_KIND[d.kind] || 'idle'}>{d.kind}</StatusPill></td>
                      <td className="muted" style={{ maxWidth: 460 }}>
                        {(d.text || '').slice(0, 180)}{(d.text || '').length > 180 ? '…' : ''}</td>
                      <td className="muted tnum">{d.pageRef || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </>
  );
}
