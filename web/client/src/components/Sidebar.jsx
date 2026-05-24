import React from 'react';

export default function Sidebar({
  authUser, rooms, chatId, setChatId,
  newRoomName, setNewRoomName, addRoom,
  status, onlineCount, encryptionEnabled, setEncryptionEnabled,
  token, onIssueToken, onConnect, onLeaveRoom, onLogout,
  transportError, reconnectCount,
}) {
  const avatarLabel = authUser?.displayName?.charAt(0)?.toUpperCase() || '?';
  const avatarUrl = authUser?.avatarUrl;

  return (
    <aside className="sidebar" role="complementary">
      <div className="sidebar-brand">
        <svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="#16A34A" fillOpacity="0.15" />
          <path d="M8 14L12 10L16 14L20 10" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 18L12 14L16 18L20 14" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
        </svg>
        <div>
          <h1>KafkaChat</h1>
          <span>Distributed Messaging</span>
        </div>
      </div>

      <div className="sidebar-profile">
        <div className="profile-avatar">
          {avatarUrl ? (
            <img src={avatarUrl} alt={`${authUser.displayName} avatar`} />
          ) : (
            avatarLabel
          )}
        </div>
        <div className="profile-info">
          <strong>{authUser.displayName}</strong>
          <span>{authUser.email || authUser.userId}</span>
        </div>
        <button className="btn-icon logout-btn" onClick={onLogout} aria-label="Logout" title="Logout">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>

      <div className="sidebar-controls">
        {!token && (
          <button className="btn btn-primary btn-sm" onClick={onIssueToken}>Issue Token</button>
        )}
        {token && status !== 'connected' && (
          <button className="btn btn-primary btn-sm" onClick={onConnect}>
            {status === 'connecting' ? 'Connecting...' : 'Connect'}
            {reconnectCount > 0 && <span className="reconnect-badge">retry {reconnectCount}</span>}
          </button>
        )}
        {status === 'connected' && (
          <div className="connection-info">
            <span className="status-dot online" />
            <span>Connected • {onlineCount} online</span>
          </div>
        )}
        <label className="toggle-label">
          <input type="checkbox" checked={encryptionEnabled} onChange={(e) => setEncryptionEnabled(e.target.checked)} />
          <span className="toggle-text">{encryptionEnabled ? '🔒 Encrypted' : '🔓 Plaintext'}</span>
        </label>
      </div>

      <div className="sidebar-rooms">
        <div className="rooms-title">
          <h2>Channels</h2>
          <span className="rooms-count">{rooms.length}</span>
        </div>
        <div className="rooms-scroll" role="list">
          {rooms.map((room) => (
            <button
              key={room}
              type="button"
              role="listitem"
              className={`room-item ${chatId === room ? 'active' : ''}`}
              onClick={() => setChatId(room)}
              aria-current={chatId === room ? 'true' : undefined}
            >
              <span className="room-hash">#</span>
              <span className="room-label">{room}</span>
            </button>
          ))}
        </div>
        <div className="add-room">
          <input
            type="text"
            value={newRoomName}
            placeholder="new-channel"
            aria-label="New channel name"
            onChange={(e) => setNewRoomName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRoom(); }}
          />
          <button className="btn btn-sm btn-ghost" onClick={addRoom} aria-label="Add channel">+</button>
        </div>
      </div>
    </aside>
  );
}
