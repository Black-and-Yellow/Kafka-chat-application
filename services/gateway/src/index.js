const dotenv = require('dotenv');
const pino = require('pino');

dotenv.config();

const logger = pino({ name: 'gateway' });
const port = Number(process.env.GATEWAY_PORT || 8080);

logger.info({ port }, 'Gateway service scaffold is up');
