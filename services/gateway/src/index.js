const { createServer } = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const pino = require('pino');
const { randomUUID } = require('crypto');
const { extractToken, verifyToken } = require('./auth');
const { SessionStore } = require('./sessionStore');
const {
	buildServerKeyPair,
	decryptSessionKey,
	encryptTextWithAesGcm,
	decryptTextWithAesGcm
} = require('./encryption');
const {
	startKafkaProducer,
	startEventConsumer,
	startPresenceConsumer,
	publishChatMessage,
	publishEvent,
	publishPresenceEvent
} = require('./kafka');

dotenv.config();

const logger = pino({
	name: 'gateway',
	level: process.env.LOG_LEVEL || 'info'
});

function readPositiveInteger(envName, fallback) {
	const parsed = Number.parseInt(process.env[envName] || '', 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

const port = Number(process.env.GATEWAY_PORT || 8080);
const jwtSecret = process.env.JWT_SECRET || 'dev_secret_change_me';
const nodeEnv = process.env.NODE_ENV || 'development';
const messageServiceUrl = process.env.MESSAGE_SERVICE_URL || 'http://localhost:8090';
const historyLimit = readPositiveInteger('CHAT_HISTORY_LIMIT', 30);
const maxMessageLength = readPositiveInteger('CHAT_MAX_MESSAGE_LENGTH', 4000);
const maxFrameBytes = readPositiveInteger('GATEWAY_MAX_FRAME_BYTES', 32768);
const frameRateWindowMs = readPositiveInteger('GATEWAY_FRAME_RATE_WINDOW_MS', 60000);
const frameRateLimit = readPositiveInteger('GATEWAY_FRAME_RATE_LIMIT', 120);
const { WebSocketServer } = WebSocket;
const sessionStore = new SessionStore();
const serverKeys = buildServerKeyPair();
let kafkaRuntime;
let eventConsumerRuntime;
let presenceConsumerRuntime;

const readiness = {
	kafkaProducer: false,
	eventsConsumer: false,
	presenceConsumer: false
};

const socketFrameRateCounters = new WeakMap();

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

function sendHttpJson(res, statusCode, body) {
	res.writeHead(statusCode, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

function isRateLimitExceeded(socket) {
	const now = Date.now();
	const existing = socketFrameRateCounters.get(socket);

	if (!existing || now - existing.windowStart >= frameRateWindowMs) {
		socketFrameRateCounters.set(socket, {
			windowStart: now,
			count: 1
		});
		return false;
	}

	existing.count += 1;
	return existing.count > frameRateLimit;
}

function normalizeHistoryLimit(rawLimit) {
	const parsed = Number(rawLimit);
	if (!Number.isFinite(parsed)) {
		return 30;
	}

	return Math.max(1, Math.min(100, Math.floor(parsed)));
}

async function fetchChatHistory(chatId) {
	const limit = normalizeHistoryLimit(historyLimit);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2500);

	try {
		const endpoint = `${messageServiceUrl}/messages?chat_id=${encodeURIComponent(chatId)}&limit=${limit}`;
		const response = await fetch(endpoint, {
			signal: controller.signal
		});

		if (!response.ok) {
			throw new Error(`Message history request failed with status ${response.status}`);
		}

		const data = await response.json();
		if (!Array.isArray(data.messages)) {
			return [];
		}

		return data.messages;
	} finally {
		clearTimeout(timeout);
	}
}

function resolveInboundMessageText(socket, payload) {
	if (typeof payload?.text === 'string' && payload.text.trim() !== '') {
		return payload.text.trim();
	}

	if (payload?.encrypted_text) {
		const keyBuffer = sessionStore.getEncryptionKey(socket);
		if (!keyBuffer) {
			throw new Error('Encrypted message received before key exchange');
		}

		const plainText = decryptTextWithAesGcm(payload.encrypted_text, keyBuffer).trim();
		if (!plainText) {
			throw new Error('Decrypted message body is empty');
		}

		return plainText;
	}

	throw new Error('chat.message requires text or encrypted_text');
}

function buildOutboundMessageForSocket(socket, payload) {
	const keyBuffer = sessionStore.getEncryptionKey(socket);
	if (!keyBuffer || typeof payload?.text !== 'string') {
		return payload;
	}

	const { text, ...rest } = payload;
	return {
		...rest,
		encrypted: true,
		encrypted_text: encryptTextWithAesGcm(text, keyBuffer)
	};
}

function deliverMessageToRoom(payload) {
	const roomSockets = sessionStore.getSocketsForRoom(payload.chat_id);
	let encryptedFanout = 0;

	for (const clientSocket of roomSockets) {
		const outboundPayload = buildOutboundMessageForSocket(clientSocket, payload);
		if (outboundPayload.encrypted) {
			encryptedFanout += 1;
		}

		sendJson(clientSocket, {
			type: 'chat.message',
			payload: outboundPayload
		});
	}

	logger.info(
		{
			chatId: payload.chat_id,
			messageId: payload.message_id,
			fanout: roomSockets.size,
			encryptedFanout
		},
		'Delivered persisted message to active room sockets'
	);
}

function fanoutEventToRoom(eventType, payload) {
	const roomSockets = sessionStore.getSocketsForRoom(payload.chat_id);

	for (const clientSocket of roomSockets) {
		sendJson(clientSocket, {
			type: eventType,
			payload
		});
	}

	logger.info(
		{
			eventType,
			chatId: payload.chat_id,
			fanout: roomSockets.size
		},
		'Fanout event to room sockets'
	);
}

function fanoutPresenceToRoom(payload) {
	const roomSockets = sessionStore.getSocketsForRoom(payload.chat_id);

	for (const clientSocket of roomSockets) {
		sendJson(clientSocket, {
			type: 'presence.update',
			payload
		});
	}

	logger.info(
		{
			chatId: payload.chat_id,
			userId: payload.user_id,
			status: payload.status,
			fanout: roomSockets.size
		},
		'Fanout presence update to room sockets'
	);
}

async function emitPresenceUpdate(chatId, userId, status) {
	if (!kafkaRuntime) {
		logger.warn({ chatId, userId, status }, 'Skipping presence update because Kafka is unavailable');
		return;
	}

	await publishPresenceEvent(kafkaRuntime.producer, {
		chat_id: chatId,
		user_id: userId,
		status,
		updated_at: new Date().toISOString()
	});
}

async function handleClientFrame(socket, rawFrame) {
	let frame;

	if (Buffer.byteLength(rawFrame) > maxFrameBytes) {
		sendError(socket, 'FRAME_TOO_LARGE', `Frame exceeds ${maxFrameBytes} bytes`);
		return;
	}

	if (isRateLimitExceeded(socket)) {
		sendError(socket, 'RATE_LIMITED', 'Too many messages in a short time window');
		return;
	}

	try {
		frame = JSON.parse(rawFrame.toString());
	} catch {
		sendError(socket, 'BAD_JSON', 'Frame must be valid JSON');
		return;
	}

	if (typeof frame?.type !== 'string') {
		sendError(socket, 'INVALID_FRAME', 'Frame type must be a string');
		return;
	}

	const session = sessionStore.getSession(socket);
	if (!session) {
		sendError(socket, 'NO_SESSION', 'Session not found');
		return;
	}

	if (frame.type === 'crypto.key_exchange') {
		const encryptedKey = frame.payload?.encrypted_key;
		if (!encryptedKey || typeof encryptedKey !== 'string') {
			sendError(socket, 'INVALID_KEY_EXCHANGE', 'encrypted_key is required');
			return;
		}

		try {
			const keyBuffer = decryptSessionKey(serverKeys.privateKey, encryptedKey);
			sessionStore.setEncryptionKey(socket, keyBuffer);
		} catch (error) {
			logger.warn({ err: error, userId: session.userId }, 'Key exchange failed');
			sendError(socket, 'KEY_EXCHANGE_FAILED', 'Could not establish encrypted session');
			return;
		}

		sendJson(socket, {
			type: 'crypto.ack',
			payload: {
				status: 'ready'
			}
		});
		return;
	}

	if (frame.type === 'chat.join') {
		const chatIdRaw = frame.payload?.chat_id;
		const chatId = typeof chatIdRaw === 'string' ? chatIdRaw.trim() : '';
		if (!chatId) {
			sendError(socket, 'INVALID_CHAT', 'chat_id is required');
			return;
		}

		const joinState = sessionStore.joinRoom(socket, chatId);

		if (joinState.joined && joinState.becameOnline) {
			try {
				await emitPresenceUpdate(chatId, session.userId, 'online');
			} catch (error) {
				logger.error({ err: error, chatId, userId: session.userId }, 'Presence online publish failed');
			}
		}

		sendJson(socket, {
			type: 'chat.joined',
			payload: {
				chat_id: chatId,
				user_id: session.userId,
				online_users: sessionStore.getOnlineUsersForRoom(chatId)
			}
		});

		try {
			const historyMessages = await fetchChatHistory(chatId);
			const outboundHistory = historyMessages.map((message) => buildOutboundMessageForSocket(socket, message));
			sendJson(socket, {
				type: 'chat.history',
				payload: {
					chat_id: chatId,
					messages: outboundHistory
				}
			});
		} catch (error) {
			logger.warn({ err: error, chatId }, 'Failed to fetch room history on join');
		}
		return;
	}

	if (frame.type === 'chat.leave') {
		const chatIdRaw = frame.payload?.chat_id;
		const chatId = typeof chatIdRaw === 'string' ? chatIdRaw.trim() : '';
		if (!chatId) {
			sendError(socket, 'INVALID_CHAT', 'chat_id is required');
			return;
		}

		const leaveState = sessionStore.leaveRoom(socket, chatId);
		if (!leaveState.left) {
			sendError(socket, 'NOT_IN_CHAT', 'Socket is not currently joined to chat_id');
			return;
		}

		if (leaveState.becameOffline) {
			try {
				await emitPresenceUpdate(chatId, session.userId, 'offline');
			} catch (error) {
				logger.error({ err: error, chatId, userId: session.userId }, 'Presence offline publish failed');
			}
		}

		sendJson(socket, {
			type: 'chat.left',
			payload: {
				chat_id: chatId,
				user_id: session.userId
			}
		});
		return;
	}

	if (frame.type === 'chat.message') {
		const chatIdRaw = frame.payload?.chat_id;
		const chatId = typeof chatIdRaw === 'string' ? chatIdRaw.trim() : '';
		if (!chatId) {
			sendError(socket, 'INVALID_MESSAGE', 'chat_id is required');
			return;
		}

		let normalizedText;
		try {
			normalizedText = resolveInboundMessageText(socket, frame.payload || {});
		} catch (error) {
			sendError(socket, 'INVALID_MESSAGE', error.message);
			return;
		}

		if (normalizedText.length > maxMessageLength) {
			sendError(socket, 'INVALID_MESSAGE', `Message exceeds ${maxMessageLength} characters`);
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
				text: normalizedText,
				created_at: new Date().toISOString()
			}
		};

		if (!kafkaRuntime) {
			sendError(socket, 'KAFKA_UNAVAILABLE', 'Kafka producer is not connected');
			return;
		}

		try {
			await publishChatMessage(kafkaRuntime.producer, outbound.payload);
		} catch (error) {
			logger.error({ err: error, chatId, messageId: outbound.payload.message_id }, 'Kafka publish failed');
			sendError(socket, 'PUBLISH_FAILED', 'Unable to queue message for durable processing');
			return;
		}

		sendJson(socket, {
			type: 'chat.ack',
			payload: {
				message_id: outbound.payload.message_id,
				status: 'queued'
			}
		});

		logger.info(
			{
				chatId,
				userId: session.userId,
				messageId: outbound.payload.message_id
			},
			'Queued message to Kafka messages topic'
		);
		return;
	}

	if (frame.type === 'chat.typing') {
		const chatIdRaw = frame.payload?.chat_id;
		const chatId = typeof chatIdRaw === 'string' ? chatIdRaw.trim() : '';
		const isTyping = frame.payload?.is_typing;

		if (!chatId || typeof isTyping !== 'boolean') {
			sendError(socket, 'INVALID_TYPING_EVENT', 'chat_id and boolean is_typing are required');
			return;
		}

		if (!session.chats.has(chatId)) {
			sessionStore.joinRoom(socket, chatId);
		}

		if (!kafkaRuntime) {
			sendError(socket, 'KAFKA_UNAVAILABLE', 'Kafka producer is not connected');
			return;
		}

		try {
			await publishEvent(kafkaRuntime.producer, chatId, {
				type: 'chat.typing',
				payload: {
					chat_id: chatId,
					user_id: session.userId,
					is_typing: isTyping,
					updated_at: new Date().toISOString()
				}
			});
		} catch (error) {
			logger.error({ err: error, chatId, userId: session.userId }, 'Typing event publish failed');
			sendError(socket, 'EVENT_PUBLISH_FAILED', 'Unable to queue typing event');
			return;
		}

		sendJson(socket, {
			type: 'event.ack',
			payload: {
				event_type: 'chat.typing',
				chat_id: chatId,
				status: 'queued'
			}
		});
		return;
	}

	if (frame.type === 'chat.read') {
		const chatIdRaw = frame.payload?.chat_id;
		const chatId = typeof chatIdRaw === 'string' ? chatIdRaw.trim() : '';
		const messageIdRaw = frame.payload?.message_id;
		const messageId = typeof messageIdRaw === 'string' ? messageIdRaw.trim() : '';

		if (!chatId || !messageId) {
			sendError(socket, 'INVALID_READ_RECEIPT', 'chat_id and message_id are required');
			return;
		}

		if (!session.chats.has(chatId)) {
			sessionStore.joinRoom(socket, chatId);
		}

		if (!kafkaRuntime) {
			sendError(socket, 'KAFKA_UNAVAILABLE', 'Kafka producer is not connected');
			return;
		}

		try {
			await publishEvent(kafkaRuntime.producer, chatId, {
				type: 'chat.read',
				payload: {
					chat_id: chatId,
					message_id: messageId,
					user_id: session.userId,
					read_at: new Date().toISOString()
				}
			});
		} catch (error) {
			logger.error({ err: error, chatId, userId: session.userId }, 'Read receipt publish failed');
			sendError(socket, 'EVENT_PUBLISH_FAILED', 'Unable to queue read receipt');
			return;
		}

		sendJson(socket, {
			type: 'event.ack',
			payload: {
				event_type: 'chat.read',
				chat_id: chatId,
				status: 'queued'
			}
		});
		return;
	}

	sendError(socket, 'UNKNOWN_TYPE', `Unsupported frame type: ${String(frame.type)}`);
}

const httpServer = createServer((req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

	if (url.pathname === '/health') {
		sendHttpJson(res, 200, {
			ok: true,
			service: 'gateway',
			readiness,
			active_connections: wss.clients.size,
			uptime_seconds: Math.round(process.uptime())
		});
		return;
	}

	if (url.pathname === '/ready') {
		const ready = readiness.kafkaProducer && readiness.eventsConsumer && readiness.presenceConsumer;
		sendHttpJson(res, ready ? 200 : 503, {
			ok: ready,
			service: 'gateway',
			readiness
		});
		return;
	}

	if (url.pathname === '/dev/token' && nodeEnv !== 'production') {
		const userId = url.searchParams.get('user_id');
		if (!userId) {
			sendHttpJson(res, 400, { error: 'user_id query param is required' });
			return;
		}

		const token = jwt.sign({ user_id: userId }, jwtSecret, { expiresIn: '12h' });
		sendHttpJson(res, 200, { token });
		return;
	}

	if (url.pathname === '/crypto/public-key') {
		sendHttpJson(res, 200, {
			algorithm: 'RSA-OAEP-256',
			fingerprint: serverKeys.fingerprint,
			public_key: serverKeys.publicKey
		});
		return;
	}

	sendHttpJson(res, 404, { error: 'Not found' });
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket, request, identity) => {
	socket.isAlive = true;
	socketFrameRateCounters.set(socket, {
		windowStart: Date.now(),
		count: 0
	});

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

	socket.on('message', async (frame) => {
		try {
			await handleClientFrame(socket, frame);
		} catch (error) {
			logger.error({ err: error }, 'Unhandled frame error');
			sendError(socket, 'INTERNAL_ERROR', 'Unexpected error while processing frame');
		}
	});

	socket.on('close', () => {
		socketFrameRateCounters.delete(socket);

		const removalState = sessionStore.remove(socket);
		if (!removalState || !kafkaRuntime) {
			return;
		}

		for (const presenceEvent of removalState.presenceEvents) {
			if (!presenceEvent.becameOffline) {
				continue;
			}

			emitPresenceUpdate(presenceEvent.chatId, presenceEvent.userId, 'offline').catch((error) => {
				logger.error(
					{ err: error, chatId: presenceEvent.chatId, userId: presenceEvent.userId },
					'Presence offline publish failed on socket close'
				);
			});
		}
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

async function start() {
	logger.info({ fingerprint: serverKeys.fingerprint }, 'Gateway RSA key pair ready');

	kafkaRuntime = await startKafkaProducer(logger);
	readiness.kafkaProducer = true;

	eventConsumerRuntime = await startEventConsumer(logger, {
		async onEvent(eventEnvelope) {
			if (eventEnvelope.type === 'chat.deliver') {
				deliverMessageToRoom(eventEnvelope.payload);
				return;
			}

			if (eventEnvelope.type === 'chat.typing' || eventEnvelope.type === 'chat.read') {
				fanoutEventToRoom(eventEnvelope.type, eventEnvelope.payload);
			}
		}
	});
	readiness.eventsConsumer = true;

	presenceConsumerRuntime = await startPresenceConsumer(logger, {
		async onPresence(payload) {
			fanoutPresenceToRoom(payload);
		}
	});
	readiness.presenceConsumer = true;

	httpServer.listen(port, () => {
		logger.info({ port }, 'Gateway is listening');
	});
}

async function shutdown(signal) {
	logger.info({ signal }, 'Shutting down gateway');
	clearInterval(heartbeatInterval);
	httpServer.close();

	wss.clients.forEach((socket) => {
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
			socket.close(1001, 'Server shutting down');
		}
	});

	if (kafkaRuntime) {
		await kafkaRuntime.disconnect();
		readiness.kafkaProducer = false;
	}

	if (eventConsumerRuntime) {
		await eventConsumerRuntime.disconnect();
		readiness.eventsConsumer = false;
	}

	if (presenceConsumerRuntime) {
		await presenceConsumerRuntime.disconnect();
		readiness.presenceConsumer = false;
	}

	process.exit(0);
}

process.on('SIGINT', () => {
	shutdown('SIGINT').catch((error) => {
		logger.error({ err: error }, 'Error while shutting down after SIGINT');
		process.exit(1);
	});
});

process.on('SIGTERM', () => {
	shutdown('SIGTERM').catch((error) => {
		logger.error({ err: error }, 'Error while shutting down after SIGTERM');
		process.exit(1);
	});
});

start().catch((error) => {
	logger.error({ err: error }, 'Gateway failed to start');
	process.exit(1);
});
