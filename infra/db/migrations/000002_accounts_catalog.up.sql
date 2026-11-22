SET lock_timeout = '3s';

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venues (
  id bigserial PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  venue_id bigint NOT NULL REFERENCES venues (id),
  name text NOT NULL,
  starts_at timestamptz NOT NULL
);

CREATE TABLE seats (
  event_id bigint NOT NULL REFERENCES events (id),
  seat_id int NOT NULL,
  section text NOT NULL,
  row int NOT NULL,
  number int NOT NULL,
  price_cents int NOT NULL CHECK (price_cents >= 0),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'sold')),
  hold_id uuid,
  held_until timestamptz,
  PRIMARY KEY (event_id, seat_id)
);
