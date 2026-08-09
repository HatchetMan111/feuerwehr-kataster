CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','gruppenfuehrer')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  wehrname TEXT NOT NULL DEFAULT 'Musterwehr',
  overdue_months INTEGER NOT NULL DEFAULT 12,
  CHECK (id = 1)
);

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT NOT NULL
);

INSERT INTO categories (key, label, color, icon) VALUES
  ('loeschteich', 'Löschteich', 'teal', 'droplet'),
  ('zisterne', 'Zisterne', 'teal', 'droplet'),
  ('hydrant', 'Hydrant', 'teal', 'droplet'),
  ('offenes_gewaesser', 'Offenes Gewässer', 'teal', 'droplet'),
  ('guelle_grube', 'Güllegrube', 'coral', 'alert'),
  ('gefahrenpunkt', 'Gefahrenpunkt', 'coral', 'alert'),
  ('sammelplatz', 'Sammelplatz', 'gray', 'dot'),
  ('sonstiges', 'Sonstiges', 'gray', 'dot');

CREATE TABLE points (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  capacity_liters INTEGER,
  accessibility TEXT,
  condition_note TEXT,
  owner_name TEXT,
  owner_phone TEXT,
  key_deposit_note TEXT,
  last_checked DATE,
  photo_url TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE point_history (
  id SERIAL PRIMARY KEY,
  point_id INTEGER,
  changed_by INTEGER REFERENCES users(id),
  change_type TEXT NOT NULL,
  old_data JSONB,
  new_data JSONB,
  changed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX points_geom_idx ON points USING GIST (geom);
