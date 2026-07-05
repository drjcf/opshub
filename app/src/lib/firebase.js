// src/lib/firebase.js — client SDK init. Config from Vite env (VITE_*).
// Standalone deployments set VITE_ORG_ID; hosted multi-tenant resolves org
// from the signed-in user's custom claim instead.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const dbc = getFirestore(app);
export const fns = getFunctions(app, import.meta.env.VITE_FB_REGION || 'us-central1');

// Baked-in org for standalone; overridden by claim in AuthProvider when present.
export const CONFIG_ORG_ID = import.meta.env.VITE_ORG_ID || null;
