// src/routes/Library.jsx — unified document library.
// Controlled P&P docs + general archive files, folders, tags, search.
import { useEffect, useState, useCallback } from 'react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { getStorage, ref as sref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { dbc, app } from '../lib/firebase.js';
import { useAuth, useCallableFactory } from '../lib/auth.jsx';
import { Loader, Empty, StatusPill, Modal } from '../components/ui.jsx';

const fmtSize = (b) => !b ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(0)} KB` : `${(b/1048576).toFixed(1)} MB`;

export default function Library() {
  const { orgId, isAdmin } = useAuth();
  const mkCallable = useCallableFactory();
  const [folders, setFolders] = useState([]);
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [folderId, setFolderId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(query(collection(dbc, `orgs/${orgId}/folders`), orderBy('path')),
      (snap) => setFolders(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setErr(e.message));
  }, [orgId]);

  const runSearch = useCallback(async () => {
    setRows(null); setErr('');
    try {
      const r = await mkCallable('librarySearch')({ q, folderId });
      setRows(r.rows);
    } catch (e) { setErr(e.message); setRows([]); }
  }, [q, folderId, mkCallable]);

  useEffect(() => { if (orgId) runSearch(); }, [orgId, folderId]); // eslint-disable-line

  return (
    <>
      <div className="page-head">
        <div><h1>Library</h1><p>Controlled policies and general document archive.</p></div>
        {isAdmin && <button className="btn" onClick={() => setUploading(true)}>Upload file</button>}
      </div>
      {err && <div className="err">{err}</div>}

      <div className="card card-pad" style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          placeholder="Search by title or tag…" style={{ flex: 1 }} />
        <button className="btn ghost" onClick={runSearch}>Search</button>
      </div>

      <div className="crosswalk">
        <div className="card std-tree" style={{ padding: 8 }}>
          <button className={`std-item ${!folderId ? 'active' : ''}`} onClick={() => setFolderId(null)}>
            <span className="std-ref" style={{ fontWeight: 600 }}>All files</span>
          </button>
          {folders.map((f) => (
            <button key={f.id} className={`std-item ${folderId === f.id ? 'active' : ''}`}
              onClick={() => setFolderId(f.id)}>
              <span className="std-ref">{f.path}</span>
            </button>
          ))}
          {isAdmin && <button className="btn ghost sm" style={{ margin: 8, width: 'calc(100% - 16px)' }}
            onClick={() => setNewFolder(true)}>+ New folder</button>}
        </div>

        <div className="card std-detail">
          {rows === null ? <Loader /> : rows.length === 0 ? (
            <Empty title="No documents">Upload a file or adjust your search.</Empty>
          ) : (
            <table>
              <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Tags</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.title}
                      {r.size ? <span className="muted" style={{ fontWeight: 400 }}> · {fmtSize(r.size)}</span> : null}</td>
                    <td><StatusPill kind={r.kind === 'controlled' ? 'ok' : 'idle'}>
                      {r.kind === 'controlled' ? 'Policy' : 'Archive'}</StatusPill></td>
                    <td className="muted">{r.status || '—'}</td>
                    <td>{(r.tags || []).map((t) => <span key={t} className="pill st-idle" style={{ marginRight: 4 }}>{t}</span>)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {r.kind === 'archive' && r.storagePath &&
                        <DownloadLink orgId={orgId} storagePath={r.storagePath} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {uploading && <UploadModal folders={folders} mkCallable={mkCallable} orgId={orgId}
        onClose={() => setUploading(false)} onDone={() => { setUploading(false); runSearch(); }} onErr={setErr} />}
      {newFolder && <FolderModal folders={folders} mkCallable={mkCallable}
        onClose={() => setNewFolder(false)} onDone={() => setNewFolder(false)} onErr={setErr} />}
    </>
  );
}

function DownloadLink({ storagePath }) {
  const [url, setUrl] = useState(null);
  async function open() {
    try { const u = await getDownloadURL(sref(getStorage(app), storagePath)); setUrl(u); window.open(u, '_blank'); }
    catch (e) { /* ignore */ }
  }
  return <button className="btn ghost sm" onClick={open}>Open</button>;
}

function UploadModal({ folders, mkCallable, orgId, onClose, onDone, onErr }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [folderId, setFolderId] = useState('');
  const [tags, setTags] = useState('');
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState('pick');

  async function run() {
    if (!file) return;
    setPhase('uploading'); onErr('');
    const fileId = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const path = `orgs/${orgId}/library/${fileId}/${file.name}`;
    const task = uploadBytesResumable(sref(getStorage(app), path), file, { contentType: file.type });
    task.on('state_changed',
      (s) => setPct(Math.round((s.bytesTransferred / s.totalBytes) * 100)),
      (e) => { onErr(e.message); setPhase('pick'); },
      async () => {
        try {
          await mkCallable('libraryRegisterFile')({
            title: title.trim() || file.name, storagePath: path,
            contentType: file.type, size: file.size,
            folderId: folderId || null,
            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          });
          onDone();
        } catch (e) { onErr(e.message); setPhase('pick'); }
      });
  }

  return (
    <Modal title="Upload file" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={run} disabled={!file || phase !== 'pick'}>
          {phase === 'uploading' ? `Uploading ${pct}%` : 'Upload'}</button>
      </>}>
      <label className="field"><span>File</span>
        <input type="file" onChange={(e) => { const f = e.target.files?.[0]; setFile(f); if (f && !title) setTitle(f.name); }} /></label>
      <label className="field"><span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>Folder</span>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">(none)</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}
        </select></label>
      <label className="field"><span>Tags (comma-separated)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="infection-control, 2026" /></label>
    </Modal>
  );
}

function FolderModal({ folders, mkCallable, onClose, onDone, onErr }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  async function create() {
    if (!name.trim()) return;
    try { await mkCallable('libraryCreateFolder')({ name: name.trim(), parentId: parentId || null }); onDone(); }
    catch (e) { onErr(e.message); }
  }
  return (
    <Modal title="New folder" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={create} disabled={!name.trim()}>Create</button>
      </>}>
      <label className="field"><span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="field"><span>Parent folder</span>
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">(top level)</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}
        </select></label>
    </Modal>
  );
}
