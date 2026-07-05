// src/lib/auth.jsx — session + claims (orgId, roles) + a typed callable helper.
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, fns, CONFIG_ORG_ID } from './firebase.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [claims, setClaims] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() =>
    onAuthStateChanged(auth, async (u) => {
      if (u) {
        const tok = await u.getIdTokenResult();
        setUser(u);
        setClaims(tok.claims);
      } else {
        setUser(null);
        setClaims(null);
      }
      setLoading(false);
    }), []);

  const orgId = claims?.orgId || CONFIG_ORG_ID || null;
  const roles = claims?.roles || [];
  const has = useCallback((...r) => r.some((x) => roles.includes(x)), [roles]);
  const isAdmin = has('owner', 'admin');

  const value = {
    user, orgId, roles, has, isAdmin, loading,
    login: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
    logout: () => signOut(auth),
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);

// Callable helper: auto-injects orgId, unwraps .data, surfaces a clean message.
export function useCallableFactory() {
  const { orgId } = useAuth();
  return useCallback((name) => async (payload = {}) => {
    const fn = httpsCallable(fns, name);
    try {
      const res = await fn({ orgId, ...payload });
      return res.data;
    } catch (e) {
      throw new Error(e?.message || 'Request failed.');
    }
  }, [orgId]);
}
