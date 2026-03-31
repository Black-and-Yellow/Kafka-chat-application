class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.rooms = new Map();
    this.roomUserCounts = new Map();
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
      return null;
    }

    const presenceEvents = [];

    for (const chatId of Array.from(session.chats)) {
      const leaveState = this.leaveRoom(socket, chatId);
      if (leaveState.left) {
        presenceEvents.push({
          chatId,
          userId: session.userId,
          becameOffline: leaveState.becameOffline
        });
      }
    }

    this.sessions.delete(socket);

    return {
      userId: session.userId,
      presenceEvents
    };
  }

  joinRoom(socket, chatId) {
    const session = this.sessions.get(socket);
    if (!session) {
      return {
        joined: false,
        becameOnline: false,
        userId: null
      };
    }

    if (session.chats.has(chatId)) {
      return {
        joined: false,
        becameOnline: false,
        userId: session.userId
      };
    }

    session.chats.add(chatId);

    if (!this.rooms.has(chatId)) {
      this.rooms.set(chatId, new Set());
    }

    this.rooms.get(chatId).add(socket);

    if (!this.roomUserCounts.has(chatId)) {
      this.roomUserCounts.set(chatId, new Map());
    }

    const userCounts = this.roomUserCounts.get(chatId);
    const currentCount = userCounts.get(session.userId) || 0;
    userCounts.set(session.userId, currentCount + 1);

    return {
      joined: true,
      becameOnline: currentCount === 0,
      userId: session.userId
    };
  }

  leaveRoom(socket, chatId) {
    const session = this.sessions.get(socket);
    if (!session || !session.chats.has(chatId)) {
      return {
        left: false,
        becameOffline: false,
        userId: session ? session.userId : null
      };
    }

    session.chats.delete(chatId);

    const room = this.rooms.get(chatId);
    if (room) {
      room.delete(socket);
      if (room.size === 0) {
        this.rooms.delete(chatId);
      }
    }

    let becameOffline = false;
    const userCounts = this.roomUserCounts.get(chatId);
    if (userCounts) {
      const currentCount = userCounts.get(session.userId) || 0;
      const nextCount = Math.max(0, currentCount - 1);
      if (nextCount === 0) {
        userCounts.delete(session.userId);
        becameOffline = currentCount > 0;
      } else {
        userCounts.set(session.userId, nextCount);
      }

      if (userCounts.size === 0) {
        this.roomUserCounts.delete(chatId);
      }
    }

    return {
      left: true,
      becameOffline,
      userId: session.userId
    };
  }

  getSession(socket) {
    return this.sessions.get(socket);
  }

  getSocketsForRoom(chatId) {
    return this.rooms.get(chatId) || new Set();
  }

  getOnlineUsersForRoom(chatId) {
    const userCounts = this.roomUserCounts.get(chatId);
    if (!userCounts) {
      return [];
    }

    return Array.from(userCounts.keys());
  }
}

module.exports = {
  SessionStore
};
