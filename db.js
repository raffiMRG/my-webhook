const { Pool } = require('pg');
const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://webhook:webhook_pass@localhost:5432/webhooks',
});

// pg returns BIGINT as strings — only convert timestamp fields.
// INTEGER/SERIAL (id, user_id) sudah dikembalikan sebagai JS number oleh pg.
// Token id adalah UUID (TEXT), jangan dikonversi.
function norm(row) {
  if (!row) return null;
  const r = { ...row };
  if ('created_at'  in r) r.created_at  = Number(r.created_at);
  if ('received_at' in r) r.received_at = Number(r.received_at);
  return r;
}

// ── Schema ─────────────────────────────────────────────────────────────────────

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL  PRIMARY KEY,
      username      TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      password_salt TEXT    NOT NULL,
      created_at    BIGINT  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id          TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  BIGINT  NOT NULL,
      forward_url TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id          SERIAL  PRIMARY KEY,
      token_id    TEXT    NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      received_at BIGINT  NOT NULL,
      method      TEXT    NOT NULL,
      path        TEXT    NOT NULL,
      query       JSONB   NOT NULL DEFAULT '{}',
      headers     JSONB   NOT NULL DEFAULT '{}',
      body        TEXT,
      ip          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_req_token   ON requests(token_id, received_at DESC);
  `);
}

// ── Password ───────────────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, user) {
  try {
    const computed = scryptSync(password, user.password_salt, 64);
    return timingSafeEqual(computed, Buffer.from(user.password_hash, 'hex'));
  } catch { return false; }
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  init,
  verifyPassword,

  // Users
  async createUser(username, password) {
    const { hash, salt } = hashPassword(password);
    await pool.query(
      'INSERT INTO users (username, password_hash, password_salt, created_at) VALUES ($1, $2, $3, $4)',
      [username, hash, salt, Date.now()]
    );
  },
  async findUserByUsername(username) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    return norm(rows[0]);
  },
  async findUserById(id) {
    const { rows } = await pool.query(
      'SELECT id, username, created_at FROM users WHERE id = $1',
      [id]
    );
    return norm(rows[0]);
  },

  // Tokens
  async createToken(id, userId) {
    await pool.query(
      'INSERT INTO tokens (id, user_id, created_at) VALUES ($1, $2, $3)',
      [id, userId, Date.now()]
    );
  },
  async getToken(id) {
    const { rows } = await pool.query('SELECT * FROM tokens WHERE id = $1', [id]);
    return norm(rows[0]);
  },
  async getUserTokens(userId) {
    const { rows } = await pool.query(
      'SELECT * FROM tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return rows.map(norm);
  },
  async updateForward(id, userId, forwardUrl) {
    await pool.query(
      'UPDATE tokens SET forward_url = $1 WHERE id = $2 AND user_id = $3',
      [forwardUrl, id, userId]
    );
  },
  async deleteToken(id, userId) {
    await pool.query('DELETE FROM tokens WHERE id = $1 AND user_id = $2', [id, userId]);
  },

  // Requests
  async saveRequest(data) {
    const { rows } = await pool.query(
      `INSERT INTO requests (token_id, received_at, method, path, query, headers, body, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [data.tokenId, data.receivedAt, data.method, data.path,
       data.query, data.headers, data.body, data.ip]
    );
    return Number(rows[0].id);
  },
  async getRequests(tokenId) {
    const { rows } = await pool.query(
      'SELECT * FROM requests WHERE token_id = $1 ORDER BY received_at DESC LIMIT 200',
      [tokenId]
    );
    return rows.map(norm);
  },
  async clearRequests(tokenId) {
    await pool.query('DELETE FROM requests WHERE token_id = $1', [tokenId]);
  },
  async getRequestCount(tokenId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS count FROM requests WHERE token_id = $1',
      [tokenId]
    );
    return parseInt(rows[0].count, 10);
  },
};
