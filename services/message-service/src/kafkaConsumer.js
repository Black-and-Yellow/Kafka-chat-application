const { Kafka, logLevel } = require('kafkajs');

const TOPICS = {
  MESSAGES: 'messages',
  EVENTS: 'events',
  PRESENCE: 'presence'
};

function nextOffset(offset) {
  return (BigInt(offset) + 1n).toString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDateString(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function validateMessagePayload(payload) {
  return (
    payload &&
    isNonEmptyString(payload.message_id) &&
    isNonEmptyString(payload.chat_id) &&
    isNonEmptyString(payload.user_id) &&
    isNonEmptyString(payload.text) &&
    isIsoDateString(payload.created_at)
  );
}

function parseBrokers() {
  const raw = process.env.KAFKA_BROKERS || 'localhost:9092';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function createKafka(logger) {
  return new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'kafka-chat-app-message-service',
    brokers: parseBrokers(),
    logLevel: logLevel.NOTHING,
    retry: {
      retries: 8,
      initialRetryTime: 300
    },
    logCreator: () => ({ namespace, level, label, log }) => {
      logger.debug({ namespace, level, label, log }, 'Kafka internal log');
    }
  });
}

async function runWithRetry(task, logger, context) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      logger.warn(
        {
          err: error,
          attempt,
          maxAttempts,
          ...context
        },
        'Handler failed, retrying with backoff'
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 200 * attempt);
      });
    }
  }
}

async function startMessageConsumer(logger, handlers) {
  const kafka = createKafka(logger);
  const consumer = kafka.consumer({
    groupId: process.env.MESSAGE_CONSUMER_GROUP || 'message-service-v1'
  });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.MESSAGES, fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const value = message.value ? message.value.toString() : '{}';
      const offset = message.offset;
      const chatKey = message.key ? message.key.toString() : 'unknown';

      let payload;
      try {
        payload = JSON.parse(value);
      } catch (error) {
        logger.error({ err: error, offset, topic, partition, value }, 'Dropping malformed message payload');

        if (handlers.onMalformedPayload) {
          await handlers.onMalformedPayload(
            {
              raw: value,
              reason: 'invalid-json'
            },
            {
              topic,
              partition,
              offset,
              chatKey
            }
          );
        }

        // Offset handling: malformed frames are considered poison messages and are
        // committed to avoid permanently stalling this partition.
        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      if (!validateMessagePayload(payload)) {
        logger.warn({ topic, partition, offset, payload }, 'Dropping invalid message payload shape');

        if (handlers.onInvalidPayload) {
          await handlers.onInvalidPayload(payload, {
            topic,
            partition,
            offset,
            chatKey,
            reason: 'invalid-payload-shape'
          });
        }

        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      try {
        await runWithRetry(
          async () => {
            await handlers.onMessage(payload, {
              topic,
              partition,
              offset
            });
          },
          logger,
          { topic, partition, offset, chatKey }
        );
      } catch (error) {
        logger.error({ err: error, topic, partition, offset, chatKey }, 'Message handler exhausted retries');

        if (handlers.onProcessingFailure) {
          await handlers.onProcessingFailure(
            payload,
            {
            topic,
            partition,
            offset,
            chatKey,
            reason: 'handler-failed-after-retries'
            },
            error
          );
        }

        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      // Offset handling: commit only after successful processing for at-least-once delivery.
      await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
    }
  });

  logger.info({ brokers: parseBrokers() }, 'Message consumer connected');

  return {
    consumer,
    async disconnect() {
      await consumer.disconnect();
    }
  };
}

module.exports = {
  TOPICS,
  startMessageConsumer
};
