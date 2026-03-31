const dotenv = require('dotenv');
const pino = require('pino');
const { createServer } = require('http');
const { startMessageConsumer } = require('./kafkaConsumer');
const { migrate, saveMessage, saveReadReceipt, closePool } = require('./db');
const { startEventPublisher, publishDeliverEvent } = require('./eventPublisher');
const { startEventsConsumer } = require('./eventsConsumer');

dotenv.config();

const logger = pino({ name: 'message-service' });
const port = Number(process.env.MESSAGE_SERVICE_PORT || 8090);
let kafkaRuntime;
let publisherRuntime;
let eventsRuntime;

const server = createServer((req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

	if (url.pathname === '/health') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, service: 'message-service' }));
		return;
	}

	res.writeHead(404, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not found' }));
});

async function start() {
	await migrate(logger);

	publisherRuntime = await startEventPublisher(logger);

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
		}
	});

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
		}
	});

	server.listen(port, () => {
		logger.info({ port }, 'Message service is listening');
	});
}

async function shutdown(signal) {
	logger.info({ signal }, 'Shutting down message service');
	server.close();

	if (kafkaRuntime) {
		await kafkaRuntime.disconnect();
	}

	if (eventsRuntime) {
		await eventsRuntime.disconnect();
	}

	if (publisherRuntime) {
		await publisherRuntime.disconnect();
	}

	await closePool();

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
