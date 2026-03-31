const { Kafka, logLevel } = require('kafkajs');

const TOPIC_EVENTS = 'events';

function parseBrokers() {
  const raw = process.env.KAFKA_BROKERS || 'localhost:9092';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function createKafka(logger) {
  return new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'kafka-chat-app-message-events-consumer',
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

async function startEventsConsumer(logger, handlers) {
  const kafka = createKafka(logger);
  const consumer = kafka.consumer({
    groupId: process.env.EVENTS_CONSUMER_GROUP || 'message-events-v1'
  });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_EVENTS, fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const value = message.value ? message.value.toString() : '{}';
      const source = message.headers?.source ? message.headers.source.toString() : 'unknown';
      const offset = message.offset;

      let eventEnvelope;
      try {
        eventEnvelope = JSON.parse(value);
      } catch (error) {
        logger.error({ err: error, topic, partition, offset, value }, 'Dropping malformed event payload');
        await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
        return;
      }

      // Ignore self-generated delivery events and process only relevant upstream events.
      if (source !== 'gateway') {
        await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
        return;
      }

      await handlers.onEvent(eventEnvelope, {
        topic,
        partition,
        offset,
        source
      });

      // Offset handling: commit after successful processing to preserve at-least-once semantics.
      await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
    }
  });

  logger.info({ brokers: parseBrokers() }, 'Events consumer connected');

  return {
    consumer,
    async disconnect() {
      await consumer.disconnect();
    }
  };
}

module.exports = {
  startEventsConsumer
};
