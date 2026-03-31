const { Kafka, logLevel } = require('kafkajs');

const TOPICS = {
  MESSAGES: 'messages',
  EVENTS: 'events',
  PRESENCE: 'presence'
};

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

        // Offset handling: malformed frames are considered poison messages and are
        // committed to avoid permanently stalling this partition.
        await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
        return;
      }

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

      // Offset handling: commit only after successful processing for at-least-once delivery.
      await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
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
