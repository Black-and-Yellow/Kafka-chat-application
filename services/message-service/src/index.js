const dotenv = require('dotenv');
const pino = require('pino');
const { createServer } = require('http');
const { randomUUID } = require('crypto');
const { startMessageConsumer } = require('./kafkaConsumer');
const { migrate, saveMessage, saveReadReceipt, listMessagesByChat, pingDb, closePool } = require('./db');
const { startEventPublisher, publishDeliverEvent, publishDeadLetter } = require('./eventPublisher');
const { startEventsConsumer } = require('./eventsConsumer');

dotenv.config();

const logger = pino({
	name: 'message-service',
	level: process.env.LOG_LEVEL || 'info'
});
const port = Number(process.env.MESSAGE_SERVICE_PORT || 8090);
let kafkaRuntime;
let publisherRuntime;
let eventsRuntime;

const readiness = {
	db: false,
	publisher: false,
	eventsConsumer: false,
	messageConsumer: false
};

function sendJson(res, statusCode, body) {
	res.writeHead(statusCode, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

function parseLimit(rawValue) {
	if (typeof rawValue !== 'string' || rawValue.trim() === '') {
		return 30;
	}

	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed)) {
		return 30;
	}

	return Math.min(100, Math.max(1, Math.floor(parsed)));
}

async function writeDeadLetter(category, payload, meta, error) {
	if (!publisherRuntime) {
		logger.error({ category, payload, meta, err: error }, 'Cannot publish dead letter without event publisher');
		return;
	}

	try {
		await publishDeadLetter(publisherRuntime.producer, {
			dead_letter_id: randomUUID(),
			category,
			payload,
			meta,
			error: error ? { message: error.message } : null,
			created_at: new Date().toISOString(),
			chat_id: payload?.chat_id || meta?.chatKey || 'unknown'
		});
	} catch (publishError) {
		logger.error(
			{
				err: publishError,
				category,
				payload,
				meta
			},
			'Failed to publish dead letter event'
		);
	}
}

const server = createServer((req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

	if (url.pathname === '/health') {
		sendJson(res, 200, {
			ok: true,
			service: 'message-service',
			readiness,
			uptime_seconds: Math.round(process.uptime())
		});
		return;
	}

	if (url.pathname === '/ready') {
		void (async () => {
			let dbReachable = false;
			try {
				await pingDb();
				dbReachable = true;
			} catch (error) {
				logger.warn({ err: error }, 'Database ping failed during readiness probe');
			}

			const ready = dbReachable && readiness.publisher && readiness.eventsConsumer && readiness.messageConsumer;
			sendJson(res, ready ? 200 : 503, {
				ok: ready,
				service: 'message-service',
				readiness: {
					...readiness,
					db: dbReachable
				}
			});
		})().catch((error) => {
			logger.error({ err: error }, 'Failed to complete readiness probe');
			sendJson(res, 503, {
				ok: false,
				service: 'message-service',
				error: 'Readiness probe failed'
			});
		});
		return;
	}

	if (req.method === 'GET' && url.pathname === '/messages') {
		void (async () => {
			const chatId = url.searchParams.get('chat_id');
			if (!chatId) {
				sendJson(res, 400, { error: 'chat_id query param is required' });
				return;
			}

			const limit = parseLimit(url.searchParams.get('limit'));
			const beforeRaw = url.searchParams.get('before');
			let beforeDate = null;
			if (beforeRaw) {
				const parsed = new Date(beforeRaw);
				if (Number.isNaN(parsed.getTime())) {
					sendJson(res, 400, { error: 'before must be a valid ISO datetime' });
					return;
				}
				beforeDate = parsed;
			}

			const messages = await listMessagesByChat(logger, {
				chatId,
				limit,
				before: beforeDate
			});

			sendJson(res, 200, {
				chat_id: chatId,
				count: messages.length,
				messages
			});
		})().catch((error) => {
			logger.error({ err: error, path: '/messages' }, 'Failed to fetch message history');
			sendJson(res, 500, { error: 'Unable to fetch message history' });
		});
		return;
	}

	sendJson(res, 404, { error: 'Not found' });
});

async function start() {
	await migrate(logger);
	await pingDb();
	readiness.db = true;

	publisherRuntime = await startEventPublisher(logger);
	readiness.publisher = true;

	eventsRuntime = await startEventsConsumer(logger, {
		async onEvent(eventEnvelope, meta) {
			if (eventEnvelope.type === 'chat.typing') {
				logger.debug(
					{
						chatId: eventEnvelope.payload?.chat_id,
						userId: eventEnvelope.payload?.user_id,
						isTyping: eventEnvelope.payload?.is_typing,
						meta
					},
					'Received typing event'
				);
				return;
			}

			if (eventEnvelope.type !== 'chat.read') {
				return;
			}

			const payload = eventEnvelope.payload || {};
			if (!payload.chat_id || !payload.message_id || !payload.user_id || !payload.read_at) {
				logger.warn({ payload, meta }, 'Skipping invalid read receipt payload');
				return;
			}

			const writeResult = await saveReadReceipt(logger, payload);
			if (!writeResult.inserted) {
				logger.warn(
					{
						chatId: payload.chat_id,
						messageId: payload.message_id,
						userId: payload.user_id,
						meta
					},
					'Duplicate read receipt ignored by idempotency check'
				);
				return;
			}

			logger.info(
				{
					chatId: payload.chat_id,
					messageId: payload.message_id,
					userId: payload.user_id,
					meta
				},
				'Persisted read receipt'
			);
		},
		async onMalformedEvent(payload, meta) {
			await writeDeadLetter('events.malformed', payload, meta, null);
		},
		async onInvalidEvent(payload, meta) {
			await writeDeadLetter('events.invalid-shape', payload, meta, null);
		},
		async onProcessingFailure(payload, meta, error) {
			await writeDeadLetter('events.processing-failure', payload, meta, error);
		}
	});
	readiness.eventsConsumer = true;

	kafkaRuntime = await startMessageConsumer(logger, {
		async onMessage(payload, meta) {
			const writeResult = await saveMessage(logger, payload);

			if (!writeResult.inserted) {
				logger.warn(
					{
						chatId: payload.chat_id,
						messageId: payload.message_id,
						userId: payload.user_id,
						meta
					},
					'Duplicate message ignored by idempotency check'
				);
				return;
			}

			await publishDeliverEvent(publisherRuntime.producer, payload);

			logger.info(
				{
					meta,
					chatId: payload.chat_id,
					messageId: payload.message_id,
					userId: payload.user_id
				},
				'Consumed chat message from Kafka'
			);
		},
		async onMalformedPayload(payload, meta) {
			await writeDeadLetter('messages.malformed', payload, meta, null);
		},
		async onInvalidPayload(payload, meta) {
			await writeDeadLetter('messages.invalid-shape', payload, meta, null);
		},
		async onProcessingFailure(payload, meta, error) {
			await writeDeadLetter('messages.processing-failure', payload, meta, error);
		}
	});
	readiness.messageConsumer = true;

	server.listen(port, () => {
		logger.info({ port }, 'Message service is listening');
	});
}

async function shutdown(signal) {
	logger.info({ signal }, 'Shutting down message service');
	server.close();

	if (kafkaRuntime) {
		await kafkaRuntime.disconnect();
		readiness.messageConsumer = false;
	}

	if (eventsRuntime) {
		await eventsRuntime.disconnect();
		readiness.eventsConsumer = false;
	}

	if (publisherRuntime) {
		await publisherRuntime.disconnect();
		readiness.publisher = false;
	}

	await closePool();
	readiness.db = false;

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
	logger.error({ err: error }, 'Message service failed to start');
	process.exit(1);
});
