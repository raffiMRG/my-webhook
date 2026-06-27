const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const { randomBytes } = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Session secret ─────────────────────────────────────────────────────────────
// Prioritize env var (Docker); fall back to file for local dev without env var.

function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(__dirname, 'data', '.session-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); }
  catch {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    const s = randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

// ── Async route wrapper (Express 4 doesn't auto-catch async errors) ───────────

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── SSE ────────────────────────────────────────────────────────────────────────

const sseClients = new Map();

function pushSSE(tokenId, data) {
  const clients = sseClients.get(tokenId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseBody(req) {
  if (!req.body || req.body.length === 0) return null;
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
}

function terminalLog(method, tokenId, ip, body) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const c = { reset: '\x1b[0m', cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m' };
  console.log(`${c.cyan}[${ts}]${c.reset} ${c.yellow}${method}${c.reset} /hook/${tokenId} ${c.dim}from ${ip}${c.reset}`);
  if (body) {
    const snippet = body.length > 300 ? body.slice(0, 300) + '…' : body;
    console.log(`  ${c.dim}${snippet}${c.reset}`);
  }
}

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAuthPage(req, res, next) {
  if (req.session?.userId) return next();
  res.redirect('/login');
}

// ── Core middleware ────────────────────────────────────────────────────────────

app.set('trust proxy', true);
app.use(session({
  secret: getSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/hook', express.raw({ type: '*/*', limit: '10mb' }));

// ── Auth routes (public) ───────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/login', express.urlencoded({ extended: false }), ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.redirect('/login?error=missing');

  const user = await db.findUserByUsername(username);
  if (!user || !db.verifyPassword(password, user)) return res.redirect('/login?error=invalid');

  req.session.regenerate(err => {
    if (err) return res.redirect('/login?error=server');
    req.session.userId   = user.id;
    req.session.username = user.username;
    res.redirect('/');
  });
}));

app.post('/register', express.urlencoded({ extended: false }), ah(async (req, res) => {
  const { username = '', password = '', confirm = '' } = req.body || {};
  if (!username || !password)                       return res.redirect('/register?error=missing');
  if (username.length < 3 || username.length > 30)  return res.redirect('/register?error=username_length');
  if (!/^[a-zA-Z0-9_]+$/.test(username))           return res.redirect('/register?error=username_chars');
  if (password.length < 8)                          return res.redirect('/register?error=password_short');
  if (password !== confirm)                         return res.redirect('/register?error=password_mismatch');

  try {
    await db.createUser(username, password);
  } catch (e) {
    if (e.code === '23505') return res.redirect('/register?error=username_taken');
    throw e;
  }

  const user = await db.findUserByUsername(username);
  req.session.regenerate(err => {
    if (err) return res.redirect('/login');
    req.session.userId   = user.id;
    req.session.username = user.username;
    res.redirect('/');
  });
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Webhook receiver (public — no auth) ───────────────────────────────────────

const handleWebhook = ah(async (req, res) => {
  const tokenId = req.params.id;
  const token   = await db.getToken(tokenId);
  if (!token) return res.status(404).json({ error: 'Token not found' });

  const receivedAt = Date.now();
  const method     = req.method;
  const urlPath    = req.path;
  const query      = req.query;
  const headers    = req.headers;
  const body       = parseBody(req);
  const ip         = req.ip;

  const requestId = await db.saveRequest({ tokenId, receivedAt, method, path: urlPath, query, headers, body, ip });

  terminalLog(method, tokenId, ip, body);

  pushSSE(tokenId, {
    type: 'request', id: requestId, token_id: tokenId,
    received_at: receivedAt, method, path: urlPath, query, headers, body, ip,
  });

  if (token.forward_url) {
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['host'];
    fetch(token.forward_url, { method, headers: fwdHeaders, body: body || undefined })
      .then(r => console.log(`  \x1b[2mForwarded → ${token.forward_url} [${r.status}]\x1b[0m`))
      .catch(e => console.error(`  \x1b[31mForward failed: ${e.message}\x1b[0m`));
  }

  res.status(200).json({ status: 'received', id: requestId });
});

app.all('/hook/:id',   handleWebhook);
app.all('/hook/:id/*', handleWebhook);

// ── Protected dashboard ────────────────────────────────────────────────────────

app.get('/', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Protected API ──────────────────────────────────────────────────────────────

app.use('/api', requireAuth, express.json());

app.get('/api/me', ah(async (req, res) => {
  const user = await db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(user);
}));

app.post('/api/tokens', ah(async (req, res) => {
  const id = uuidv4();
  await db.createToken(id, req.session.userId);
  console.log(`\x1b[32m[+] Token: ${id} (${req.session.username})\x1b[0m`);
  res.json({ id, url: `${getBaseUrl(req)}/hook/${id}` });
}));

app.get('/api/tokens', ah(async (req, res) => {
  res.json(await db.getUserTokens(req.session.userId));
}));

app.get('/api/tokens/:id', ah(async (req, res) => {
  const token = await db.getToken(req.params.id);
  if (!token || token.user_id !== req.session.userId) return res.status(404).json({ error: 'Token not found' });
  res.json({ ...token, request_count: await db.getRequestCount(req.params.id) });
}));

app.patch('/api/tokens/:id', ah(async (req, res) => {
  const token = await db.getToken(req.params.id);
  if (!token || token.user_id !== req.session.userId) return res.status(404).json({ error: 'Token not found' });
  const forwardUrl = req.body.forward_url ?? null;
  await db.updateForward(req.params.id, req.session.userId, forwardUrl);
  res.json({ id: req.params.id, forward_url: forwardUrl });
}));

app.delete('/api/tokens/:id', ah(async (req, res) => {
  const token = await db.getToken(req.params.id);
  if (!token || token.user_id !== req.session.userId) return res.status(404).json({ error: 'Token not found' });
  const clients = sseClients.get(req.params.id);
  if (clients) { for (const c of clients) c.end(); sseClients.delete(req.params.id); }
  await db.deleteToken(req.params.id, req.session.userId);
  res.json({ success: true });
}));

app.get('/api/tokens/:id/requests', ah(async (req, res) => {
  const token = await db.getToken(req.params.id);
  if (!token || token.user_id !== req.session.userId) return res.status(404).json({ error: 'Token not found' });
  res.json(await db.getRequests(req.params.id));
}));

app.delete('/api/tokens/:id/requests', ah(async (req, res) => {
  const token = await db.getToken(req.params.id);
  if (!token || token.user_id !== req.session.userId) return res.status(404).json({ error: 'Token not found' });
  await db.clearRequests(req.params.id);
  pushSSE(req.params.id, { type: 'cleared' });
  res.json({ success: true });
}));

app.get('/api/tokens/:id/stream', ah(async (req, res) => {
  const token = await db.getToken(req.params.id);
  if (!token || token.user_id !== req.session.userId) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sseClients.has(req.params.id)) sseClients.set(req.params.id, new Set());
  sseClients.get(req.params.id).add(res);
  res.write('data: {"type":"connected"}\n\n');

  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(hb);
    const s = sseClients.get(req.params.id);
    if (s) { s.delete(res); if (s.size === 0) sseClients.delete(req.params.id); }
  });
}));

// ── Global error handler ───────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('\x1b[31mUnhandled error:\x1b[0m', err.message);
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
  res.status(500).send('Internal Server Error');
});

// ── Start (wait for DB before accepting connections) ───────────────────────────

db.init()
  .then(() => {
    console.log('\x1b[32m✓ PostgreSQL connected\x1b[0m');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\x1b[32m✓ Webhook receiver running on http://0.0.0.0:${PORT}\x1b[0m`);
      console.log(`  Dashboard : http://localhost:${PORT}`);
      console.log(`  Network   : http://192.168.0.123:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('\x1b[31m✗ Database connection failed:\x1b[0m', err.message);
    process.exit(1);
  });
