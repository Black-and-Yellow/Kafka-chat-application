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
    clientId: process.env.KAFKA_CLIENT_ID || 'kafka-chat-app-gateway',
    brokers: parseBrokers(),
    logLevel: logLevel.NOTHING,
    retry: {
      // KafkaJS-level retry for broker/network failures before surfacing errors.
      retries: 8,
      initialRetryTime: 300
    },
    logCreator: () => ({ namespace, level, label, log }) => {
      logger.debug({ namespace, level, label, log }, 'Kafka internal log');
    }
  });
}

async function ensureTopics(admin) {
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic: TOPICS.MESSAGES, numPartitions: 6, replicationFactor: 1 },
      { topic: TOPICS.EVENTS, numPartitions: 6, replicationFactor: 1 },
      { topic: TOPICS.PRESENCE, numPartitions: 3, replicationFactor: 1 }
    ]
  });
}

async function startKafkaProducer(logger) {
  const kafka = createKafka(logger);
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });

  await admin.connect();
  await ensureTopics(admin);
  await admin.disconnect();

  await producer.connect();

  logger.info({ brokers: parseBrokers() }, 'Kafka producer connected');

  return {
    producer,
    async disconnect() {
      await producer.disconnect();
    }
  };
}

async function startEventConsumer(logger, handlers) {
  const kafka = createKafka(logger);
  const consumer = kafka.consumer({
    groupId: process.env.GATEWAY_EVENTS_GROUP || 'gateway-events-v1'
  });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.EVENTS, fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const value = message.value ? message.value.toString() : '{}';
      const offset = message.offset;

      let eventEnvelope;
      try {
        eventEnvelope = JSON.parse(value);
      } catch (error) {
        logger.error({ err: error, topic, partition, offset, value }, 'Invalid event payload in events topic');
        await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
        return;
      }

      await handlers.onEvent(eventEnvelope, {
        topic,
        partition,
        offset
      });

      // Offset handling: commit only after event fanout succeeds.
      await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
    }
  });

  logger.info('Gateway event consumer connected');

  return {
    consumer,
    async disconnect() {
      await consumer.disconnect();
    }
  };
}

async function startPresenceConsumer(logger, handlers) {
  const kafka = createKafka(logger);
  const consumer = kafka.consumer({
    groupId: process.env.GATEWAY_PRESENCE_GROUP || 'gateway-presence-v1'
  });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.PRESENCE, fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const value = message.value ? message.value.toString() : '{}';
      const offset = message.offset;

      let presencePayload;
      try {
        presencePayload = JSON.parse(value);
      } catch (error) {
        logger.error({ err: error, topic, partition, offset, value }, 'Invalid presence payload');
        await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
        return;
      }

      await handlers.onPresence(presencePayload, {
        topic,
        partition,
        offset
      });

      // Offset handling: commit only after successful presence fanout.
      await consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
    }
  });

  logger.info('Gateway presence consumer connected');

  return {
    consumer,
    async disconnect() {
      await consumer.disconnect();
    }
  };
}

async function publishChatMessage(producer, payload) {
  await producer.send({
    topic: TOPICS.MESSAGES,
    messages: [
      {
        // Ordering guarantee: all messages for the same chat_id hash to one partition,
        // so consumer reads that chat stream in partition order.
        key: payload.chat_id,
        value: JSON.stringify(payload),
        headers: {
          event_type: 'chat.message',
          source: 'gateway'
        }
      }
    ]
  });
}

async function publishEvent(producer, key, eventEnvelope) {
  await producer.send({
    topic: TOPICS.EVENTS,
    messages: [
      {
        // Ordering guarantee: event stream for a chat_id stays ordered per partition.
        key,
        value: JSON.stringify(eventEnvelope),
        headers: {
          event_type: eventEnvelope.type,
          source: 'gateway'
        }
      }
    ]
  });
}

async function publishPresenceEvent(producer, payload) {
  await producer.send({
    topic: TOPICS.PRESENCE,
    messages: [
      {
        // Ordering guarantee: presence updates for a chat_id share one partition.
        key: payload.chat_id,
        value: JSON.stringify(payload),
        headers: {
          event_type: 'presence.update',
          source: 'gateway'
        }
      }
    ]
  });
}

module.exports = {
  TOPICS,
  startKafkaProducer,
  startEventConsumer,
  startPresenceConsumer,
  publishChatMessage,
  publishEvent,
  publishPresenceEvent
};
