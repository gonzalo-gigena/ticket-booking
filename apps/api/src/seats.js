const CODE = { available: 0, held: 1, sold: 2 };
const TTL_MS = 1500;

// Compact rows: [seat_id, section, row, number, price_cents, status 0|1|2]. 5,000 seats ≈ 117 KB, ~25 KB gzipped.
// An expired hold counts as available, same rule the Phase 2 hold query uses (so a NULL held_until is not expired).
export const packSeats = (rows, now = Date.now()) => rows.map((s) => [
  s.seat_id, s.section, s.row, s.number, s.price_cents,
  s.status === 'held' && s.held_until !== null && s.held_until < now ? 0 : CODE[s.status],
]);

const inflight = new Map(); // key -> Promise, so one replica sends one query per miss, not one per request

// Returns the JSON string as cached, so a hit never parses or re-serializes 5,000 seats.
// ponytail: plain TTL, every replica can miss at once when it expires (N replicas = N queries per 1.5 s). Fine until Phase 5 pushes updates.
async function cachedJson(redis, key, load) {
  const hit = await redis.get(key);
  if (hit) return hit;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const json = JSON.stringify(await load());
      await redis.set(key, json, { PX: TTL_MS });
      return json;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

export const eventsJson = (pool, redis) => cachedJson(redis, 'events', async () => {
  const { rows } = await pool.query('SELECT id, name, starts_at FROM events ORDER BY starts_at');
  return rows;
});

export const seatMapJson = (pool, redis, eventId) => cachedJson(redis, `seatmap:${eventId}`, async () => {
  const { rows } = await pool.query(
    `SELECT seat_id, section, row, number, price_cents, status, held_until
     FROM seats WHERE event_id = $1 ORDER BY seat_id`, [eventId]);
  return { event_id: eventId, seats: packSeats(rows) };
});
