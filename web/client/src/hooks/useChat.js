import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { importServerPublicKey, encryptMessageTransport, decryptMessageTransport, arrayBufferToBase64 } from '../lib/encryption.js';
import { mergeMessagesById } from '../lib/utils.js';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:8080/ws';

export default function useChat({ authUser, token }) {
  const socketRef = useRef(null);
  const typingStopRef = useRef(null);
  const typingStateRef = useRef(false);
  const aesKeyRef = useRef(null);
  const chatIdRef = useRef('general');
  const userIdRef = useRef(authUser?.userId || 'guest');
  const sentReadRef = useRef(new Set());
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const [rooms, setRooms] = useState(['general', 'engineering', 'product-launch']);
  const [newRoomName, setNewRoomName] = useState('');
  const [chatId, setChatId] = useState('general');
  const [status, setStatus] = useState('disconnected');
  const [encryptionEnabled, setEncryptionEnabled] = useState(true);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [presenceByUser, setPresenceByUser] = useState({});
  const [readReceipts, setReadReceipts] = useState({});
  const [transportError, setTransportError] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);

  const canSend = useMemo(() => status === 'connected' && text.trim().length > 0, [status, text]);
  const onlineCount = useMemo(() => Object.keys(presenceByUser).length, [presenceByUser]);

  useEffect(() => { userIdRef.current = authUser?.userId || 'guest'; }, [authUser]);

  useEffect(() => {
    chatIdRef.current = chatId;
    setMessages([]);
    setTypingUsers([]);
    setReadReceipts({});
    setPresenceByUser({});
    sentReadRef.current.clear();
    if (status === 'connected' && socketRef.current) joinRoom(chatId);
  }, [chatId]);

  useEffect(() => {
    return () => {
      if (typingStopRef.current) clearTimeout(typingStopRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) socketRef.current.close();
      aesKeyRef.current = null;
    };
  }, []);

  // Auto send read receipts
  useEffect(() => {
    if (status !== 'connected' || !socketRef.current || messages.length === 0) return;
    const latest = [...messages].reverse().find(
      (m) => m.user_id !== userIdRef.current && m.chat_id === chatIdRef.current && m.message_id && !sentReadRef.current.has(m.message_id)
    );
    if (!latest?.message_id) return;
    sentReadRef.current.add(latest.message_id);
    socketRef.current.send(JSON.stringify({
      type: 'chat.read',
      payload: { chat_id: chatIdRef.current, message_id: latest.message_id },
    }));
  }, [messages, status]);

  function sendJson(body) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(body));
    }
  }

  function joinRoom(room = chatIdRef.current) {
    sendJson({ type: 'chat.join', payload: { chat_id: room } });
  }

  function leaveRoom(room = chatIdRef.current) {
    sendJson({ type: 'chat.leave', payload: { chat_id: room } });
  }

  function sendTypingEvent(isTyping) {
    if (status !== 'connected' || typingStateRef.current === isTyping) return;
    typingStateRef.current = isTyping;
    sendJson({ type: 'chat.typing', payload: { chat_id: chatIdRef.current, is_typing: isTyping } });
  }

  function scheduleTypingStop() {
    if (typingStopRef.current) clearTimeout(typingStopRef.current);
    typingStopRef.current = setTimeout(() => sendTypingEvent(false), 1200);
  }

  async function normalizeInbound(payload) {
    if (!payload?.encrypted || !payload.encrypted_text) return payload;
    if (!aesKeyRef.current) return { ...payload, text: '[encrypted — key not ready]' };
    try {
      const decrypted = await decryptMessageTransport(payload.encrypted_text, aesKeyRef.current);
      return { ...payload, text: decrypted };
    } catch { return { ...payload, text: '[decryption failed]' }; }
  }

  async function startEncryptionHandshake(ws) {
    if (!encryptionEnabled) { aesKeyRef.current = null; return; }
    const keyRes = await fetch(`${GATEWAY_HTTP}/crypto/public-key`);
    const keyData = await keyRes.json();
    if (!keyRes.ok || !keyData.public_key) throw new Error('Unable to load gateway public key');
    const serverPub = await importServerPublicKey(keyData.public_key);
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await crypto.subtle.exportKey('raw', aesKey);
    const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverPub, raw);
    aesKeyRef.current = aesKey;
    ws.send(JSON.stringify({ type: 'crypto.key_exchange', payload: { encrypted_key: arrayBufferToBase64(encKey) } }));
  }

  function scheduleReconnect() {
    if (!token || !authUser) return;
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current += 1;
      setReconnectCount(reconnectAttemptRef.current);
      connect();
    }, delay);
  }

  function disconnectSocket() {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (socketRef.current) { socketRef.current.close(); socketRef.current = null; }
    setStatus('disconnected');
    aesKeyRef.current = null;
    typingStateRef.current = false;
    reconnectAttemptRef.current = 0;
    setReconnectCount(0);
  }

  function connect() {
    if (!authUser) { setTransportError('Sign in first.'); return; }
    if (!token) { setTransportError('Issue a chat token before connecting.'); return; }
    setTransportError('');
    if (socketRef.current) socketRef.current.close();

    const ws = new WebSocket(`${GATEWAY_WS}?token=${encodeURIComponent(token)}`);
    socketRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      reconnectAttemptRef.current = 0;
      setReconnectCount(0);
      joinRoom(chatIdRef.current);
      startEncryptionHandshake(ws).catch((e) => setTransportError(`Encryption failed: ${e.message}`));
    };

    ws.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'chat.history' && frame.payload?.chat_id === chatIdRef.current) {
          const history = Array.isArray(frame.payload?.messages) ? frame.payload.messages : [];
          const normalized = [];
          for (const m of history) normalized.push(await normalizeInbound(m));
          setMessages((p) => mergeMessagesById(p, normalized));
        } else if (frame.type === 'chat.message' && frame.payload?.chat_id === chatIdRef.current) {
          const norm = await normalizeInbound(frame.payload);
          setMessages((p) => mergeMessagesById(p, [norm]));
        } else if (frame.type === 'chat.joined') {
          const users = Array.isArray(frame.payload?.online_users) ? frame.payload.online_users : [];
          const next = {};
          users.forEach((id) => { next[id] = { status: 'online', updated_at: new Date().toISOString() }; });
          setPresenceByUser(next);
        } else if (frame.type === 'chat.typing') {
          const p = frame.payload;
          if (p?.user_id && p.chat_id === chatIdRef.current && p.user_id !== userIdRef.current) {
            setTypingUsers((prev) => {
              const map = new Map(prev.map((i) => [i.user_id, i]));
              if (p.is_typing) map.set(p.user_id, p); else map.delete(p.user_id);
              return Array.from(map.values());
            });
          }
        } else if (frame.type === 'chat.read') {
          const r = frame.payload;
          setReadReceipts((p) => ({ ...p, [r.message_id]: { ...(p[r.message_id] || {}), [r.user_id]: r.read_at } }));
        } else if (frame.type === 'presence.update') {
          const p = frame.payload;
          if (p?.user_id && p.chat_id === chatIdRef.current) {
            setPresenceByUser((prev) => {
              if (p.status === 'offline') { const n = { ...prev }; delete n[p.user_id]; return n; }
              return { ...prev, [p.user_id]: { status: p.status, updated_at: p.updated_at } };
            });
          }
        } else if (frame.type === 'error') {
          setTransportError(frame.payload?.message || 'Gateway error');
        } else if (frame.type === 'crypto.ack') {
          setTransportError('');
        }
      } catch (err) { setTransportError(`Frame error: ${err.message}`); }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      aesKeyRef.current = null;
      typingStateRef.current = false;
      scheduleReconnect();
    };

    ws.onerror = () => {
      setStatus('error');
      setTransportError('WebSocket connection error');
    };
  }

  async function sendMessage() {
    if (!canSend || !socketRef.current) return;
    const payload = { chat_id: chatIdRef.current, client_msg_id: crypto.randomUUID() };
    if (encryptionEnabled && aesKeyRef.current) {
      payload.encrypted_text = await encryptMessageTransport(text, aesKeyRef.current);
    } else {
      payload.text = text;
    }
    socketRef.current.send(JSON.stringify({ type: 'chat.message', payload }));
    sendTypingEvent(false);
    setText('');
  }

  function handleComposerChange(value) {
    setText(value);
    if (value.trim().length === 0) { sendTypingEvent(false); return; }
    sendTypingEvent(true);
    scheduleTypingStop();
  }

  function addRoom() {
    const trimmed = newRoomName.trim();
    if (!trimmed || rooms.includes(trimmed)) return;
    setRooms((p) => [...p, trimmed]);
    setChatId(trimmed);
    setNewRoomName('');
  }

  return {
    rooms, newRoomName, setNewRoomName, addRoom,
    chatId, setChatId,
    status, encryptionEnabled, setEncryptionEnabled,
    text, setText, messages, typingUsers,
    presenceByUser, readReceipts,
    transportError, setTransportError,
    canSend, onlineCount, reconnectCount,
    connect, disconnectSocket, leaveRoom,
    sendMessage, handleComposerChange,
  };
}
