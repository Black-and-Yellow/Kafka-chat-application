import { useEffect, useMemo, useRef, useState } from 'react';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:8080/ws';

export default function App() {
  const socketRef = useRef(null);
  const typingStopTimeoutRef = useRef(null);
  const typingStateRef = useRef(false);
  const [userId, setUserId] = useState('alice');
  const [chatId, setChatId] = useState('global-room');
  const [token, setToken] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
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

  async function issueDevToken() {
    const response = await fetch(`${GATEWAY_HTTP}/dev/token?user_id=${encodeURIComponent(userId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to create token');
    }

    setToken(data.token);
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

    ws.onopen = () => {
      setStatus('connected');
      ws.send(
        JSON.stringify({
          type: 'chat.join',
          payload: { chat_id: chatId }
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);

        if (frame.type === 'chat.message') {
          setMessages((prev) => [frame.payload, ...prev].slice(0, 50));
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

        if (frame.type === 'error') {
          setErrors((prev) => [`${frame.payload.code}: ${frame.payload.message}`, ...prev].slice(0, 5));
        }
      } catch {
        setErrors((prev) => ['Received non-JSON server frame', ...prev].slice(0, 5));
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }

  function sendMessage() {
    if (!canSend || !socketRef.current) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'chat.message',
        payload: {
          chat_id: chatId,
          text,
          client_msg_id: crypto.randomUUID()
        }
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
        </div>

        <label>
          JWT Token
          <textarea value={token} onChange={(event) => setToken(event.target.value)} rows={3} />
        </label>

        <div className="composer">
          <input value={text} onChange={(event) => handleComposerChange(event.target.value)} placeholder="Type a message" />
          <button type="button" onClick={sendMessage} disabled={!canSend}>
            Send
          </button>
        </div>

        {typingUsers.length > 0 ? (
          <p className="typing">
            {typingUsers.map((entry) => entry.user_id).join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
          </p>
        ) : null}

        <p className="status">Connection: {status}</p>
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
