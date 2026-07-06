// src/components/ExportButton.jsx — one-click export to Google Docs/Sheets.
import { useState } from 'react';
import { isExportConfigured } from '../lib/googleExport.js';

export default function ExportButton({ label, build, ghost }) {
  const [state, setState] = useState('idle'); // idle | working | done
  const [link, setLink] = useState('');
  const [err, setErr] = useState('');

  if (!isExportConfigured()) return null; // hidden until VITE_GOOGLE_OAUTH_CLIENT_ID is set

  async function go() {
    setState('working'); setErr('');
    try {
      const { link } = await build();
      setLink(link); setState('done');
      if (link) window.open(link, '_blank');
    } catch (e) { setErr(e.message); setState('idle'); }
  }

  if (state === 'done' && link) {
    return <a className={`btn ${ghost ? 'ghost' : ''} sm`} href={link} target="_blank" rel="noreferrer">Open in Drive ↗</a>;
  }
  return (
    <>
      <button className={`btn ${ghost ? 'ghost' : ''} sm`} onClick={go} disabled={state === 'working'}>
        {state === 'working' ? 'Exporting…' : (label || 'Export to Google')}
      </button>
      {err && <span className="err" style={{ marginLeft: 8, fontSize: 12 }}>{err}</span>}
    </>
  );
}
