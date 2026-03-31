const { createServer } = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const pino = require('pino');
const { randomUUID } = require('crypto');
const { extractToken, verifyToken } = require('./auth');
const { SessionStore } = require('./sessionStore');

dotenv.config();

const logger = pino({ name: 'gateway' });
const port = Number(process.env.GATEWAY_PORT || 8080);
const jwtSecret = process.env.JWT_SECRET || 'dev_secret_change_me';
const nodeEnv = process.env.NODE_ENV || 'development';
const { WebSocketServer } = WebSocket;
const sessionStore = new SessionStore();

function sendJson(socket, body) {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(body));
	}
}

function sendError(socket, code, message) {
	sendJson(socket, {
		type: 'error',
		payload: {
			code,
			message
		}
	});
}

function handleClientFrame(socket, rawFrame) {
	let frame;

	try {
		frame = JSON.parse(rawFrame.toString());
	} catch {
		sendError(socket, 'BAD_JSON', 'Frame must be valid JSON');
		return;
	}

	const session = sessionStore.getSession(socket);
	if (!session) {
		sendError(socket, 'NO_SESSION', 'Session not found');
		return;
	}

	if (frame.type === 'chat.join') {
		const chatId = frame.payload?.chat_id;
		if (!chatId) {
			sendError(socket, 'INVALID_CHAT', 'chat_id is required');
			return;
		}

		sessionStore.joinRoom(socket, chatId);
		sendJson(socket, {
			type: 'chat.joined',
			payload: {
				chat_id: chatId,
				user_id: session.userId
			}
		});
		return;
	}

	if (frame.type === 'chat.message') {
		const chatId = frame.payload?.chat_id;
		const text = frame.payload?.text;
		if (!chatId || typeof text !== 'string' || text.trim() === '') {
			sendError(socket, 'INVALID_MESSAGE', 'chat_id and non-empty text are required');
			return;
		}

		if (!session.chats.has(chatId)) {
			sessionStore.joinRoom(socket, chatId);
		}

		const outbound = {
			type: 'chat.message',
			payload: {
				message_id: frame.payload?.client_msg_id || randomUUID(),
				chat_id: chatId,
				user_id: session.userId,
				text: text.trim(),
				created_at: new Date().toISOString()
			}
		};

		const roomSockets = sessionStore.getSocketsForRoom(chatId);
		for (const clientSocket of roomSockets) {
			sendJson(clientSocket, outbound);
		}

		sendJson(socket, {
			type: 'chat.ack',
			payload: {
				message_id: outbound.payload.message_id,
				status: 'accepted'
			}
		});

		logger.info(
			{
				chatId,
				userId: session.userId,
				messageId: outbound.payload.message_id,
				fanout: roomSockets.size
			},
			'Broadcasted message to room'
		);
		return;
	}

	sendError(socket, 'UNKNOWN_TYPE', `Unsupported frame type: ${String(frame.type)}`);
}

const httpServer = createServer((req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

	if (url.pathname === '/health') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, service: 'gateway' }));
		return;
	}

	if (url.pathname === '/dev/token' && nodeEnv !== 'production') {
		const userId = url.searchParams.get('user_id');
		if (!userId) {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'user_id query param is required' }));
			return;
		}

		const token = jwt.sign({ user_id: userId }, jwtSecret, { expiresIn: '12h' });
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ token }));
		return;
	}

	res.writeHead(404, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket, request, identity) => {
	socket.isAlive = true;
	socket.on('pong', () => {
		socket.isAlive = true;
	});

	sessionStore.add(socket, identity.userId);

	sendJson(socket, {
		type: 'session.ready',
		payload: {
			user_id: identity.userId,
			connected_at: new Date().toISOString()
		}
	});

	socket.on('message', (frame) => {
		try {
			handleClientFrame(socket, frame);
		} catch (error) {
			logger.error({ err: error }, 'Unhandled frame error');
			sendError(socket, 'INTERNAL_ERROR', 'Unexpected error while processing frame');
		}
	});

	socket.on('close', () => {
		sessionStore.remove(socket);
	});

	logger.info({ userId: identity.userId }, 'WebSocket session connected');
});

httpServer.on('upgrade', (request, socket, head) => {
	try {
		const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
		if (url.pathname !== '/ws') {
			socket.destroy();
			return;
		}

		const token = extractToken(request);
		const identity = verifyToken(token, jwtSecret);

		wss.handleUpgrade(request, socket, head, (wsSocket) => {
			wss.emit('connection', wsSocket, request, identity);
		});
	} catch (error) {
		logger.warn({ err: error }, 'WebSocket upgrade rejected');
		socket.destroy();
	}
});

const heartbeatInterval = setInterval(() => {
	wss.clients.forEach((socket) => {
		if (socket.isAlive === false) {
			socket.terminate();
			return;
		}

		socket.isAlive = false;
		socket.ping();
	});
}, 30000);

wss.on('close', () => {
	clearInterval(heartbeatInterval);
});

httpServer.listen(port, () => {
	logger.info({ port }, 'Gateway is listening');
});
