// Holds against a real stack, asserted with SQL. Needs BASE_URL and DATABASE_URL:
//   docker compose -f compose.yaml --profile tools run --rm api-test
// Each test makes its own event, so it can be rerun on the same database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sweep } from './holds.js';

const BASE = process.env.BASE_URL;
const skip = !(BASE && process.env.DATABASE_URL) && 'set BASE_URL and DATABASE_URL to run';
let db;
before(async () => {
  if (skip) return;
  const { default: pg } = await import('pg'); // dynamic: the unit-test run has no node_modules
  db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});
after(() => db?.end());

const tag = `${Date.now()}-${process.pid}`;
let users = 0;
async function user() {
  const res = await fetch(`${BASE}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `hold-${tag}-${users++}@example.com`, password: 'integration-pass' }),
  });
  assert.equal(res.status, 201);
  return /sid=([^;]*)/.exec(res.headers.get('set-cookie'))[1];
}
async function newUsers(n, parallel = 25) {
  const out = [];
  for (let i = 0; i < n; i += parallel) out.push(...await Promise.all(Array.from({ length: Math.min(parallel, n - i) }, user)));
  return out;
}
async function hold(token, body) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `sid=${token}` }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function event({ seats = 0, ga } = {}) {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO events (venue_id, name, starts_at) VALUES (1, $1, now() + interval '1 day') RETURNING id`, [`test ${tag}`]);
  await db.query(`INSERT INTO seats (event_id, seat_id, section, row, number, price_cents)
    SELECT $1, n, 'A', 1, n, 1000 FROM generate_series(1, $2::int) n`, [id, seats]);
  if (ga !== undefined) await db.query('INSERT INTO inventory VALUES ($1, $2)', [id, ga]);
  return Number(id);
}
const expire = (holdId) => Promise.all([
  db.query(`UPDATE holds SET expires_at = now() - interval '1 s' WHERE id = $1`, [holdId]),
  db.query(`UPDATE seats SET held_until = now() - interval '1 s' WHERE hold_id = $1`, [holdId]),
]);

test('hold_race: 1,000 concurrent clients, 100 seats, no seat held twice', { skip, timeout: 300_000 }, async () => {
  const POOL = 100;
  const eventId = await event({ seats: POOL });
  const tokens = await newUsers(1000);

  // Each client wants 1-4 random seats. On 409 it drops the seats it was told are taken and tries again,
  // until it gets a hold or learns every seat is gone. So the pool always sells out.
  let requests = 0;
  const started = Date.now();
  const won = (await Promise.all(tokens.map(async (token) => {
    const unknown = new Set(Array.from({ length: POOL }, (_, i) => i + 1));
    while (unknown.size) {
      const want = [...unknown].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 4));
      requests++;
      const { status, body } = await hold(token, { event_id: eventId, seat_ids: want });
      if (status === 201) return body;
      assert.equal(status, 409, JSON.stringify(body));
      assert.ok(body.taken.length > 0);
      for (const s of body.taken) unknown.delete(s);
    }
    return null;
  }))).filter(Boolean);
  const secs = (Date.now() - started) / 1000;
  console.log(`hold_race: ${requests} hold requests in ${secs.toFixed(1)} s (${Math.round(requests / secs)}/s), ${won.length} holds`);

  // Nobody was told they hold a seat someone else was also told they hold, and together they hold the whole pool.
  const claimed = won.flatMap((h) => h.seat_ids);
  assert.equal(new Set(claimed).size, claimed.length, 'two clients were given the same seat');
  assert.equal(claimed.length, POOL);

  const { rows: [r] } = await db.query(`
    SELECT count(*) FILTER (WHERE status = 'held' AND held_until > now())::int AS held,
           count(DISTINCT hold_id)::int AS holds
    FROM seats WHERE event_id = $1`, [eventId]);
  assert.equal(r.held, POOL, 'exactly 100 seats held');
  assert.equal(r.holds, won.length);
  const { rows: mismatched } = await db.query(
    `SELECT s.seat_id FROM seats s JOIN unnest($2::uuid[], $3::int[]) AS c(hold_id, seat_id) USING (seat_id)
     WHERE s.event_id = $1 AND s.hold_id IS DISTINCT FROM c.hold_id`,
    [eventId, won.flatMap((h) => h.seat_ids.map(() => h.id)), claimed]);
  assert.deepEqual(mismatched, [], 'every seat belongs to the hold that was told it got it');
  const { rows: [h] } = await db.query(
    'SELECT count(*)::int AS n, sum(quantity)::int AS q, count(DISTINCT user_id)::int AS u FROM holds WHERE event_id = $1', [eventId]);
  assert.deepEqual(h, { n: won.length, q: POOL, u: won.length });
  const { rows: dupes } = await db.query(
    `SELECT event_id, seat_id FROM order_items WHERE status = 'paid' GROUP BY 1, 2 HAVING count(*) > 1`);
  assert.deepEqual(dupes, []);
});

test('holds: auth, limits, one active hold per user, lazy expiry and the sweep', { skip }, async () => {
  const eventId = await event({ seats: 20 });
  const [a, b] = await newUsers(2);

  assert.equal((await fetch(`${BASE}/api/holds`, { method: 'POST' })).status, 401);
  assert.equal((await hold(a, { event_id: eventId, seat_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).status, 400);
  assert.equal((await hold(a, { event_id: 999_999_999, seat_ids: [1] })).status, 404);

  const first = await hold(a, { event_id: eventId, seat_ids: [2, 1] });
  assert.equal(first.status, 201);
  assert.deepEqual((await hold(a, { event_id: eventId, seat_ids: [5] })).body,
    { error: 'you already have an active hold for this event' });
  assert.deepEqual((await hold(b, { event_id: eventId, seat_ids: [2, 3] })).body, { error: 'seats taken', taken: [2] });

  // Expired, before any sweep: the seats are free again, and A may hold again.
  await expire(first.body.id);
  assert.equal((await hold(b, { event_id: eventId, seat_ids: [1, 2] })).status, 201);
  const again = await hold(a, { event_id: eventId, seat_ids: [3] });
  assert.equal(again.status, 201);

  await expire(again.body.id);
  await sweep(db);
  const { rows } = await db.query(
    `SELECT seat_id, status, hold_id IS NULL AS cleared FROM seats WHERE event_id = $1 AND seat_id <= 3 ORDER BY seat_id`, [eventId]);
  assert.deepEqual(rows.map((s) => [s.seat_id, s.status, s.cleared]), [[1, 'held', false], [2, 'held', false], [3, 'available', true]]);
  assert.equal((await db.query('SELECT 1 FROM holds WHERE id = $1', [again.body.id])).rowCount, 0);
});

test('general admission: a counter that never goes below zero, refilled by expiry', { skip }, async () => {
  const eventId = await event({ ga: 5 });
  const [a, b, c] = await newUsers(3);
  const remaining = async () => (await db.query('SELECT remaining FROM inventory WHERE event_id = $1', [eventId])).rows[0].remaining;

  const ha = await hold(a, { event_id: eventId, quantity: 3 });
  assert.equal(ha.status, 201);
  assert.deepEqual((await hold(b, { event_id: eventId, quantity: 3 })).body, { error: 'not enough tickets left' });
  assert.equal((await hold(b, { event_id: eventId, quantity: 2 })).status, 201);
  assert.equal(await remaining(), 0);

  await expire(ha.body.id);
  await sweep(db);
  assert.equal(await remaining(), 3);
  assert.equal((await hold(c, { event_id: eventId, quantity: 3 })).status, 201);
  assert.equal(await remaining(), 0);
});

test('order_items: at most one paid row per seat, a refunded seat can be sold again', { skip }, async () => {
  const eventId = await event({ seats: 1 });
  const item = (status) => db.query(
    'INSERT INTO order_items (hold_id, event_id, seat_id, status) VALUES (gen_random_uuid(), $1, 1, $2)', [eventId, status]);
  await item('refunded');
  await item('paid');
  await assert.rejects(item('paid'), { code: '23505' });
});
