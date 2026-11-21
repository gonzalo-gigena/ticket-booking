CREATE TABLE greetings (
  id serial PRIMARY KEY,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
