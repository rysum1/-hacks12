CREATE TABLE IF NOT EXISTS sculptures (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  artist      TEXT NOT NULL CHECK (char_length(artist) BETWEEN 1 AND 40),
  likes       INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
  reports     INTEGER NOT NULL DEFAULT 0 CHECK (reports >= 0),
  hidden      BOOLEAN NOT NULL DEFAULT false,
  owner_hash  CHAR(64) NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
  remix_of    UUID REFERENCES sculptures(id) ON DELETE SET NULL,
  data_key    TEXT NOT NULL,
  thumb_key   TEXT NOT NULL,
  thumb_type  TEXT NOT NULL CHECK (thumb_type IN ('image/webp', 'image/png'))
);

CREATE INDEX IF NOT EXISTS sculptures_newest
  ON sculptures (created_at DESC) WHERE NOT hidden;
CREATE INDEX IF NOT EXISTS sculptures_liked
  ON sculptures (likes DESC, created_at DESC) WHERE NOT hidden;

CREATE TABLE IF NOT EXISTS sculpture_likes (
  sculpture_id UUID NOT NULL REFERENCES sculptures(id) ON DELETE CASCADE,
  owner_hash   CHAR(64) NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sculpture_id, owner_hash)
);

CREATE TABLE IF NOT EXISTS sculpture_reports (
  sculpture_id UUID NOT NULL REFERENCES sculptures(id) ON DELETE CASCADE,
  owner_hash   CHAR(64) NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sculpture_id, owner_hash)
);