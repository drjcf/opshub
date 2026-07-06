// src/lib/googleExport.js — export OpsHub evidence to native Google Docs/Sheets
// in the signed-in user's OWN Drive. Uses Google Identity Services for a
// drive.file-scoped token (app only touches files it creates), then uploads
// HTML/CSV to Drive with the Google-native mimeType so Drive converts it to a
// real Doc/Sheet. No server-side token storage — fits license-don't-host.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || null;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

let gisLoaded = false;
let cachedToken = null;
let cachedExpiry = 0;

export function isExportConfigured() { return !!CLIENT_ID; }

function loadGIS() {
  if (gisLoaded && window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) { existing.addEventListener('load', () => { gisLoaded = true; resolve(); }); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => { gisLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load Google Identity Services.'));
    document.head.appendChild(s);
  });
}

async function getToken() {
  if (!CLIENT_ID) throw new Error('Google export is not configured (missing OAuth client ID).');
  if (cachedToken && Date.now() < cachedExpiry - 60000) return cachedToken;
  await loadGIS();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        cachedToken = resp.access_token;
        cachedExpiry = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3600000);
        resolve(cachedToken);
      },
    });
    client.requestAccessToken({ prompt: cachedToken ? '' : 'consent' });
  });
}

// Multipart upload to Drive, converting to a Google-native type.
async function uploadConvert(name, mimeSource, sourceType, googleMime) {
  const token = await getToken();
  const metadata = { name, mimeType: googleMime };
  const boundary = 'opshub' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: ${sourceType}; charset=UTF-8\r\n\r\n` +
    mimeSource +
    `\r\n--${boundary}--`;
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Drive upload failed (${res.status}). ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return { id: data.id, link: data.webViewLink };
}

export function exportToDoc(title, html) {
  return uploadConvert(title, html, 'text/html', 'application/vnd.google-apps.document');
}
export function exportToSheet(title, csv) {
  return uploadConvert(title, csv, 'text/csv', 'application/vnd.google-apps.spreadsheet');
}
