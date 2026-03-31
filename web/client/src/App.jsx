import { useEffect, useMemo, useRef, useState } from 'react';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:8080/ws';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
  const [userId, setUserId] = useState('alice');
  const [chatId, setChatId] = useState('global-room');
  const [token, setToken] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [encryptionEnabled, setEncryptionEnabled] = useState(true);
  const [encryptionStatus, setEncryptionStatus] = useState('disabled');
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [presenceByUser, setPresenceByUser] = useState({});
  const [readReceipts, setReadReceipts] = useState({});
  const [errors, setErrors] = useState([]);

  const canSend = useMemo(() => status === 'connected' && text.trim().length > 0, [status, text]);

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
          chat_id: chatId,
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
    if (!payload?.user_id || payload.chat_id !== chatId || payload.user_id === userId) {
      return;
    }

    setTypingUsers((prev) => {
      const entries = new Map(prev.map((item) => [item.user_id, item]));
      if (payload.is_typing) {
        entries.set(payload.user_id, payload);
      } else {
        entries.delete(payload.user_id);
      }

      return Array.from(entries.values());
    });
  }

  function updateReadReceipts(payload) {
    if (!payload?.message_id || payload.chat_id !== chatId) {
      return;
    }

    setReadReceipts((prev) => ({
      ...prev,
      [payload.message_id]: {
        ...(prev[payload.message_id] || {}),
        [payload.user_id]: payload.read_at
      }
    }));
  }

  function setPresenceFromJoined(payload) {
    if (payload?.chat_id !== chatId) {
      return;
    }

    const users = Array.isArray(payload.online_users) ? payload.online_users : [];
    const nextState = {};
    users.forEach((onlineUserId) => {
      nextState[onlineUserId] = {
        status: 'online',
        updated_at: new Date().toISOString()
      };
    });

    setPresenceByUser(nextState);
  }

  function updatePresence(payload) {
    if (!payload?.user_id || payload.chat_id !== chatId) {
      return;
    }

    setPresenceByUser((prev) => {
      if (payload.status === 'offline') {
        const next = { ...prev };
        delete next[payload.user_id];
        return next;
      }

      return {
        ...prev,
        [payload.user_id]: {
          status: payload.status,
          updated_at: payload.updated_at
        }
      };
    });
  }

  async function issueDevToken() {
    const response = await fetch(`${GATEWAY_HTTP}/dev/token?user_id=${encodeURIComponent(userId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to create token');
    }

    setToken(data.token);
  }

  async function startEncryptionHandshake(ws) {
    if (!encryptionEnabled) {
      aesKeyRef.current = null;
      setEncryptionStatus('disabled');
      return;
    }

    setEncryptionStatus('negotiating');

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

  function connect() {
    if (!token) {
      setErrors((prev) => [`Token is required before connecting`, ...prev].slice(0, 5));
      return;
    }

    if (socketRef.current) {
      socketRef.current.close();
    }

    const ws = new WebSocket(`${GATEWAY_WS}?token=${encodeURIComponent(token)}`);
    socketRef.current = ws;
    setStatus('connecting');
    setEncryptionStatus(encryptionEnabled ? 'negotiating' : 'disabled');

    ws.onopen = () => {
      setStatus('connected');
      ws.send(
        JSON.stringify({
          type: 'chat.join',
          payload: { chat_id: chatId }
        })
      );

      startEncryptionHandshake(ws).catch((error) => {
        setEncryptionStatus('error');
        setErrors((prev) => [`Encryption handshake failed: ${error.message}`, ...prev].slice(0, 5));
      });
    };

    ws.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data);

        if (frame.type === 'chat.message') {
          const normalizedPayload = await normalizeInboundMessage(frame.payload);
          setMessages((prev) => [normalizedPayload, ...prev].slice(0, 50));
          return;
        }

        if (frame.type === 'chat.joined') {
          setPresenceFromJoined(frame.payload);
          return;
        }

        if (frame.type === 'chat.typing') {
          updateTypingState(frame.payload);
          return;
        }

        if (frame.type === 'chat.read') {
          updateReadReceipts(frame.payload);
          return;
        }

        if (frame.type === 'presence.update') {
          updatePresence(frame.payload);
          return;
        }

        if (frame.type === 'crypto.ack') {
          setEncryptionStatus('ready');
          return;
        }

        if (frame.type === 'error') {
          setErrors((prev) => [`${frame.payload.code}: ${frame.payload.message}`, ...prev].slice(0, 5));
        }
      } catch {
        setErrors((prev) => ['Received non-JSON server frame', ...prev].slice(0, 5));
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      setEncryptionStatus(encryptionEnabled ? 'disconnected' : 'disabled');
      aesKeyRef.current = null;
      typingStateRef.current = false;
    };

    ws.onerror = () => {
      setStatus('error');
      setEncryptionStatus('error');
    };
  }

  async function sendMessage() {
    if (!canSend || !socketRef.current) {
      return;
    }

    const payload = {
      chat_id: chatId,
      client_msg_id: crypto.randomUUID()
    };

    if (encryptionEnabled) {
      if (!aesKeyRef.current) {
        setErrors((prev) => ['Encryption is enabled but key exchange is not ready yet', ...prev].slice(0, 5));
        return;
      }

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

  function markAsRead(messageId) {
    if (status !== 'connected' || !socketRef.current) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.read',
        payload: {
          chat_id: chatId,
          message_id: messageId
        }
      })
    );
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

  function joinRoom() {
    if (status !== 'connected' || !socketRef.current) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.join',
        payload: { chat_id: chatId }
      })
    );
  }

  function leaveRoom() {
    if (status !== 'connected' || !socketRef.current) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.leave',
        payload: { chat_id: chatId }
      })
    );
  }

  return (
    <main className="app">
      <section className="panel">
        <h1>Signal-Inspired Kafka Chat</h1>
        <p className="subtitle">WebSocket gateway with JWT auth and room-based fanout.</p>

        <div className="controls">
          <label>
            User ID
            <input value={userId} onChange={(event) => setUserId(event.target.value)} />
          </label>

          <label>
            Chat ID
            <input value={chatId} onChange={(event) => setChatId(event.target.value)} />
          </label>
        </div>

        <div className="controls">
          <button type="button" onClick={() => issueDevToken().catch((error) => setErrors((prev) => [error.message, ...prev]))}>
            Issue Dev Token
          </button>
          <button type="button" onClick={connect}>Connect</button>
          <button type="button" onClick={joinRoom}>Join Room</button>
          <button type="button" onClick={leaveRoom}>Leave Room</button>
        </div>

        <label>
          <input
            type="checkbox"
            checked={encryptionEnabled}
            onChange={(event) => {
              setEncryptionEnabled(event.target.checked);
              setEncryptionStatus(event.target.checked ? 'pending-reconnect' : 'disabled');
            }}
          />
          Transport Encryption (RSA key exchange + AES-GCM)
        </label>

        <label>
          JWT Token
          <textarea value={token} onChange={(event) => setToken(event.target.value)} rows={3} />
        </label>

        <div className="composer">
          <input value={text} onChange={(event) => handleComposerChange(event.target.value)} placeholder="Type a message" />
          <button type="button" onClick={() => sendMessage().catch((error) => setErrors((prev) => [error.message, ...prev]))} disabled={!canSend}>
            Send
          </button>
        </div>

        {typingUsers.length > 0 ? (
          <p className="typing">
            {typingUsers.map((entry) => entry.user_id).join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
          </p>
        ) : null}

        <p className="status">Connection: {status}</p>
        <p className="status">Encryption: {encryptionStatus}</p>
        <p className="status">Online in room: {Object.keys(presenceByUser).join(', ') || 'none'}</p>
      </section>

      <section className="panel stream">
        <h2>Messages</h2>
        {messages.length === 0 ? <p>No messages yet.</p> : null}
        {messages.map((message) => (
          <article key={message.message_id} className="message">
            <header>
              <strong>{message.user_id}</strong>
              <span>{new Date(message.created_at).toLocaleTimeString()}</span>
            </header>
            <p>{message.text}</p>
            <footer>
              <button type="button" onClick={() => markAsRead(message.message_id)}>
                Mark Read
              </button>
              <span>
                Read by: {Object.keys(readReceipts[message.message_id] || {}).length}
              </span>
            </footer>
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Errors</h2>
        {errors.length === 0 ? <p>None</p> : null}
        {errors.map((error, index) => (
          <p key={`${error}-${index}`} className="error-item">
            {error}
          </p>
        ))}
      </section>
    </main>
  );
}
