import React, { useRef, useEffect } from 'react';
import { formatTime } from '../lib/utils.js';

function TypingIndicator({ typingUsers }) {
  if (typingUsers.length === 0) return null;
  const names = typingUsers.map((t) => t.user_id).join(', ');
  return (
    <div className="typing-indicator" aria-live="polite">
      <div className="typing-dots"><span /><span /><span /></div>
      <span>{names} {typingUsers.length === 1 ? 'is' : 'are'} typing</span>
    </div>
  );
}

function MessageBubble({ message, isSelf, receiptCount }) {
  return (
    <article className={`msg-row ${isSelf ? 'self' : 'other'}`}>
      <div className="msg-bubble">
        {!isSelf && <div className="msg-author">{message.user_id}</div>}
        <p className="msg-text">{message.text || message.body_text}</p>
        <div className="msg-meta">
          <time>{formatTime(message.created_at)}</time>
          {isSelf && (
            <span className="msg-receipt" aria-label={receiptCount > 0 ? `Seen by ${receiptCount}` : 'Sent'}>
              {receiptCount > 0 ? '✓✓' : '✓'}
            </span>
          )}
          {receiptCount > 0 && <span className="msg-seen-count">Seen {receiptCount}</span>}
        </div>
      </div>
    </article>
  );
}

function SkeletonMessages() {
  return (
    <div className="skeleton-messages" aria-label="Loading messages">
      {[...Array(5)].map((_, i) => (
        <div key={i} className={`skeleton-row ${i % 3 === 0 ? 'self' : 'other'}`}>
          <div className="skeleton-bubble"><div className="skeleton-line w60" /><div className="skeleton-line w40" /></div>
        </div>
      ))}
    </div>
  );
}

export default function ConversationPane({
  chatId, userId, status, encryptionEnabled,
  messages, typingUsers, readReceipts,
  onlineCount, text, canSend, transportError,
  onComposerChange, onSend,
}) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  return (
    <main className="conversation" role="main">
      <header className="conv-header">
        <div className="conv-header-left">
          <h2># {chatId}</h2>
          <div className="conv-status">
            <span className={`status-dot ${status === 'connected' ? 'online' : ''}`} />
            <span>{status}</span>
            <span className="conv-divider">•</span>
            <span>{onlineCount} online</span>
          </div>
        </div>
        <div className="conv-header-right">
          <span className="encrypt-badge">{encryptionEnabled ? '🔒 Encrypted' : '🔓 Plaintext'}</span>
        </div>
      </header>

      {transportError && (
        <div className="conv-alert" role="alert">{transportError}</div>
      )}

      <section className="conv-timeline" aria-label="Messages">
        {status === 'connecting' && <SkeletonMessages />}

        {status !== 'connecting' && messages.length === 0 && (
          <div className="conv-empty">
            <div className="conv-empty-icon">💬</div>
            <h3>No messages yet</h3>
            <p>Be the first to send a message in #{chatId}</p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.message_id}
            message={msg}
            isSelf={msg.user_id === userId}
            receiptCount={Object.keys(readReceipts[msg.message_id] || {}).length}
          />
        ))}

        <TypingIndicator typingUsers={typingUsers} />
        <div ref={endRef} />
      </section>

      <footer className="conv-composer">
        <input
          type="text"
          value={text}
          placeholder={status === 'connected' ? 'Type a message...' : 'Connect to send messages'}
          disabled={status !== 'connected'}
          aria-label="Message input"
          onChange={(e) => onComposerChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          className="send-btn"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </footer>
    </main>
  );
}
