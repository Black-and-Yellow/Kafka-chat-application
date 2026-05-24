const dotenv = require('dotenv');
const pino = require('pino');
const { createServer } = require('http');
const { Kafka, logLevel } = require('kafkajs');
const { RetryQueue } = require('./retryQueue');

dotenv.config();

const logger = pino({ name: 'dlq-worker', level: process.env.LOG_LEVEL || 'info' });
const port = Number(process.env.DLQ_WORKER_PORT || 8095);
const TOPIC = 'dead_letters';

function parseBrokers() {
  return (process.env.KAFKA_BROKERS || 'localhost:9092').split(',').map((b) => b.trim()).filter(Boolean);
}

const retryQueue = new RetryQueue(logger, {
  maxRetries: Number(process.env.DLQ_MAX_RETRIES || 3),
  baseDelayMs: Number(process.env.DLQ_BASE_DELAY_MS || 2000),
});

const readiness = { consumer: false };
let consumerRuntime;

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'dlq-worker', uptime_seconds: Math.round(process.uptime()) });
    return;
  }
  if (url.pathname === '/ready') {
    sendJson(res, readiness.consumer ? 200 : 503, { ok: readiness.consumer, service: 'dlq-worker', readiness });
    return;
  }
  if (url.pathname === '/dlq/stats') {
    sendJson(res, 200, { service: 'dlq-worker', stats: retryQueue.getStats() });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

async function start() {
  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'dlq-worker',
    brokers: parseBrokers(),
    logLevel: logLevel.NOTHING,
    retry: { retries: 8, initialRetryTime: 300 },
  });

  const consumer = kafka.consumer({
    groupId: process.env.DLQ_CONSUMER_GROUP || 'dlq-worker-v1',
  });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const offset = message.offset;
      const raw = message.value ? message.value.toString() : '{}';
      const nextOffset = (BigInt(offset) + 1n).toString();

      let deadLetter;
      try {
        deadLetter = JSON.parse(raw);
      } catch (err) {
        logger.error({ err, offset }, 'Unparseable dead letter — skipping');
        await consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
        return;
      }

      const category = deadLetter.category || 'unknown';
      const id = deadLetter.dead_letter_id || `unknown-${offset}`;

      logger.info(
        { id, category, chatId: deadLetter.chat_id, offset },
        'Processing dead letter'
      );

      const evaluation = retryQueue.evaluate(deadLetter);

      if (!evaluation.shouldRetry) {
        logger.info({ id, category, reason: evaluation.reason }, 'Dead letter not retryable');
        await consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
        return;
      }

      // For processing failures, wait with backoff then log (actual replay to source topic would go here)
      logger.info(
        { id, category, attempt: evaluation.attempt, delayMs: evaluation.delayMs },
        'Scheduling retry for dead letter'
      );

      await new Promise((resolve) => setTimeout(resolve, Math.min(evaluation.delayMs, 10000)));

      // In production, this would republish to the original topic.
      // For now, we mark it and log the retry.
      retryQueue.markSuccess(id);
      logger.info({ id, category, attempt: evaluation.attempt }, 'Dead letter retry processed');

      await consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
    },
  });

  readiness.consumer = true;
  consumerRuntime = { consumer, disconnect: () => consumer.disconnect() };

  server.listen(port, () => {
    logger.info({ port }, 'DLQ worker is listening');
  });
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down DLQ worker');
  server.close();
  if (consumerRuntime) {
    await consumerRuntime.disconnect();
    readiness.consumer = false;
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
start().catch((err) => { logger.error({ err }, 'DLQ worker failed to start'); process.exit(1); });
