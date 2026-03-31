import React, { useEffect, useMemo, useRef, useState } from 'react';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:8080/ws';
const AUTH_CONFIG_STORAGE_KEY = 'chat.auth.config.v1';
const AUTH_SESSION_STORAGE_KEY = 'chat.auth.session.v1';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let googleScriptPromise;

function loadStoredJson(key, fallbackValue) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallbackValue;
    }
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function persistStoredJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function normalizeUserId(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized) {
    return `user-${Math.random().toString(36).slice(2, 10)}`;
  }

  return normalized.slice(0, 40);
}

function toDisplayName(email, fallbackUserId) {
  if (!email || typeof email !== 'string') {
    return fallbackUserId;
  }
  const [namePart] = email.split('@');
  return namePart || fallbackUserId;
}

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
    OPERATION_NOT_ALLOWED: 'This login method is disabled in your Firebase project.',
    UNKNOWN_ERROR: 'Authentication failed. Please check your API key and try again.'
  };

  return map[normalized] || `Authentication failed: ${normalized}`;
}

async function firebaseRequest(apiKey, action, payload) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${action}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
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
        reject(new Error('Google OAuth runtime unavailable after script load'));
      };
      script.onerror = () => reject(new Error('Failed to load Google OAuth script'));
      document.head.appendChild(script);
    });
  }

  return googleScriptPromise;
}

async function loginWithEmailPassword(apiKey, email, password) {
  return firebaseRequest(apiKey, 'accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true
  });
}

async function signUpWithEmailPassword(apiKey, email, password) {
  return firebaseRequest(apiKey, 'accounts:signUp', {
    email,
    password,
    returnSecureToken: true
  });
}

async function loginWithGoogleOAuth(apiKey, googleClientId) {
  await ensureGoogleIdentityScript();

  const tokenResponse = await new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: 'openid email profile',
      callback: (response) => {
        if (!response || response.error) {
          reject(new Error(response?.error_description || response?.error || 'Google OAuth canceled'));
          return;
        }
        resolve(response);
      }
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });

  const postBody = `providerId=google.com&access_token=${encodeURIComponent(tokenResponse.access_token)}`;
  return firebaseRequest(apiKey, 'accounts:signInWithIdp', {
    postBody,
    requestUri: window.location.origin,
    returnSecureToken: true,
    returnIdpCredential: true
  });
}

function buildAuthUser(authResult, provider) {
  const fallbackSource = authResult.localId || authResult.email || authResult.displayName || 'chat-user';
  const userId = normalizeUserId(fallbackSource);
  const displayName = authResult.displayName || toDisplayName(authResult.email, userId);

  return {
    userId,
    displayName,
    email: authResult.email || '',
    provider,
    idToken: authResult.idToken || ''
  };
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToUint8Array(base64Value) {
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function mergeMessagesById(previousMessages, incomingMessages) {
  const byId = new Map();

  [...previousMessages, ...incomingMessages].forEach((message) => {
    if (!message?.message_id) {
      return;
    }
    byId.set(message.message_id, message);
  });

  return Array.from(byId.values())
    .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
    .slice(-200);
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');

  return base64ToUint8Array(body).buffer;
}

async function importServerPublicKey(publicKeyPem) {
  return crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(publicKeyPem),
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256'
    },
    false,
    ['encrypt']
  );
}

async function encryptMessageTransport(plainText, aesKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    aesKey,
    textEncoder.encode(plainText)
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const tag = encryptedBytes.slice(encryptedBytes.length - 16);
  const cipherText = encryptedBytes.slice(0, encryptedBytes.length - 16);

  return {
    cipher_text: arrayBufferToBase64(cipherText.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    tag: arrayBufferToBase64(tag.buffer)
  };
}

async function decryptMessageTransport(encryptedPayload, aesKey) {
  const iv = base64ToUint8Array(encryptedPayload.iv);
  const tag = base64ToUint8Array(encryptedPayload.tag);
  const cipherText = base64ToUint8Array(encryptedPayload.cipher_text);
  const combined = new Uint8Array(cipherText.length + tag.length);

  combined.set(cipherText, 0);
  combined.set(tag, cipherText.length);

  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv
    },
    aesKey,
    combined
  );

  return textDecoder.decode(plainBuffer);
}

export default function App() {
  const socketRef = useRef(null);
  const typingStopTimeoutRef = useRef(null);
  const typingStateRef = useRef(false);
  const aesKeyRef = useRef(null);
  const chatIdRef = useRef('general');
  const userIdRef = useRef('guest');
  const messagesEndRef = useRef(null);
  const sentReadReceiptsRef = useRef(new Set());

  const [authConfig, setAuthConfig] = useState(() =>
    loadStoredJson(AUTH_CONFIG_STORAGE_KEY, {
      apiKey: '',
      googleClientId: ''
    })
  );
  const [authUser, setAuthUser] = useState(() => loadStoredJson(AUTH_SESSION_STORAGE_KEY, null));
  const [authMode, setAuthMode] = useState('signin');
  const [authForm, setAuthForm] = useState({
    email: '',
    password: ''
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const [rooms, setRooms] = useState(['general', 'engineering', 'product-launch']);
  const [newRoomName, setNewRoomName] = useState('');
  const [chatId, setChatId] = useState('general');
  const [userId, setUserId] = useState(authUser?.userId || 'guest');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [encryptionEnabled, setEncryptionEnabled] = useState(true);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [presenceByUser, setPresenceByUser] = useState({});
  const [readReceipts, setReadReceipts] = useState({});
  const [transportError, setTransportError] = useState('');

  const canSend = useMemo(() => status === 'connected' && text.trim().length > 0, [status, text]);
  const onlineCount = useMemo(() => Object.keys(presenceByUser).length, [presenceByUser]);

  useEffect(() => {
    persistStoredJson(AUTH_CONFIG_STORAGE_KEY, authConfig);
  }, [authConfig]);

  useEffect(() => {
    if (authUser) {
      persistStoredJson(AUTH_SESSION_STORAGE_KEY, authUser);
      setUserId(authUser.userId);
      userIdRef.current = authUser.userId;
      return;
    }

    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
  }, [authUser]);

  useEffect(() => {
    return () => {
      if (typingStopTimeoutRef.current) {
        clearTimeout(typingStopTimeoutRef.current);
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
      aesKeyRef.current = null;
    };
  }, []);

  useEffect(() => {
    chatIdRef.current = chatId;
    setMessages([]);
    setTypingUsers([]);
    setReadReceipts({});
    setPresenceByUser({});
    sentReadReceiptsRef.current.clear();

    if (status === 'connected' && socketRef.current) {
      joinRoom(chatId);
    }
  }, [chatId, status]);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  useEffect(() => {
    if (status !== 'connected' || !socketRef.current || messages.length === 0) {
      return;
    }

    const latestUnreadFromOthers = [...messages]
      .reverse()
      .find(
        (message) =>
          message.user_id !== userIdRef.current &&
          message.chat_id === chatIdRef.current &&
          message.message_id &&
          !sentReadReceiptsRef.current.has(message.message_id)
      );

    if (!latestUnreadFromOthers?.message_id) {
      return;
    }

    sentReadReceiptsRef.current.add(latestUnreadFromOthers.message_id);
    socketRef.current.send(
      JSON.stringify({
        type: 'chat.read',
        payload: {
          chat_id: chatIdRef.current,
          message_id: latestUnreadFromOthers.message_id
        }
      })
    );
  }, [messages, status]);

  function disconnectSocket() {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setStatus('disconnected');
    aesKeyRef.current = null;
    typingStateRef.current = false;
  }

  async function issueDevToken(currentAuthUser = authUser) {
    if (!currentAuthUser?.userId) {
      throw new Error('Sign in first before issuing a gateway token');
    }

    const params = new URLSearchParams({ user_id: currentAuthUser.userId });
    if (currentAuthUser.displayName) {
      params.set('name', currentAuthUser.displayName);
    }

    const response = await fetch(`${GATEWAY_HTTP}/dev/token?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to create gateway token');
    }

    setToken(data.token);
    return data.token;
  }

  async function finalizeAuth(authResult, provider) {
    const user = buildAuthUser(authResult, provider);
    setAuthUser(user);
    setAuthError('');

    try {
      await issueDevToken(user);
    } catch (error) {
      setAuthError(`Signed in, but chat token creation failed: ${error.message}`);
    }
  }

  async function handleEmailAuth(event) {
    event.preventDefault();
    setAuthError('');

    const apiKey = authConfig.apiKey.trim();
    if (!apiKey) {
      setAuthError('Paste your Firebase Web API key first.');
      return;
    }

    if (!authForm.email.trim() || !authForm.password.trim()) {
      setAuthError('Email and password are required.');
      return;
    }

    setAuthBusy(true);
    try {
      const authResult =
        authMode === 'signin'
          ? await loginWithEmailPassword(apiKey, authForm.email.trim(), authForm.password)
          : await signUpWithEmailPassword(apiKey, authForm.email.trim(), authForm.password);

      await finalizeAuth(authResult, authMode === 'signin' ? 'email' : 'email-signup');
      setAuthForm((previous) => ({ ...previous, password: '' }));
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleGoogleAuth() {
    setAuthError('');

    const apiKey = authConfig.apiKey.trim();
    const clientId = authConfig.googleClientId.trim();

    if (!apiKey) {
      setAuthError('Paste your Firebase Web API key before using Google OAuth.');
      return;
    }

    if (!clientId) {
      setAuthError('Google OAuth Client ID is required for Gmail sign-in.');
      return;
    }

    setAuthBusy(true);
    try {
      const authResult = await loginWithGoogleOAuth(apiKey, clientId);
      await finalizeAuth(authResult, 'google-oauth');
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  function handleLogout() {
    disconnectSocket();
    setAuthUser(null);
    setToken('');
    setStatus('disconnected');
    setMessages([]);
    setTypingUsers([]);
    setPresenceByUser({});
    setReadReceipts({});
    setText('');
    setTransportError('');
  }

  function sendTypingEvent(isTyping) {
    if (status !== 'connected' || !socketRef.current) {
      return;
    }

    if (typingStateRef.current === isTyping) {
      return;
    }

    typingStateRef.current = isTyping;
    socketRef.current.send(
      JSON.stringify({
        type: 'chat.typing',
        payload: {
          chat_id: chatIdRef.current,
          is_typing: isTyping
        }
      })
    );
  }

  function scheduleTypingStop() {
    if (typingStopTimeoutRef.current) {
      clearTimeout(typingStopTimeoutRef.current);
    }

    typingStopTimeoutRef.current = setTimeout(() => {
      sendTypingEvent(false);
    }, 1200);
  }

  function updateTypingState(payload) {
    if (
      !payload?.user_id ||
      payload.chat_id !== chatIdRef.current ||
      payload.user_id === userIdRef.current
    ) {
      return;
    }

    setTypingUsers((previous) => {
      const entries = new Map(previous.map((item) => [item.user_id, item]));
      if (payload.is_typing) {
        entries.set(payload.user_id, payload);
      } else {
        entries.delete(payload.user_id);
      }

      return Array.from(entries.values());
    });
  }

  function updatePresence(payload) {
    if (!payload?.user_id || payload.chat_id !== chatIdRef.current) {
      return;
    }

    setPresenceByUser((previous) => {
      if (payload.status === 'offline') {
        const nextState = { ...previous };
        delete nextState[payload.user_id];
        return nextState;
      }

      return {
        ...previous,
        [payload.user_id]: {
          status: payload.status,
          updated_at: payload.updated_at
        }
      };
    });
  }

  async function startEncryptionHandshake(ws) {
    if (!encryptionEnabled) {
      aesKeyRef.current = null;
      return;
    }

    const keyResponse = await fetch(`${GATEWAY_HTTP}/crypto/public-key`);
    const keyData = await keyResponse.json();
    if (!keyResponse.ok || !keyData.public_key) {
      throw new Error('Unable to load gateway public key');
    }

    const serverPublicKey = await importServerPublicKey(keyData.public_key);
    const aesKey = await crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256
      },
      true,
      ['encrypt', 'decrypt']
    );

    const rawAes = await crypto.subtle.exportKey('raw', aesKey);
    const encryptedKeyBuffer = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverPublicKey, rawAes);
    aesKeyRef.current = aesKey;

    ws.send(
      JSON.stringify({
        type: 'crypto.key_exchange',
        payload: {
          encrypted_key: arrayBufferToBase64(encryptedKeyBuffer)
        }
      })
    );
  }

  async function normalizeInboundMessage(messagePayload) {
    if (!messagePayload?.encrypted || !messagePayload.encrypted_text) {
      return messagePayload;
    }

    if (!aesKeyRef.current) {
      return {
        ...messagePayload,
        text: '[encrypted message received before local key setup]'
      };
    }

    try {
      const decryptedText = await decryptMessageTransport(messagePayload.encrypted_text, aesKeyRef.current);
      return {
        ...messagePayload,
        text: decryptedText
      };
    } catch {
      return {
        ...messagePayload,
        text: '[failed to decrypt message payload]'
      };
    }
  }

  function joinRoom(targetRoom = chatIdRef.current) {
    if (status !== 'connected' || !socketRef.current) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.join',
        payload: {
          chat_id: targetRoom
        }
      })
    );
  }

  function leaveRoom(targetRoom = chatIdRef.current) {
    if (status !== 'connected' || !socketRef.current) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.leave',
        payload: {
          chat_id: targetRoom
        }
      })
    );
  }

  function connect() {
    if (!authUser) {
      setTransportError('Sign in first.');
      return;
    }

    if (!token) {
      setTransportError('Issue a chat token before connecting.');
      return;
    }

    setTransportError('');

    if (socketRef.current) {
      socketRef.current.close();
    }

    const ws = new WebSocket(`${GATEWAY_WS}?token=${encodeURIComponent(token)}`);
    socketRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      joinRoom(chatIdRef.current);
      startEncryptionHandshake(ws).catch((error) => {
        setTransportError(`Encryption handshake failed: ${error.message}`);
      });
    };

    ws.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data);

        if (frame.type === 'chat.history') {
          if (frame.payload?.chat_id !== chatIdRef.current) {
            return;
          }

          const history = Array.isArray(frame.payload?.messages) ? frame.payload.messages : [];
          const normalizedHistory = [];
          for (const historyMessage of history) {
            normalizedHistory.push(await normalizeInboundMessage(historyMessage));
          }

          setMessages((previous) => mergeMessagesById(previous, normalizedHistory));
          return;
        }

        if (frame.type === 'chat.message') {
          if (frame.payload?.chat_id !== chatIdRef.current) {
            return;
          }

          const normalizedPayload = await normalizeInboundMessage(frame.payload);
          setMessages((previous) => mergeMessagesById(previous, [normalizedPayload]));
          return;
        }

        if (frame.type === 'chat.joined') {
          const users = Array.isArray(frame.payload?.online_users) ? frame.payload.online_users : [];
          const nextState = {};
          users.forEach((onlineUserId) => {
            nextState[onlineUserId] = {
              status: 'online',
              updated_at: new Date().toISOString()
            };
          });

          setPresenceByUser(nextState);
          return;
        }

        if (frame.type === 'chat.typing') {
          updateTypingState(frame.payload);
          return;
        }

        if (frame.type === 'chat.read') {
          const receipt = frame.payload;
          setReadReceipts((previous) => ({
            ...previous,
            [receipt.message_id]: {
              ...(previous[receipt.message_id] || {}),
              [receipt.user_id]: receipt.read_at
            }
          }));
          return;
        }

        if (frame.type === 'presence.update') {
          updatePresence(frame.payload);
          return;
        }

        if (frame.type === 'error') {
          setTransportError(frame.payload?.message || 'Gateway returned an error');
          return;
        }

        if (frame.type === 'crypto.ack') {
          setTransportError('');
        }
      } catch (error) {
        setTransportError(`Frame processing error: ${error.message}`);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      aesKeyRef.current = null;
      typingStateRef.current = false;
    };

    ws.onerror = () => {
      setStatus('error');
      setTransportError('WebSocket connection error');
    };
  }

  async function sendMessage() {
    if (!canSend || !socketRef.current) {
      return;
    }

    const payload = {
      chat_id: chatIdRef.current,
      client_msg_id: crypto.randomUUID()
    };

    if (encryptionEnabled && aesKeyRef.current) {
      payload.encrypted_text = await encryptMessageTransport(text, aesKeyRef.current);
    } else {
      payload.text = text;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.message',
        payload
      })
    );

    sendTypingEvent(false);
    setText('');
  }

  function handleComposerChange(value) {
    setText(value);

    if (value.trim().length === 0) {
      sendTypingEvent(false);
      return;
    }

    sendTypingEvent(true);
    scheduleTypingStop();
  }

  function addRoom() {
    const trimmed = newRoomName.trim();
    if (!trimmed || rooms.includes(trimmed)) {
      return;
    }

    setRooms((previous) => [...previous, trimmed]);
    setChatId(trimmed);
    setNewRoomName('');
  }

  function formatTime(dateString) {
    if (!dateString) {
      return '';
    }

    const date = new Date(dateString);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  if (!authUser) {
    return (
      <div className="auth-shell">
        <section className="auth-hero">
          <h1>Signal-Style Kafka Chat</h1>
          <p>
            Production-grade realtime chat with room fanout, Kafka durability, encryption, typing indicators,
            and presence.
          </p>
          <ul>
            <li>OAuth with Gmail and Email/Password</li>
            <li>Paste your Firebase API key directly in the login form</li>
            <li>Red and green Telegram-inspired interface</li>
          </ul>
        </section>

        <section className="auth-panel">
          <h2>Login</h2>
          <p className="auth-help">Use Firebase Auth credentials to enter chat.</p>

          <label className="auth-input-group">
            <span>Firebase Web API Key</span>
            <input
              type="password"
              value={authConfig.apiKey}
              placeholder="Paste API key"
              onChange={(event) =>
                setAuthConfig((previous) => ({
                  ...previous,
                  apiKey: event.target.value
                }))
              }
            />
          </label>

          <label className="auth-input-group">
            <span>Google OAuth Client ID (for Gmail login)</span>
            <input
              type="text"
              value={authConfig.googleClientId}
              placeholder="Paste OAuth client ID"
              onChange={(event) =>
                setAuthConfig((previous) => ({
                  ...previous,
                  googleClientId: event.target.value
                }))
              }
            />
          </label>

          <form onSubmit={handleEmailAuth} className="auth-form-grid">
            <div className="mode-switch">
              <button
                type="button"
                className={authMode === 'signin' ? 'mode-btn active' : 'mode-btn'}
                onClick={() => setAuthMode('signin')}
              >
                Email Sign In
              </button>
              <button
                type="button"
                className={authMode === 'signup' ? 'mode-btn active' : 'mode-btn'}
                onClick={() => setAuthMode('signup')}
              >
                Email Sign Up
              </button>
            </div>

            <label className="auth-input-group">
              <span>Email</span>
              <input
                type="email"
                value={authForm.email}
                placeholder="you@gmail.com"
                onChange={(event) =>
                  setAuthForm((previous) => ({
                    ...previous,
                    email: event.target.value
                  }))
                }
              />
            </label>

            <label className="auth-input-group">
              <span>Password</span>
              <input
                type="password"
                value={authForm.password}
                placeholder="Enter password"
                onChange={(event) =>
                  setAuthForm((previous) => ({
                    ...previous,
                    password: event.target.value
                  }))
                }
              />
            </label>

            <div className="auth-actions">
              <button type="submit" className="auth-primary" disabled={authBusy}>
                {authBusy ? 'Authenticating...' : authMode === 'signin' ? 'Sign In with Email' : 'Create Account'}
              </button>
              <button type="button" className="auth-google" onClick={handleGoogleAuth} disabled={authBusy}>
                Continue with Gmail (OAuth)
              </button>
            </div>
          </form>

          {authError ? <p className="error-banner">{authError}</p> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="chat-shell">
      <aside className="left-rail">
        <div className="brand-block">
          <h1>Redline Chat</h1>
          <span>Kafka + WebSocket</span>
        </div>

        <div className="profile-card">
          <div className="profile-avatar">{authUser.displayName.charAt(0).toUpperCase()}</div>
          <div className="profile-meta">
            <strong>{authUser.displayName}</strong>
            <span>{authUser.email || authUser.userId}</span>
            <span className="provider-tag">{authUser.provider}</span>
          </div>
          <button className="logout-button" onClick={handleLogout}>
            Logout
          </button>
        </div>

        <div className="gateway-controls">
          <button
            className="control-button token"
            onClick={() => issueDevToken().catch((error) => setTransportError(error.message))}
          >
            {token ? 'Refresh Chat Token' : 'Issue Chat Token'}
          </button>

          <button className="control-button connect" onClick={connect} disabled={!token}>
            {status === 'connected' ? 'Connected' : 'Connect Socket'}
          </button>

          <button className="control-button leave" onClick={() => leaveRoom(chatId)} disabled={status !== 'connected'}>
            Leave Room
          </button>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={encryptionEnabled}
              onChange={(event) => setEncryptionEnabled(event.target.checked)}
            />
            <span>Transport Encryption</span>
          </label>
        </div>

        <div className="rooms-panel">
          <div className="rooms-header">
            <h2>Chats</h2>
            <span>{rooms.length} rooms</span>
          </div>

          <div className="rooms-list">
            {rooms.map((room) => (
              <button
                key={room}
                type="button"
                className={chatId === room ? 'room-pill active' : 'room-pill'}
                onClick={() => setChatId(room)}
              >
                <span className="room-hash">#</span>
                <span className="room-name">{room}</span>
              </button>
            ))}
          </div>

          <div className="add-room-row">
            <input
              type="text"
              value={newRoomName}
              placeholder="new-room"
              onChange={(event) => setNewRoomName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  addRoom();
                }
              }}
            />
            <button type="button" onClick={addRoom}>
              Add
            </button>
          </div>
        </div>
      </aside>

      <main className="conversation-pane">
        <header className="conversation-header">
          <div>
            <h2>#{chatId}</h2>
            <p>
              <span className={status === 'connected' ? 'connection-dot online' : 'connection-dot'} />
              {status} • {onlineCount} online
            </p>
          </div>
          <div className="header-right">
            <span>{encryptionEnabled ? 'Encrypted' : 'Plaintext'}</span>
            <span>{authUser.email || authUser.userId}</span>
          </div>
        </header>

        {transportError ? <div className="transport-alert">{transportError}</div> : null}

        <section className="timeline">
          {messages.length === 0 ? (
            <div className="empty-timeline">
              <h3>No messages yet</h3>
              <p>Join and send the first message in #{chatId}.</p>
            </div>
          ) : (
            messages.map((message) => {
              const isSelf = message.user_id === userId;
              const receiptCount = Object.keys(readReceipts[message.message_id] || {}).length;
              return (
                <article key={message.message_id} className={isSelf ? 'bubble-row self' : 'bubble-row other'}>
                  <div className="bubble">
                    <div className="bubble-user">{message.user_id}</div>
                    <p>{message.text || message.body_text}</p>
                    <footer>
                      <span>{formatTime(message.created_at)}</span>
                      {receiptCount > 0 ? <span className="receipt-mark">Seen {receiptCount}</span> : null}
                    </footer>
                  </div>
                </article>
              );
            })
          )}

          {typingUsers.length > 0 ? (
            <div className="typing-banner">{typingUsers.map((entry) => entry.user_id).join(', ')} typing...</div>
          ) : null}

          <div ref={messagesEndRef} />
        </section>

        <footer className="composer">
          <input
            type="text"
            value={text}
            placeholder="Write a message"
            onChange={(event) => handleComposerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                sendMessage().catch((error) => setTransportError(error.message));
              }
            }}
          />
          <button type="button" onClick={() => sendMessage().catch((error) => setTransportError(error.message))} disabled={!canSend}>
            Send
          </button>
        </footer>
      </main>
    </div>
  );
}