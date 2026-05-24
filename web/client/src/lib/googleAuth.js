let googleScriptPromise;

export function ensureGoogleIdentityScript() {
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

export async function loginWithGoogle(clientId) {
  await ensureGoogleIdentityScript();
  
  const tokenResponse = await new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
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

  // Fetch user info using the access token
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
  });
  
  if (!userInfoRes.ok) {
    throw new Error('Failed to fetch user info from Google');
  }

  const userInfo = await userInfoRes.json();
  
  // Normalize userId (extract from email or generate random)
  const normalizedEmail = userInfo.email ? String(userInfo.email).toLowerCase().split('@')[0] : '';
  const cleanId = normalizedEmail.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const userId = cleanId || `user-${Math.random().toString(36).slice(2, 10)}`;
  
  return {
    userId: userId.slice(0, 40),
    displayName: userInfo.name || userId,
    email: userInfo.email || '',
    provider: 'google',
  };
}
