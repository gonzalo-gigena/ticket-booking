-- Idempotent: safe to run any number of times.
INSERT INTO greetings (message)
SELECT 'Hello from the seed data'
WHERE NOT EXISTS (SELECT 1 FROM greetings);

-- One venue, one event, 5,000 seats: 4 sections x 25 rows x 50 seats.
INSERT INTO venues (id, name) VALUES (1, 'Arena') ON CONFLICT DO NOTHING;
INSERT INTO events (id, venue_id, name, starts_at)
VALUES (1, 1, 'Opening night', now() + interval '30 days') ON CONFLICT DO NOTHING;
SELECT setval('venues_id_seq', (SELECT max(id) FROM venues));
SELECT setval('events_id_seq', (SELECT max(id) FROM events));

INSERT INTO seats (event_id, seat_id, section, row, number, price_cents)
SELECT 1, s * 1250 + r * 50 + n + 1, chr(65 + s), r + 1, n + 1, 12000 - s * 2000 - r * 100
FROM generate_series(0, 3) s, generate_series(0, 24) r, generate_series(0, 49) n
ON CONFLICT DO NOTHING;
