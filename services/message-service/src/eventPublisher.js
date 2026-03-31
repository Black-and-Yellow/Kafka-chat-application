const { Kafka, logLevel } = require('kafkajs');

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
  const producer = kafka.producer({ allowAutoTopicCreation: false });

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
    topic: 'events',
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

module.exports = {
  startEventPublisher,
  publishDeliverEvent
};
