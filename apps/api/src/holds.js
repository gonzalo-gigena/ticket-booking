import { randomUUID } from 'node:crypto';

export const MAX_PER_HOLD = 8; // seats or GA tickets; with one active hold per event, also the per-user limit

const id = (n) => Number.isSafeInteger(n) && n > 0;
const seatId = (n) => id(n) && n <= 2 ** 31 - 1; // seats.seat_id is int4

// {event_id, seat_ids} for a seated event, {event_id, quantity} for general admission. null if invalid.
export function parseHold(body) {
  const { event_id: eventId, seat_ids: seatIds, quantity } = body ?? {};
  if (!id(eventId)) return null;
  if (seatIds === undefined) return id(quantity) && quantity <= MAX_PER_HOLD ? { eventId, quantity } : null;
  if (quantity !== undefined || !Array.isArray(seatIds) || seatIds.length === 0 || seatIds.length > MAX_PER_HOLD
    || !seatIds.every(seatId) || new Set(seatIds).size !== seatIds.length) return null;
  return { eventId, seatIds };
}

// Deletes expired holds and gives their GA tickets back. Seats need nothing here: the hold query
// already treats an expired seat as free. Pass a user and event to release only that user's hold.
const RELEASE_EXPIRED = `
  WITH gone AS (
    DELETE FROM holds WHERE expires_at < now() AND ($1::bigint IS NULL OR (user_id = $1 AND event_id = $2))
    RETURNING event_id, quantity
  ), back AS (
    UPDATE inventory i SET remaining = remaining + g.n
    FROM (SELECT event_id, sum(quantity) AS n FROM gone GROUP BY event_id) g
    WHERE i.event_id = g.event_id
  )
  SELECT count(*)::int AS n FROM gone`;

async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query(out[0] === 201 ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export const createHold = (pool, userId, { eventId, seatIds, quantity = seatIds.length }) => tx(pool, async (c) => {
  await c.query(RELEASE_EXPIRED, [userId, eventId]);
  const holdId = randomUUID();
  let ins;
  try {
    // A concurrent hold by the same user waits on the unique key here, then gets DO NOTHING.
    ins = await c.query(
      `INSERT INTO holds (id, user_id, event_id, quantity, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 min')
       ON CONFLICT (user_id, event_id) DO NOTHING RETURNING expires_at`, [holdId, userId, eventId, quantity]);
  } catch (err) {
    if (err.code === '23503') return [404, { error: 'no such event' }];
    throw err;
  }
  if (!ins.rowCount) return [409, { error: 'you already have an active hold for this event' }];
  const [{ expires_at: expiresAt }] = ins.rows;

  if (!seatIds) {
    const { rowCount } = await c.query(
      'UPDATE inventory SET remaining = remaining - $2 WHERE event_id = $1 AND remaining >= $2', [eventId, quantity]);
    if (!rowCount) return [409, { error: 'not enough tickets left' }];
    return [201, { id: holdId, event_id: eventId, quantity, expires_at: expiresAt }];
  }

  // Lock rows in a fixed order, so overlapping requests can't deadlock. A row another hold just took
  // is re-checked after its lock is released, and drops out of the result.
  const { rows } = await c.query(
    `SELECT seat_id FROM seats
     WHERE event_id = $1 AND seat_id = ANY($2)
       AND (status = 'available' OR (status = 'held' AND held_until < now()))
     ORDER BY seat_id
     FOR UPDATE`, [eventId, seatIds]);
  if (rows.length < seatIds.length) {
    const free = new Set(rows.map((r) => r.seat_id));
    return [409, { error: 'seats taken', taken: seatIds.filter((s) => !free.has(s)) }];
  }
  await c.query(
    `UPDATE seats SET status = 'held', hold_id = $1, held_until = $2 WHERE event_id = $3 AND seat_id = ANY($4)`,
    [holdId, expiresAt, eventId, seatIds]);
  return [201, { id: holdId, event_id: eventId, seat_ids: seatIds, expires_at: expiresAt }];
});

// The worker runs this every 30 s. Correctness never depends on it: it only tidies rows and returns GA tickets.
// ponytail: seq scan of seats, fine at 5,000 per event. Add a partial index on held_until WHERE status = 'held' past ~1M rows.
export async function sweep(pool) {
  const { rows: [{ n: holds }] } = await pool.query(RELEASE_EXPIRED, [null, null]);
  const { rowCount: seats } = await pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL WHERE status = 'held' AND held_until < now()`);
  return { holds, seats };
}
