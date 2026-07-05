// src/routes/Labels.jsx — generate printable QR labels for checkpoints.
// QR encodes the scan URL; token addresses location, auth still required.
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import QRCode from 'qrcode';
import { dbc, CONFIG_ORG_ID } from '../lib/firebase.js';
import { useAuth } from '../lib/auth.jsx';
import { Loader, Empty } from '../components/ui.jsx';

const APP_HOST = import.meta.env.VITE_APP_HOST || window.location.origin;

function scanUrl(orgId, token) {
  // Standalone: /s/:token (orgId from config). Hosted: /s/:orgId/:token.
  return CONFIG_ORG_ID ? `${APP_HOST}/s/${token}` : `${APP_HOST}/s/${orgId}/${token}`;
}

export default function Labels() {
  const { orgId } = useAuth();
  const [checkpoints, setCheckpoints] = useState(null);
  const [selected, setSelected] = useState({});
  const [dataUrls, setDataUrls] = useState({});

  useEffect(() => {
    if (!orgId) return;
    return onSnapshot(
      query(collection(dbc, `orgs/${orgId}/checkpoints`), where('active', '==', true)),
      (snap) => setCheckpoints(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [orgId]);

  useEffect(() => {
    if (!checkpoints) return;
    (async () => {
      const next = {};
      for (const c of checkpoints) {
        next[c.id] = await QRCode.toDataURL(scanUrl(orgId, c.qrToken), {
          width: 256, margin: 1, errorCorrectionLevel: 'M',
        });
      }
      setDataUrls(next);
    })();
  }, [checkpoints, orgId]);

  const chosen = (checkpoints || []).filter((c) => selected[c.id]);
  const allSelected = checkpoints && checkpoints.length > 0 && chosen.length === checkpoints.length;

  return (
    <>
      <div className="page-head no-print">
        <div><h1>Print labels</h1><p>Select checkpoints, then print. Place each label at its physical location.</p></div>
        <div className="row">
          <button className="btn ghost" onClick={() =>
            setSelected(allSelected ? {} : Object.fromEntries((checkpoints || []).map((c) => [c.id, true])))}>
            {allSelected ? 'Clear' : 'Select all'}</button>
          <button className="btn" disabled={chosen.length === 0} onClick={() => window.print()}>
            Print {chosen.length || ''} label{chosen.length === 1 ? '' : 's'}</button>
        </div>
      </div>

      {checkpoints === null ? <Loader /> : checkpoints.length === 0 ? (
        <Empty title="No active checkpoints">Create checkpoints first, then return here to print their labels.</Empty>
      ) : (
        <>
          <div className="card card-pad no-print" style={{ marginBottom: 16 }}>
            <div className="label-sheet">
              {checkpoints.map((c) => (
                <label key={c.id} className="qr-label" style={{
                  cursor: 'pointer', outline: selected[c.id] ? '2px solid var(--accent)' : 'none',
                }}>
                  <input type="checkbox" className="no-print" style={{ width: 'auto' }}
                    checked={!!selected[c.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))} />
                  {dataUrls[c.id]
                    ? <img src={dataUrls[c.id]} alt={`QR for ${c.label}`} />
                    : <div style={{ height: 128 }} />}
                  <div className="lbl">{c.label}</div>
                  <div className="loc">{c.location || ''}</div>
                </label>
              ))}
            </div>
          </div>

          {/* print-only sheet: chosen labels, 3-up */}
          <div className="label-sheet" style={{ display: 'none' }} data-print-sheet>
            {chosen.map((c) => (
              <div key={c.id} className="qr-label">
                <img src={dataUrls[c.id]} alt="" />
                <div className="lbl">{c.label}</div>
                <div className="loc">{c.location || ''}</div>
              </div>
            ))}
          </div>
          <style>{`@media print { [data-print-sheet] { display: grid !important; } }`}</style>
        </>
      )}
    </>
  );
}
