const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'chatdb',
  user: process.env.POSTGRES_USER || 'chatuser',
  password: process.env.POSTGRES_PASSWORD || 'chatpass',
  max: Number(process.env.POSTGRES_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function withRetry(task, logger, label) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      logger.warn(
        {
          err: error,
          attempt,
          maxAttempts,
          label
        },
        'Database operation failed, retrying'
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 250 * attempt);
      });
    }
  }

  return null;
}

async function migrate(logger) {
  await withRetry(
    async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          body_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_chat_created
          ON messages (chat_id, created_at DESC);
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS read_receipts (
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          read_at TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (chat_id, message_id, user_id)
        );
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_read_receipts_message
          ON read_receipts (message_id, read_at DESC);
      `);
    },
    logger,
    'migrate'
  );

  logger.info('Database migration complete');
}

async function saveMessage(logger, message) {
  const query = {
    text: `
      INSERT INTO messages (message_id, chat_id, user_id, body_text, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (message_id) DO NOTHING
      RETURNING message_id;
    `,
    values: [
      message.message_id,
      message.chat_id,
      message.user_id,
      message.text,
      new Date(message.created_at)
    ]
  };

  const result = await withRetry(
    async () => pool.query(query),
    logger,
    'save-message'
  );

  return {
    inserted: result.rowCount === 1
  };
}

async function saveReadReceipt(logger, receipt) {
  const query = {
    text: `
      INSERT INTO read_receipts (chat_id, message_id, user_id, read_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (chat_id, message_id, user_id) DO NOTHING
      RETURNING message_id;
    `,
    values: [
      receipt.chat_id,
      receipt.message_id,
      receipt.user_id,
      new Date(receipt.read_at)
    ]
  };

  const result = await withRetry(
    async () => pool.query(query),
    logger,
    'save-read-receipt'
  );

  return {
    inserted: result.rowCount === 1
  };
}

async function closePool() {
  await pool.end();
}

module.exports = {
  migrate,
  saveMessage,
  saveReadReceipt,
  closePool
};
