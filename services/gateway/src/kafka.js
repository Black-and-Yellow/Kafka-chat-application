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

module.exports = {
  TOPICS,
  startKafkaProducer,
  publishChatMessage
};
