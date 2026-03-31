import { useEffect, useMemo, useRef, useState } from 'react';

const GATEWAY_HTTP = import.meta.env.VITE_GATEWAY_HTTP || 'http://localhost:8080';
const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:8080/ws';

export default function App() {
  const socketRef = useRef(null);
  const [userId, setUserId] = useState('alice');
  const [chatId, setChatId] = useState('global-room');
  const [token, setToken] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [messages, setMessages] = useState([]);
  const [errors, setErrors] = useState([]);

  const canSend = useMemo(() => status === 'connected' && text.trim().length > 0, [status, text]);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

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
    setText('');
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
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Type a message" />
          <button type="button" onClick={sendMessage} disabled={!canSend}>
            Send
          </button>
        </div>

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
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Errors</h2>
        {errors.length === 0 ? <p>None</p> : null}
        {errors.map((error) => (
          <p key={error} className="error-item">
            {error}
          </p>
        ))}
      </section>
    </main>
  );
}
