let googleScriptPromise;

function mapFirebaseError(errorCode) {
  const normalized = String(errorCode || 'UNKNOWN_ERROR').toUpperCase();
  const map = {
    EMAIL_EXISTS: 'This email is already registered. Please sign in instead.',
    INVALID_EMAIL: 'That email address is not valid.',
    MISSING_PASSWORD: 'Password is required.',
    WEAK_PASSWORD: 'Password is too weak. Use at least 6 characters.',
    INVALID_LOGIN_CREDENTIALS: 'Invalid email or password.',
    USER_DISABLED: 'This account has been disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
    INVALID_IDP_RESPONSE: 'Google login failed. Please retry.',
    OPERATION_NOT_ALLOWED: 'This sign-in method is disabled for this project.',
    UNKNOWN_ERROR: 'Authentication failed. Check your auth configuration and try again.',
  };
  return map[normalized] || `Authentication failed: ${normalized}`;
}

async function firebaseRequest(apiKey, action, payload) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${action}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(mapFirebaseError(data?.error?.message));
  }
  return data;
}

function ensureGoogleIdentityScript() {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve(window.google);
  }
  if (!googleScriptPromise) {
    googleScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.google?.accounts?.oauth2) {
          resolve(window.google);
          return;
        }
        reject(new Error('Google sign-in runtime unavailable after script load'));
      };
      script.onerror = () => reject(new Error('Failed to load Google sign-in script'));
      document.head.appendChild(script);
    });
  }
  return googleScriptPromise;
}

export async function loginWithEmailPassword(apiKey, email, password) {
  return firebaseRequest(apiKey, 'accounts:signInWithPassword', {
    email, password, returnSecureToken: true,
  });
}

export async function signUpWithEmailPassword(apiKey, email, password) {
  return firebaseRequest(apiKey, 'accounts:signUp', {
    email, password, returnSecureToken: true,
  });
}

export async function loginWithGoogleOAuth(apiKey, googleClientId) {
  await ensureGoogleIdentityScript();
  const tokenResponse = await new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: 'openid email profile',
      callback: (response) => {
        if (!response || response.error) {
          reject(new Error(response?.error_description || response?.error || 'Google sign-in canceled'));
          return;
        }
        resolve(response);
      },
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });

  const postBody = `providerId=google.com&access_token=${encodeURIComponent(tokenResponse.access_token)}`;
  return firebaseRequest(apiKey, 'accounts:signInWithIdp', {
    postBody,
    requestUri: window.location.origin,
    returnSecureToken: true,
    returnIdpCredential: true,
  });
}

export function normalizeUserId(value) {
  const normalized = String(value || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) return `user-${Math.random().toString(36).slice(2, 10)}`;
  return normalized.slice(0, 40);
}

export function toDisplayName(email, fallbackUserId) {
  if (!email || typeof email !== 'string') return fallbackUserId;
  const [namePart] = email.split('@');
  return namePart || fallbackUserId;
}

export function buildAuthUser(authResult, provider) {
  const fallbackSource = authResult.localId || authResult.email || authResult.displayName || 'chat-user';
  const userId = normalizeUserId(fallbackSource);
  const displayName = authResult.displayName || toDisplayName(authResult.email, userId);
  return {
    userId, displayName,
    email: authResult.email || '',
    provider,
    idToken: authResult.idToken || '',
  };
}
