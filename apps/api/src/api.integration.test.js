// Runs against a real stack (Caddy → api → Postgres + Redis) with the seed loaded:
//   docker compose -f compose.yaml --profile tools run --rm api-test
// Skipped by a plain `node --test`, which only runs the unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL;
const JSON_HEADERS = { 'content-type': 'application/json' };

const sid = (res) => /(?:^|,\s*)sid=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
const me = (token) => fetch(`${BASE}/api/me`, { headers: token ? { cookie: `sid=${token}` } : {} });
const post = (path, body, token) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { ...JSON_HEADERS, ...(token && { cookie: `sid=${token}` }) },
  body: body && JSON.stringify(body),
});

test('register, login, me, logout', { skip: !BASE && 'set BASE_URL to run' }, async () => {
  const creds = { email: `it-${Date.now()}-${process.pid}@example.com`, password: 'integration-pass' };

  const reg = await post('/api/register', creds);
  assert.equal(reg.status, 201);
  assert.match(reg.headers.get('set-cookie'), /HttpOnly/);
  assert.match(reg.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await reg.json()).role, 'buyer');
  assert.equal((await post('/api/register', { ...creds, email: creds.email.toUpperCase() })).status, 409);

  assert.equal((await post('/api/login', { ...creds, password: 'wrong-password' })).status, 401);
  const login = await post('/api/login', creds);
  assert.equal(login.status, 200);
  const token = sid(login);
  assert.ok(token);

  // Caddy round-robins each request, so with the api scaled these hit every replica: the session is in Redis.
  const replicas = new Set();
  for (let i = 0; i < 9; i++) {
    const res = await me(token);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, 'buyer');
    replicas.add(res.headers.get('x-replica'));
  }
  assert.ok(replicas.size >= Number(process.env.MIN_REPLICAS ?? 1), `session served by ${replicas.size} replica(s)`);
  assert.equal((await me()).status, 401);
  assert.equal((await me('not-a-real-session')).status, 401);

  const out = await post('/api/logout', null, token);
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await me(token)).status, 401, 'a logged-out cookie must not work, even if replayed');
  assert.equal((await me(sid(reg))).status, 200, 'logout ends only that session');
});

test('seat map for the seeded event', { skip: !BASE && 'set BASE_URL to run' }, async () => {
  const events = await (await fetch(`${BASE}/api/events`)).json();
  assert.ok(events.some((e) => Number(e.id) === 1), 'run the seed first');

  for (let i = 0; i < 2; i++) { // the second request is normally a cache hit
    const res = await fetch(`${BASE}/api/seats?event=1`);
    assert.equal(res.status, 200);
    const { event_id: eventId, seats } = await res.json();
    assert.equal(eventId, 1);
    assert.equal(seats.length, 5000);
    assert.equal(new Set(seats.map((s) => s[0])).size, 5000);
    for (const [, section, row, number, price, status] of seats) {
      assert.ok(/^[A-Z]$/.test(section) && row > 0 && number > 0 && price >= 0 && [0, 1, 2].includes(status));
    }
  }
  assert.equal((await fetch(`${BASE}/api/seats?event=abc`)).status, 400);
});
