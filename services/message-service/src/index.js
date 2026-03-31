const dotenv = require('dotenv');
const pino = require('pino');

dotenv.config();

const logger = pino({ name: 'message-service' });
const port = Number(process.env.MESSAGE_SERVICE_PORT || 8090);

logger.info({ port }, 'Message service scaffold is up');
