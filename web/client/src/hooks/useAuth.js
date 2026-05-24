import { useState, useEffect, useCallback } from 'react';
import { loginWithGoogle } from '../lib/googleAuth.js';
import {
  loginWithEmailPassword,
  signUpWithEmailPassword,
  buildAuthUser,
  normalizeUserId,
  toDisplayName,
} from '../lib/firebase.js';
import { loadAuthSession, saveAuthSession } from '../lib/utils.js';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY?.trim() || '';
const PROFILE_STORE_KEY = 'kafkaChatProfiles';
const LOCAL_ACCOUNTS_KEY = 'kafkaChatAccounts';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function loadStore(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getProfile(email) {
  const profiles = loadStore(PROFILE_STORE_KEY);
  return profiles[email] || null;
}

function saveProfile(email, profile) {
  const profiles = loadStore(PROFILE_STORE_KEY);
  profiles[email] = profile;
  saveStore(PROFILE_STORE_KEY, profiles);
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(hashBuffer));
  return btoa(bytes.map((byte) => String.fromCharCode(byte)).join(''));
}

// Lightweight local fallback when no hosted auth is configured.
async function registerLocalAccount(email, password) {
  const accounts = loadStore(LOCAL_ACCOUNTS_KEY);
  if (accounts[email]) {
    throw new Error('This email is already registered.');
  }
  accounts[email] = { passwordHash: await hashPassword(password) };
  saveStore(LOCAL_ACCOUNTS_KEY, accounts);
}

async function verifyLocalAccount(email, password) {
  const accounts = loadStore(LOCAL_ACCOUNTS_KEY);
  const record = accounts[email];
  if (!record) {
    throw new Error('Invalid email or password.');
  }
  const passwordHash = await hashPassword(password);
  if (record.passwordHash !== passwordHash) {
    throw new Error('Invalid email or password.');
  }
}

function applyProfile(user, profile) {
  if (!profile) return user;
  return {
    ...user,
    displayName: profile.name?.trim() || user.displayName,
    phone: profile.phone || '',
    avatarUrl: profile.avatarUrl || '',
  };
}

function buildProfileUser(email, profile) {
  const userId = normalizeUserId(email);
  return {
    userId,
    displayName: profile?.name?.trim() || toDisplayName(email, userId),
    email,
    phone: profile?.phone || '',
    avatarUrl: profile?.avatarUrl || '',
    provider: 'email',
  };
}

export default function useAuth() {
  const [authUser, setAuthUser] = useState(loadAuthSession);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => { saveAuthSession(authUser); }, [authUser]);

  const issueDevToken = useCallback(async (user = authUser) => {
    if (!user?.userId) throw new Error('Sign in first');
    const params = new URLSearchParams({ user_id: user.userId });
    if (user.displayName) params.set('name', user.displayName);
    const res = await fetch(`${GATEWAY_HTTP}/dev/token?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to create gateway token');
    setToken(data.token);
    return data.token;
  }, [authUser]);

  const finalizeAuth = useCallback(async (user) => {
    setAuthUser(user);
    setAuthError('');
    try {
      await issueDevToken(user);
    } catch (e) {
      setAuthError(`Signed in, but chat token creation failed: ${e.message}`);
    }
  }, [issueDevToken]);

  const handleGoogleAuth = useCallback(async () => {
    setAuthError('');
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
    if (!clientId) {
      setAuthError('Google sign-in is not configured for this environment.');
      return;
    }

    setAuthBusy(true);
    try {
      const user = await loginWithGoogle(clientId);
      if (user.email) {
        const existingProfile = getProfile(user.email);
        if (!existingProfile) {
          saveProfile(user.email, { name: user.displayName, phone: '', avatarUrl: '' });
        }
      }
      await finalizeAuth(applyProfile(user, user.email ? getProfile(user.email) : null));
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }, [finalizeAuth]);

  const handleEmailSignIn = useCallback(async ({ email, password }) => {
    setAuthError('');
    setAuthBusy(true);
    try {
      const emailKey = normalizeEmail(email);
      if (!emailKey || !password) throw new Error('Enter your email and password.');

      let user;
      if (FIREBASE_API_KEY) {
        const result = await loginWithEmailPassword(FIREBASE_API_KEY, emailKey, password);
        user = applyProfile(buildAuthUser(result, 'email'), getProfile(emailKey));
      } else {
        await verifyLocalAccount(emailKey, password);
        user = buildProfileUser(emailKey, getProfile(emailKey));
      }

      await finalizeAuth(user);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }, [finalizeAuth]);

  const handleEmailSignUp = useCallback(async ({ name, email, password, phone, avatarUrl }) => {
    setAuthError('');
    setAuthBusy(true);
    try {
      const emailKey = normalizeEmail(email);
      if (!name || !emailKey || !password) {
        throw new Error('Fill out all required fields.');
      }

      const profile = {
        name: name.trim(),
        phone: (phone || '').trim(),
        avatarUrl: (avatarUrl || '').trim(),
      };

      let user;
      if (FIREBASE_API_KEY) {
        const result = await signUpWithEmailPassword(FIREBASE_API_KEY, emailKey, password);
        user = applyProfile(buildAuthUser(result, 'email'), profile);
      } else {
        await registerLocalAccount(emailKey, password);
        user = buildProfileUser(emailKey, profile);
      }

      saveProfile(emailKey, profile);

      await finalizeAuth(user);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }, [finalizeAuth]);

  const handleLogout = useCallback(() => {
    setAuthUser(null);
    setToken('');
    setAuthError('');
  }, []);

  return {
    authUser,
    authBusy,
    authError,
    setAuthError,
    token,
    setToken,
    issueDevToken,
    handleGoogleAuth,
    handleEmailSignIn,
    handleEmailSignUp,
    handleLogout,
  };
}
