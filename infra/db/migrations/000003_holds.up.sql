SET lock_timeout = '3s';

-- One row per user per event. An expired row is deleted (and its GA tickets given back)
-- before the user's next hold, so UNIQUE (user_id, event_id) means one active hold.
CREATE TABLE holds (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  event_id bigint NOT NULL REFERENCES events (id),
  quantity int NOT NULL CHECK (quantity > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id)
);

-- General admission: an event with a row here sells a count, not seats.
CREATE TABLE inventory (
  event_id bigint PRIMARY KEY REFERENCES events (id),
  remaining int NOT NULL CHECK (remaining >= 0)
);

-- Phase 3 adds orders and order_items.order_id. The index is the last line of defense:
-- even a bug in app code cannot sell a seat twice, and a refunded seat can be sold again.
CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  hold_id uuid NOT NULL,
  event_id bigint NOT NULL,
  seat_id int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded')),
  FOREIGN KEY (event_id, seat_id) REFERENCES seats (event_id, seat_id)
);
CREATE UNIQUE INDEX order_items_one_paid_per_seat ON order_items (event_id, seat_id) WHERE status = 'paid';
