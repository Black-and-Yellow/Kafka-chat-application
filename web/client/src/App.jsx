import React from 'react';
import useAuth from './hooks/useAuth.js';
import useChat from './hooks/useChat.js';
import Navbar from './components/Navbar.jsx';
import HeroSection from './components/HeroSection.jsx';
import AuthCard from './components/AuthCard.jsx';
import Sidebar from './components/Sidebar.jsx';
import ConversationPane from './components/ConversationPane.jsx';

export default function App() {
  const auth = useAuth();
  const chat = useChat({ authUser: auth.authUser, token: auth.token });

  // Landing page for unauthenticated users
  if (!auth.authUser) {
    const scrollToAuth = () => {
      document.getElementById('auth-card')?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
      <div className="landing">
        <Navbar onLoginClick={scrollToAuth} />
        <HeroSection
          authCardSlot={
            <AuthCard
              authBusy={auth.authBusy}
              authError={auth.authError}
              onGoogleAuth={auth.handleGoogleAuth}
              onEmailSignIn={auth.handleEmailSignIn}
              onEmailSignUp={auth.handleEmailSignUp}
              onClearError={() => auth.setAuthError('')}
            />
          }
        />
        <footer className="landing-footer">
          <p>Fast, private messaging with real-time delivery and secure sessions.</p>
        </footer>
      </div>
    );
  }

  // Chat application for authenticated users
  return (
    <div className="chat-app">
      <Sidebar
        authUser={auth.authUser}
        rooms={chat.rooms}
        chatId={chat.chatId}
        setChatId={chat.setChatId}
        newRoomName={chat.newRoomName}
        setNewRoomName={chat.setNewRoomName}
        addRoom={chat.addRoom}
        status={chat.status}
        onlineCount={chat.onlineCount}
        encryptionEnabled={chat.encryptionEnabled}
        setEncryptionEnabled={chat.setEncryptionEnabled}
        token={auth.token}
        onIssueToken={() => auth.issueDevToken().catch((e) => chat.setTransportError(e.message))}
        onConnect={chat.connect}
        onLeaveRoom={() => chat.leaveRoom(chat.chatId)}
        onLogout={() => { chat.disconnectSocket(); auth.handleLogout(); }}
        transportError={chat.transportError}
        reconnectCount={chat.reconnectCount}
      />
      <ConversationPane
        chatId={chat.chatId}
        userId={auth.authUser.userId}
        status={chat.status}
        encryptionEnabled={chat.encryptionEnabled}
        messages={chat.messages}
        typingUsers={chat.typingUsers}
        readReceipts={chat.readReceipts}
        onlineCount={chat.onlineCount}
        text={chat.text}
        canSend={chat.canSend}
        transportError={chat.transportError}
        onComposerChange={chat.handleComposerChange}
        onSend={() => chat.sendMessage().catch((e) => chat.setTransportError(e.message))}
      />
    </div>
  );
}