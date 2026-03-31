import React, { useEffect, useMemo, useRef, useState } from 'react';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:8080/ws';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ============= TELEGRAM-STYLE CHAT APP =============

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
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .slice(0, 100);
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
  const userIdRef = useRef('alice');
  const messagesEndRef = useRef(null);

  const [userId, setUserId] = useState('alice');
  const [chatId, setChatId] = useState('general');
  const [token, setToken] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [encryptionEnabled, setEncryptionEnabled] = useState(true);
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [presenceByUser, setPresenceByUser] = useState({});
  const [rooms, setRooms] = useState(['general', 'tech-chat', 'random']);
  const [newRoomName, setNewRoomName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [readReceipts, setReadReceipts] = useState({});

  const canSend = useMemo(() => status === 'connected' && text.trim().length > 0, [status, text]);

  useEffect(() => {
    return () => {
      if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
      if (socketRef.current) socketRef.current.close();
      aesKeyRef.current = null;
    };
  }, []);

  useEffect(() => {
    chatIdRef.current = chatId;
    setMessages([]);
    setTypingUsers([]);
    setReadReceipts({});
    setPresenceByUser({});
  }, [chatId]);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function sendTypingEvent(isTyping) {
    if (status !== 'connected' || !socketRef.current) return;
    if (typingStateRef.current === isTyping) return;
    typingStateRef.current = isTyping;
    socketRef.current.send(
      JSON.stringify({
        type: 'chat.typing',
        payload: { chat_id: chatIdRef.current, is_typing: isTyping }
      })
    );
  }

  function scheduleTypingStop() {
    if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
    typingStopTimeoutRef.current = setTimeout(() => {
      sendTypingEvent(false);
    }, 1200);
  }

  function updateTypingState(payload) {
    if (!payload?.user_id || payload.chat_id !== chatIdRef.current || payload.user_id === userIdRef.current) return;
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

  function updatePresence(payload) {
    if (!payload?.user_id || payload.chat_id !== chatIdRef.current) return;
    setPresenceByUser((prev) => {
      if (payload.status === 'offline') {
        const next = { ...prev };
        delete next[payload.user_id];
        return next;
      }
      return { ...prev, [payload.user_id]: { status: payload.status, updated_at: payload.updated_at } };
    });
  }

  async function issueDevToken() {
    const response = await fetch(`${GATEWAY_HTTP}/dev/token?user_id=${encodeURIComponent(userId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to create token');
    setToken(data.token);
  }

  async function startEncryptionHandshake(ws) {
    if (!encryptionEnabled) {
      aesKeyRef.current = null;
      return;
    }
    const keyResponse = await fetch(`${GATEWAY_HTTP}/crypto/public-key`);
    const keyData = await keyResponse.json();
    if (!keyResponse.ok || !keyData.public_key) throw new Error('Unable to load gateway public key');
    const serverPublicKey = await importServerPublicKey(keyData.public_key);
    const aesKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const rawAes = await crypto.subtle.exportKey('raw', aesKey);
    const encryptedKeyBuffer = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverPublicKey, rawAes);
    aesKeyRef.current = aesKey;
    ws.send(
      JSON.stringify({
        type: 'crypto.key_exchange',
        payload: { encrypted_key: arrayBufferToBase64(encryptedKeyBuffer) }
      })
    );
  }

  async function normalizeInboundMessage(messagePayload) {
    if (!messagePayload?.encrypted || !messagePayload.encrypted_text) return messagePayload;
    if (!aesKeyRef.current) {
      return { ...messagePayload, text: '[encrypted message received before local key setup]' };
    }
    try {
      const decryptedText = await decryptMessageTransport(messagePayload.encrypted_text, aesKeyRef.current);
      return { ...messagePayload, text: decryptedText };
    } catch {
      return { ...messagePayload, text: '[failed to decrypt message payload]' };
    }
  }

  function connect() {
    if (!token) return;
    if (socketRef.current) socketRef.current.close();
    const ws = new WebSocket(`${GATEWAY_WS}?token=${encodeURIComponent(token)}`);
    socketRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({ type: 'chat.join', payload: { chat_id: chatIdRef.current } }));
      startEncryptionHandshake(ws).catch((error) => console.error('Encryption error:', error));
    };

    ws.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'chat.history') {
          if (frame.payload?.chat_id !== chatIdRef.current) return;
          const history = Array.isArray(frame.payload?.messages) ? frame.payload.messages : [];
          const normalizedHistory = [];
          for (const historyMessage of history) {
            normalizedHistory.push(await normalizeInboundMessage(historyMessage));
          }
          setMessages((prev) => mergeMessagesById(prev, normalizedHistory));
        } else if (frame.type === 'chat.message') {
          if (frame.payload?.chat_id !== chatIdRef.current) return;
          const normalizedPayload = await normalizeInboundMessage(frame.payload);
          setMessages((prev) => mergeMessagesById(prev, [normalizedPayload]));
        } else if (frame.type === 'chat.joined') {
          const users = Array.isArray(frame.payload?.online_users) ? frame.payload.online_users : [];
          const nextState = {};
          users.forEach((onlineUserId) => {
            nextState[onlineUserId] = { status: 'online', updated_at: new Date().toISOString() };
          });
          setPresenceByUser(nextState);
        } else if (frame.type === 'chat.typing') {
          updateTypingState(frame.payload);
        } else if (frame.type === 'chat.read') {
          const receipt = frame.payload;
          setReadReceipts((prev) => ({
            ...prev,
            [receipt.message_id]: { ...(prev[receipt.message_id] || {}), [receipt.user_id]: receipt.read_at }
          }));
        } else if (frame.type === 'presence.update') {
          updatePresence(frame.payload);
        } else if (frame.type === 'crypto.ack') {
          console.log('Encryption ready');
        }
      } catch (error) {
        console.error('Frame processing error:', error);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      aesKeyRef.current = null;
      typingStateRef.current = false;
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }

  async function sendMessage() {
    if (!canSend || !socketRef.current) return;
    const payload = {
      chat_id: chatIdRef.current,
      client_msg_id: crypto.randomUUID()
    };
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
    if (value.trim().length === 0) {
      sendTypingEvent(false);
      return;
    }
    sendTypingEvent(true);
    scheduleTypingStop();
  }

  function addRoom() {
    if (newRoomName.trim() && !rooms.includes(newRoomName)) {
      setRooms([...rooms, newRoomName]);
      setNewRoomName('');
    }
  }

  function joinRoom() {
    if (status !== 'connected' || !socketRef.current) return;
    socketRef.current.send(JSON.stringify({ type: 'chat.join', payload: { chat_id: chatIdRef.current } }));
  }

  function formatTime(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="telegram-app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>🔴 Kafka Chat</h1>
          <button className="settings-icon" onClick={() => setShowSettings(!showSettings)}>
            ⚙️
          </button>
        </div>

        {showSettings && (
          <div className="settings-panel">
            <label className="setting-input">
              <span>User ID</span>
              <input
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="Enter name"
              />
            </label>
            <button className="btn-green" onClick={() => issueDevToken().catch(console.error)}>
              {token ? '✓ Token Ready' : 'Get Token'}
            </button>
            <button
              className={`btn-connect ${status === 'connected' ? 'active' : ''}`}
              onClick={connect}
              disabled={!token}
            >
              {status === 'connected' ? '✓ Connected' : 'Connect'}
            </button>
            <label className="encryption-check">
              <input
                type="checkbox"
                checked={encryptionEnabled}
                onChange={(e) => setEncryptionEnabled(e.target.checked)}
              />
              <span>🔒 Encryption</span>
            </label>
          </div>
        )}

        <div className="rooms-section">
          <h2>Chats</h2>
          <div className="rooms-list">
            {rooms.map((room) => (
              <div
                key={room}
                className={`room-item ${chatId === room ? 'active' : ''}`}
                onClick={() => {
                  setChatId(room);
                  if (status === 'connected') joinRoom();
                }}
              >
                <div className="room-avatar">#</div>
                <div className="room-header">
                  <div className="room-name">{room}</div>
                  <div className="online-badge">
                    {Object.keys(presenceByUser).length} online
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="add-room">
            <input
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="New chat"
              onKeyDown={(e) => e.key === 'Enter' && addRoom()}
            />
            <button onClick={addRoom}>+</button>
          </div>
        </div>
      </div>

      {/* Main Chat */}
      <div className="chat-main">
        {status === 'connected' ? (
          <>
            <div className="chat-header">
              <div className="header-title">
                <h2>#{chatId}</h2>
                <span className="status-online">
                  {Object.keys(presenceByUser).length || 0} online
                </span>
              </div>
            </div>

            <div className="messages-list">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <p>No messages yet</p>
                  <p className="empty-hint">Start the conversation!</p>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <div
                      key={msg.message_id}
                      className={`message ${msg.user_id === userId ? 'sent' : 'received'}`}
                    >
                      <div className="message-bubble">
                        <div className="sender-name">{msg.user_id}</div>
                        <p className="message-text">{msg.text || msg.body_text}</p>
                        <div className="message-footer">
                          <span className="timestamp">{formatTime(msg.created_at)}</span>
                          {readReceipts[msg.message_id] && (
                            <span className="read-icon">✓✓</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {typingUsers.length > 0 && (
                    <div className="typing-indicator">
                      <span>{typingUsers.map((u) => u.user_id).join(', ')} is typing</span>
                      <div className="dots">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            <div className="input-area">
              <input
                type="text"
                className="message-input"
                value={text}
                onChange={(e) => handleComposerChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Message..."
              />
              <button
                className="send-btn"
                onClick={() => sendMessage().catch(console.error)}
                disabled={!canSend}
              >
                ➤
              </button>
            </div>
          </>
        ) : (
          <div className="disconnected">
            <div className="disconnect-box">
              <h2>Not Connected</h2>
              <p>Open settings and connect to start chatting</p>
              <button className="btn-green" onClick={() => setShowSettings(true)}>
                Settings
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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


