-- Idempotent: safe to run any number of times.
INSERT INTO greetings (message)
SELECT 'Hello from the seed data'
WHERE NOT EXISTS (SELECT 1 FROM greetings);
