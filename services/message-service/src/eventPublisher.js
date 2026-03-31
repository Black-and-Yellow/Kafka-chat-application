const { Kafka, logLevel } = require('kafkajs');

const TOPIC_EVENTS = 'events';
const TOPIC_DEAD_LETTERS = 'dead_letters';

function parseBrokers() {
  const raw = process.env.KAFKA_BROKERS || 'localhost:9092';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function createKafka(logger) {
  return new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'kafka-chat-app-message-events',
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

async function startEventPublisher(logger) {
  const kafka = createKafka(logger);
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });

  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: TOPIC_EVENTS, numPartitions: 6, replicationFactor: 1 },
        { topic: TOPIC_DEAD_LETTERS, numPartitions: 6, replicationFactor: 1 }
      ]
    });
  } finally {
    await admin.disconnect();
  }

  await producer.connect();
  logger.info({ brokers: parseBrokers() }, 'Event publisher connected');

  return {
    producer,
    async disconnect() {
      await producer.disconnect();
    }
  };
}

async function publishDeliverEvent(producer, message) {
  await producer.send({
    topic: TOPIC_EVENTS,
    messages: [
      {
        key: message.chat_id,
        value: JSON.stringify({
          type: 'chat.deliver',
          payload: message
        }),
        headers: {
          event_type: 'chat.deliver',
          source: 'message-service'
        }
      }
    ]
  });
}

async function publishDeadLetter(producer, payload) {
  await producer.send({
    topic: TOPIC_DEAD_LETTERS,
    messages: [
      {
        key: payload.chat_id || 'unknown',
        value: JSON.stringify(payload),
        headers: {
          event_type: 'dead_letter',
          source: 'message-service'
        }
      }
    ]
  });
}

module.exports = {
  startEventPublisher,
  publishDeliverEvent,
  publishDeadLetter
};
