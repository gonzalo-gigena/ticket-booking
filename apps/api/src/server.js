import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from 'redis';
import { observe, render } from './metrics.js';
import { hashPassword, verifyPassword, DUMMY_HASH, newSessionToken, sessionKey, parseCookies, validCredentials } from './auth.js';
import { eventsJson, seatMapJson } from './seats.js';
import { parseHold, createHold, MAX_PER_HOLD } from './holds.js';

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    console.error(JSON.stringify({ level: 'fatal', msg: `missing env var ${name}` }));
    process.exit(1);
  }
  return value;
}

const PORT = Number(env('PORT', '8080'));
const COOKIE_SECURE = env('COOKIE_SECURE', 'false') === 'true';
const SESSION_TTL_S = 7 * 24 * 3600;
const replica = os.hostname();

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, replica, ...extra }));

const pool = new pg.Pool({
  connectionString: env('DATABASE_URL'),
  max: Number(env('DB_POOL_MAX', '10')),
});
// Without a listener, an idle client dropped by Postgres (restart, failover) crashes the process.
// The pool discards that client and the next query opens a fresh one.
pool.on('error', (err) => log('warn', 'idle postgres client error', { err: err.message }));

// No offline queue: while Redis is down, fail at once (500, /readyz 503) instead of hanging requests.
const redis = createClient({ url: env('REDIS_URL'), disableOfflineQueue: true });
redis.on('error', (err) => log('warn', 'redis error', { err: err.message })); // the client reconnects on its own
await redis.connect();

async function readJson(req) {
  // JSON only: a cross-site <form> can post text/plain without a preflight and log the victim into another account.
  if (!req.headers['content-type']?.startsWith('application/json')) return null;
  req.setEncoding('utf8');
  let raw = '';
  // destroyOnReturn: false, so an oversized body still gets its error response instead of a reset socket.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    raw += chunk;
    if (raw.length > 10_000) return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

const cookie = (token, maxAge) =>
  `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;

async function startSession(user) {
  const token = newSessionToken();
  await redis.set(sessionKey(token), JSON.stringify({ id: user.id, role: user.role }), { EX: SESSION_TTL_S });
  return [200, { id: user.id, email: user.email, role: user.role }, { 'set-cookie': cookie(token, SESSION_TTL_S) }];
}

async function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const s = await redis.get(sessionKey(token));
  return s && JSON.parse(s);
}

let draining = false;

// ponytail: a plain lookup table is the router. Swap in Fastify/Hono when a project needs params or middleware.
const routes = {
  'GET /healthz': async () => [200, { ok: true }],
  'GET /readyz': async () => {
    if (draining) return [503, { ok: false, reason: 'draining' }];
    try {
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      return [200, { ok: true }];
    } catch {
      return [503, { ok: false, reason: 'db or redis unreachable' }];
    }
  },
  'GET /api/hello': async () => {
    const { rows } = await pool.query('SELECT message FROM greetings ORDER BY id LIMIT 1');
    return [200, { message: rows[0]?.message ?? null, replica }];
  },

  'POST /api/register': async ({ req }) => {
    const body = await readJson(req);
    if (!validCredentials(body)) return [400, { error: 'valid email and a password of 8-256 characters required' }];
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES (lower($1), $2) RETURNING id, email, role',
        [body.email, await hashPassword(body.password)]);
      const [, user, headers] = await startSession(rows[0]);
      return [201, user, headers];
    } catch (err) {
      if (err.code === '23505') return [409, { error: 'email already registered' }];
      throw err;
    }
  },
  'POST /api/login': async ({ req }) => {
    const body = await readJson(req);
    if (!validCredentials(body)) return [401, { error: 'wrong email or password' }];
    const { rows: [user] } = await pool.query(
      'SELECT id, email, role, password_hash FROM users WHERE email = lower($1)', [body.email]);
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    return ok && user ? startSession(user) : [401, { error: 'wrong email or password' }];
  },
  'POST /api/logout': async ({ req }) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) await redis.del(sessionKey(token));
    return [204, null, { 'set-cookie': cookie('', 0) }];
  },
  'GET /api/me': async ({ req }) => {
    const user = await currentUser(req);
    return user ? [200, user] : [401, { error: 'not logged in' }];
  },

  // Browsing is public: no session lookup, and both responses come from Redis.
  'GET /api/events': async () => [200, await eventsJson(pool, redis)],
  'GET /api/seats': async ({ query }) => {
    const eventId = Number(query.get('event'));
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return [400, { error: 'event must be a positive integer' }];
    return [200, await seatMapJson(pool, redis, eventId)];
  },

  'POST /api/holds': async ({ req }) => {
    const user = await currentUser(req);
    if (!user) return [401, { error: 'not logged in' }];
    const hold = parseHold(await readJson(req));
    if (!hold) return [400, { error: `event_id and either 1-${MAX_PER_HOLD} distinct seat_ids or a quantity of 1-${MAX_PER_HOLD} required` }];
    return createHold(pool, user.id, hold);
  },
};

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || randomUUID();
  const [path, qs = ''] = req.url.split('?');
  const key = `${req.method} ${path}`;
  res.setHeader('x-replica', replica);
  res.setHeader('x-request-id', requestId);

  if (key === 'GET /metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end(render());
  }

  let status;
  let body;
  let headers;
  try {
    const handler = routes[key];
    [status, body, headers] = handler ? await handler({ req, query: new URLSearchParams(qs) }) : [404, { error: 'not found' }];
  } catch (err) {
    log('error', err.message, { requestId, path });
    [status, body] = [500, { error: 'internal error', requestId }];
  }

  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body)); // strings are pre-serialized JSON

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  observe(routes[key] ? key : 'unmatched', status, seconds); // fixed label set, no cardinality blow-up
  if (!path.endsWith('z')) log('info', 'request', { requestId, method: req.method, path, status, ms: Math.round(seconds * 1000) });
});

// Outlive Caddy's idle upstream connections (2 min). With Node's 5 s default, Caddy reuses a socket Node just
// closed, gets "server closed idle connection", and its passive health check marks the replica down for 10 s.
server.keepAliveTimeout = 130_000;
server.headersTimeout = 131_000;

function shutdown(signal) {
  if (draining) return;
  draining = true;
  log('info', `${signal} received, draining`);
  server.close(async () => {
    await pool.end();
    redis.destroy(); // nothing is in flight by now, and unlike close() this works while Redis is down
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // below compose stop_grace_period
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => log('info', `listening on :${PORT}`));
