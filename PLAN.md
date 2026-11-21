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

## Beyond the plan

Build these after the phases above. Each starts from a problem real systems hit, and
each should add a row to the README's Decisions & tradeoffs table. If one wouldn't,
skip it. B1 is the one to build first.

### B1 — Gate scanning with bad connectivity
**Why:** stadium Wi-Fi fails when 40,000 people arrive at once, and the gates can't stop.
1. A scanner app (a PWA is enough) checks the QR's signature offline with the public key,
   and keeps a local log of scans with a per-scanner sequence number.
2. Scanners sync whenever they can. The server merges the logs and detects a ticket
   scanned at two gates (a shared screenshot). Scanner clocks drift, so don't pretend
   timestamps order the scans: flag both for staff review.
3. Scanners pull a revocation list (refunded or transferred tickets) whenever they're
   online, and reject those tickets while offline.
4. A gate dashboard: scans per minute, scanners offline, duplicates flagged.
- **Done when:** a test runs 4 simulated scanners partitioned for 10 minutes. The same
  ticket scanned at 2 gates is flagged on reconnect, and a ticket refunded before the
  partition is rejected by every scanner that had synced the list.

### B2 — Best available, seats together
**Why:** most buyers don't click seats. They ask for "4 together, best under $X", and
two of them often want the same row.
1. `POST /holds/best {event_id, quantity, max_price}`: find contiguous runs of free seats
   in one row, best first, from the seat cache.
2. Skip blocks that would leave a single seat stranded between two sold ones, since
   nobody buys it alone.
3. Lock a candidate block with `FOR UPDATE SKIP LOCKED`. If fewer rows come back than
   requested, release them and try the next block instead of waiting.
- **Done when:** a group variant of `hold_race` (1,000 clients asking for 2–6 seats)
  never splits a group, and the README reports the stranded-seat rate.

### B3 — Event cancelled: refund everyone
**Why:** the artist cancels. 50,000 orders must be refunded through a provider that
allows N refunds per second, and the job will crash halfway at least once.
1. "Cancel event" in admin creates one refund job per order, with the refund's
   idempotency key = order ID.
2. Throttle to the provider's rate limit and retry 429/5xx with backoff. Refunds that
   fail for good land in a list in the admin panel.
3. Progress in admin (refunded / pending / failed). The cancellation email goes out
   once per order, after its refund succeeds.
4. Extend `payments-mock` (in common) with a refund rate limit and random failures.
- **Done when:** killing the worker mid-run and restarting it ends with every order
  refunded exactly once, checked against the mock's ledger, and one email per buyer.

### B4 — Lottery instead of first come, first served
**Why:** a first-come waiting room rewards bots and fast connections. For the biggest
on-sales, the fair version is a draw.
1. Registration window: one entry per verified account, with the requested quantity.
2. Draw: shuffle the entries with a seed. Publish the seed's hash before the draw and
   the seed after, so anyone can rerun the draw and check the result.
3. Winners get an invitation good for a purchase window (e.g. 24 h). Seats left unsold
   go to the next wave.
4. Each event picks its mode: waiting room or lottery.
- **Done when:** the draw is reproducible from the published seed, and seats unsold in
  wave 1 are offered in wave 2.

### B5 — Ticket transfer and capped resale
**Why:** buyers who can't go resell elsewhere at 5× the price, and fake screenshots circulate.
1. Transfer to another account bumps `tickets.version` and re-signs the QR with it, so the
   old QR stops working. The old version goes on the scanners' revocation list (B1).
2. Resale on the platform, capped at face value plus a fee. The ticket moves and the
   seller's payout is recorded in the same transaction as the buyer's payment.
- **Done when:** after a transfer, the old QR is rejected at the gate, offline scanners
  included, and no resale can exceed the cap.
