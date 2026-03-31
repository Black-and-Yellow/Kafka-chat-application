const { Kafka, logLevel } = require('kafkajs');

const TOPIC_EVENTS = 'events';

function nextOffset(offset) {
  return (BigInt(offset) + 1n).toString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidEventEnvelope(eventEnvelope) {
  return (
    eventEnvelope &&
    isNonEmptyString(eventEnvelope.type) &&
    typeof eventEnvelope.payload === 'object' &&
    eventEnvelope.payload !== null
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

        if (handlers.onMalformedEvent) {
          await handlers.onMalformedEvent(
            {
              raw: value,
              reason: 'invalid-json'
            },
            {
              topic,
              partition,
              offset,
              source
            }
          );
        }

        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      if (!isValidEventEnvelope(eventEnvelope)) {
        logger.warn({ topic, partition, offset, eventEnvelope }, 'Dropping invalid event envelope shape');

        if (handlers.onInvalidEvent) {
          await handlers.onInvalidEvent(eventEnvelope, {
            topic,
            partition,
            offset,
            source,
            reason: 'invalid-envelope-shape'
          });
        }

        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      // Ignore self-generated delivery events and process only relevant upstream events.
      if (source !== 'gateway') {
        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      try {
        await handlers.onEvent(eventEnvelope, {
          topic,
          partition,
          offset,
          source
        });
      } catch (error) {
        logger.error({ err: error, topic, partition, offset, source }, 'Event handler failed');

        if (handlers.onProcessingFailure) {
          await handlers.onProcessingFailure(
            eventEnvelope,
            {
            topic,
            partition,
            offset,
            source,
            reason: 'handler-failed'
            },
            error
          );
        }

        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
        return;
      }

      // Offset handling: commit after successful processing to preserve at-least-once semantics.
      await consumer.commitOffsets([{ topic, partition, offset: nextOffset(offset) }]);
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
