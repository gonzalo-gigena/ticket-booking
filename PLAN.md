# 03 — Ticket booking under heavy load

> `payments-mock`, `mailpit` come from the shared `common` submodule, already wired into `compose.yaml`.

Thousands of buyers compete for a fixed number of seats. No seat is ever sold
twice, holds expire, payments are confirmed by webhook, and a waiting room absorbs
spikes. Follows the shared baseline
(`common/docs/baseline.md`).

**What it proves:** race conditions, transactions, idempotency, payments, load testing.

## Stack

| Service | Tech | Scales? |
|---|---|---|
| `web` | Next.js: event page, seat map, checkout | yes |
| `api` | Node 22 + Fastify (or Go): holds, orders, webhooks | yes, stateless |
| `worker` | same codebase: hold expiry, webhook processing, refunds, emails | yes |
| `postgres` | Postgres 17 is the source of truth for inventory | single primary |
| `pgbouncer` | transaction pooling | — |
| `redis` | waiting room queue, rate limiting, seat-map cache, pub/sub | single |
| `payments-mock` | a fake payment provider with the same flow as the real one (checkout URL + signed webhook) | — |
| `mailpit` | catches outgoing email locally | — |
| `caddy` | entry point | — |

Real provider (Mercado Pago or Stripe in **test mode**) is selected by env var. The
mock is the default so the project runs with no accounts and no public URL.

## Steps

### Phase 0 — Scaffold
1. Baseline + `payments-mock` service (tiny HTTP app: create checkout → page
   with Pay/Decline buttons → sends an HMAC-signed webhook to `api`).
- **Done when:** `docker compose up` and the mock checkout page loads.

### Phase 1 — Accounts, catalog and seat map
1. Accounts: email + password (argon2id), HTTP-only session cookies with sessions
   in Redis, and a `buyer | admin` role. Holds, queue entries and orders all belong
   to a user. The per-user limits and admin checks below depend on this.
2. Tables `venues`, `events`, `seats(event_id, seat_id, section, row, price_cents,
   status available|held|sold, hold_id, held_until)`.
3. Seed one event with 5,000 seats. Seat map rendered as SVG.
4. Seat availability served from a Redis cache (1–2 s TTL). Browsing must not hammer Postgres.
- **Done when:** the seat map loads in under 200 ms with 5,000 seats.

### Phase 2 — Holds without double booking
1. `POST /holds {event_id, seat_ids}` in one transaction:
   ```sql
   -- lock rows in a fixed order, so overlapping requests can't deadlock
   SELECT seat_id FROM seats
   WHERE event_id=$2 AND seat_id = ANY($3)
     AND (status='available' OR (status='held' AND held_until < now()))
   ORDER BY seat_id
   FOR UPDATE;
   -- fewer rows than requested? rollback, return 409 with the taken seats
   UPDATE seats SET status='held', hold_id=$1, held_until=now()+interval '10 min'
   WHERE event_id=$2 AND seat_id = ANY($3);
   ```
2. Last line of defense: a partial unique index
   `CREATE UNIQUE INDEX ON order_items (event_id, seat_id) WHERE status = 'paid'`.
   Even a bug in app code cannot sell a seat twice, and a refunded seat can be sold again.
3. Max seats per hold/user, and one active hold per user per event.
4. General admission variant (no seats): `UPDATE inventory SET remaining = remaining - $n
   WHERE event_id=$1 AND remaining >= $n`.
5. Expiry: expired holds are already treated as available by the query above (lazy).
   A worker sweeps them every 30 s to clean up rows and push seat-map updates.
- **Done when:** the headline concurrency test passes.

### Phase 3 — Payments
1. `POST /holds/:id/checkout` creates an `order` (pending) and a provider checkout,
   with **idempotency key = hold_id**. Double-clicking can't create two payments.
2. Webhook endpoint: verify the signature, store raw event in `webhook_events`
   with `UNIQUE (provider, provider_event_id)`, return 200 fast, process in `worker`.
3. Processing a `payment.succeeded`, in one transaction: hold still valid → seats `sold`,
   order `paid`. **Hold already expired:** if the seats are still free, take them; if not,
   issue an automatic refund and email the buyer. Write tests for this case.
4. Also poll the provider for pending orders older than N minutes, since webhooks get lost.
5. Order confirmation email with a QR code (signed ticket ID) to Mailpit.
- **Done when:** replaying the same webhook 10 times produces one order and one
  email; a payment after expiry ends in either a sale or a refund, never a double sale.

### Phase 4 — Waiting room
1. When an event goes on sale, users get a queue position (Redis sorted set by arrival time).
2. An admitter lets N users/sec through (configurable). Each gets a short-lived
   signed admission token (JWT, 10 min). The token is tied to the user's ID and good for
   one hold: store its `jti` in Redis and delete it on use.
   Run Redis with AOF enabled (`appendonly yes`) so a restart mid-sale doesn't empty the queue.
3. `POST /holds` requires a valid admission token for that event.
4. The waiting page shows position and ETA via SSE. Reconnecting keeps your place
   (position is tied to a signed cookie, not to the connection).
5. Rate-limit per IP and per user (Redis), plus bot basics: one queue entry per account.
- **Done when:** a k6 spike (as many virtual users as your laptop handles, roughly 2–5k)
  results in a steady, configurable admission rate and no 5xx errors.

### Phase 5 — Live seat updates
1. When seats change state, publish to Redis. Every `api` replica forwards it to its
   connected browsers over SSE.
- **Done when:** two browsers see a seat turn grey within 1 s of the other one holding it.

### Phase 6 — Admin
1. Create events and pricing, view sales in real time, refund an order, and export attendees as CSV.
2. Role check on admin routes, and record every admin action in an audit log table.
- **Done when:** a refund from the admin panel releases the seats and someone else can buy them.

### Phase 7 — Load test and scale
1. k6 scenarios in `infra/loadtest/`: `browse`, `spike_onsale`, `hold_race`.
2. Run `common/scripts/scale.sh` at 1, 2 and 4 api replicas, with PgBouncer. Record RPS, p95, error rate, and the
   number of duplicate sales (it must be 0). Put the tables in the README.
3. Identify the next bottleneck (likely row-lock contention on hot sections) and
   document the next move (shard inventory per section, or reserve seats in Redis
   with a Lua script and confirm in Postgres).

## Headline test
`hold_race`: 1,000 concurrent clients try to hold random seats from a pool of 100.
Assert with SQL: exactly 100 seats held/sold, every seat has at most one
`hold_id`, `order_items` has no duplicates. Run it in CI.

## Scaling notes
- `api` and `worker` are stateless. Postgres row locks are the correctness
  mechanism *and* the bottleneck. That tradeoff is the story of the README.
- Never store card data. The provider's hosted checkout handles it (PCI scope stays tiny).
