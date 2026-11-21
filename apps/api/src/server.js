import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { observe, render } from './metrics.js';

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    console.error(JSON.stringify({ level: 'fatal', msg: `missing env var ${name}` }));
    process.exit(1);
  }
  return value;
}

const PORT = Number(env('PORT', '8080'));
const replica = os.hostname();
const pool = new pg.Pool({
  connectionString: env('DATABASE_URL'),
  max: Number(env('DB_POOL_MAX', '10')),
});

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, replica, ...extra }));

let draining = false;

// ponytail: a plain lookup table is the router. Swap in Fastify/Hono when a project needs params or middleware.
const routes = {
  'GET /healthz': async () => [200, { ok: true }],
  'GET /readyz': async () => {
    if (draining) return [503, { ok: false, reason: 'draining' }];
    try {
      await pool.query('SELECT 1');
      return [200, { ok: true }];
    } catch {
      return [503, { ok: false, reason: 'db unreachable' }];
    }
  },
  'GET /api/hello': async () => {
    const { rows } = await pool.query('SELECT message FROM greetings ORDER BY id LIMIT 1');
    return [200, { message: rows[0]?.message ?? null, replica }];
  },
};

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || randomUUID();
  const path = req.url.split('?')[0];
  const key = `${req.method} ${path}`;
  res.setHeader('x-replica', replica);
  res.setHeader('x-request-id', requestId);

  if (key === 'GET /metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end(render());
  }

  let status;
  let body;
  try {
    const handler = routes[key];
    [status, body] = handler ? await handler() : [404, { error: 'not found' }];
  } catch (err) {
    log('error', err.message, { requestId, path });
    [status, body] = [500, { error: 'internal error', requestId }];
  }

  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  observe(routes[key] ? key : 'unmatched', status, seconds); // fixed label set, no cardinality blow-up
  if (!path.endsWith('z')) log('info', 'request', { requestId, method: req.method, path, status, ms: Math.round(seconds * 1000) });
});

function shutdown(signal) {
  if (draining) return;
  draining = true;
  log('info', `${signal} received, draining`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // below compose stop_grace_period
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => log('info', `listening on :${PORT}`));
