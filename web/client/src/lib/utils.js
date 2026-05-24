const AUTH_CONFIG_KEY = 'chat.auth.config.v1';
const AUTH_SESSION_KEY = 'chat.auth.session.v1';

export function loadStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function persistStoredJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadAuthConfig() {
  return loadStoredJson(AUTH_CONFIG_KEY, { apiKey: '', googleClientId: '' });
}

export function saveAuthConfig(config) {
  persistStoredJson(AUTH_CONFIG_KEY, config);
}

export function loadAuthSession() {
  return loadStoredJson(AUTH_SESSION_KEY, null);
}

export function saveAuthSession(user) {
  if (user) {
    persistStoredJson(AUTH_SESSION_KEY, user);
  } else {
    localStorage.removeItem(AUTH_SESSION_KEY);
  }
}

export function mergeMessagesById(prev, incoming) {
  const byId = new Map();
  [...prev, ...incoming].forEach((m) => {
    if (m?.message_id) byId.set(m.message_id, m);
  });
  return Array.from(byId.values())
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-200);
}

export function formatTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
