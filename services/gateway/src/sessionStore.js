class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.rooms = new Map();
  }

  add(socket, userId) {
    this.sessions.set(socket, {
      userId,
      chats: new Set()
    });
  }

  remove(socket) {
    const session = this.sessions.get(socket);
    if (!session) {
      return;
    }

    for (const chatId of session.chats) {
      this.leaveRoom(socket, chatId);
    }

    this.sessions.delete(socket);
  }

  joinRoom(socket, chatId) {
    const session = this.sessions.get(socket);
    if (!session) {
      return false;
    }

    session.chats.add(chatId);

    if (!this.rooms.has(chatId)) {
      this.rooms.set(chatId, new Set());
    }

    this.rooms.get(chatId).add(socket);
    return true;
  }

  leaveRoom(socket, chatId) {
    const session = this.sessions.get(socket);
    if (session) {
      session.chats.delete(chatId);
    }

    const room = this.rooms.get(chatId);
    if (!room) {
      return;
    }

    room.delete(socket);
    if (room.size === 0) {
      this.rooms.delete(chatId);
    }
  }

  getSession(socket) {
    return this.sessions.get(socket);
  }

  getSocketsForRoom(chatId) {
    return this.rooms.get(chatId) || new Set();
  }
}

module.exports = {
  SessionStore
};
