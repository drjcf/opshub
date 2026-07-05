// src/components/HandbookUpload.jsx — upload the licensee's purchased PDF to
// their own GCS bucket, then trigger in-tenant parsing. The file and its text
// stay in the org's tenant.
import { useState } from 'react';
import { getStorage, ref, uploadBytesResumable } from 'firebase/storage';
import { app } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Modal } from './ui.jsx';

export default function HandbookUpload({ edition, onClose, onDone }) {
  const { orgId } = useAuth();
  const mkCallable = useCallableFactory();
  const [file, setFile] = useState(null);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState('pick'); // pick | uploading | parsing | done
  const [seedTree, setSeedTree] = useState(true);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function run() {
    if (!file) return;
    setErr(''); setPhase('uploading');
    const storage = getStorage(app);
    const path = `orgs/${orgId}/handbook/${edition}/${file.name}`;
    const task = uploadBytesResumable(ref(storage, path), file, { contentType: 'application/pdf' });

    task.on('state_changed',
      (snap) => setPct(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      (e) => { setErr(e.message); setPhase('pick'); },
      async () => {
        setPhase('parsing');
        try {
          const r = await mkCallable('handbookIngestFromUpload')({
            storagePath: path, seedCitationTree: seedTree,
          });
          setResult(r); setPhase('done');
        } catch (e) { setErr(e.message); setPhase('pick'); }
      });
  }

  return (
    <Modal title="Upload handbook PDF" onClose={onClose}
      footer={phase === 'done'
        ? <button className="btn" onClick={() => { onDone?.(); onClose(); }}>Done</button>
        : <>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" onClick={run} disabled={!file || phase !== 'pick'}>
              {phase === 'uploading' ? `Uploading ${pct}%` : phase === 'parsing' ? 'Parsing…' : 'Upload & parse'}
            </button>
          </>}>
      {err && <div className="err">{err}</div>}

      {phase === 'done' ? (
        <div>
          <p className="scan-lead" style={{ color: 'var(--ok)' }}>Parsed {result.pages} pages.</p>
          <p>Staged <strong>{result.staged}</strong> draft entries across domains: {result.domains.join(', ')}.</p>
          {result.treeSeeded > 0 && <p className="muted">Seeded {result.treeSeeded} standards into the citation tree.</p>}
          <p className="muted">{result.note}</p>
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginBottom: 14 }}>
            Upload your organization's purchased AAAHC handbook PDF. It is stored privately
            in your tenant and parsed into per-standard draft entries for your review.
            OpsHub does not distribute AAAHC content.
          </p>
          <label className="field"><span>Handbook PDF (edition {edition})</span>
            <input type="file" accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
          <label className="row" style={{ marginTop: 4 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={seedTree}
              onChange={(e) => setSeedTree(e.target.checked)} />
            <span className="muted">Also populate the standards citation tree (codes & structure only)</span>
          </label>
          {phase === 'parsing' && <p className="muted" style={{ marginTop: 12 }}>
            Parsing a large handbook can take a minute…</p>}
        </>
      )}
    </Modal>
  );
}
