PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  user_id     TEXT NOT NULL,
  asked_at    INTEGER NOT NULL,
  answered_at INTEGER,
  tz          TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  local_dow   INTEGER NOT NULL,
  user_text   TEXT NOT NULL,
  answer_text TEXT,
  route       TEXT,
  topic       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  extraction  TEXT NOT NULL DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS turns_by_day ON turns(user_id, local_date);
CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, asked_at);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(topic, user_text, answer_text, tokenize = 'porter unicode61');

CREATE TABLE IF NOT EXISTS entities (
  id              INTEGER PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  aliases         TEXT NOT NULL DEFAULT '[]',
  official_domain TEXT,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS turn_entities (
  turn_id   INTEGER NOT NULL REFERENCES turns(id),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  PRIMARY KEY (turn_id, entity_id)
);

CREATE TABLE IF NOT EXISTS sets (
  id           INTEGER PRIMARY KEY,
  user_id      TEXT NOT NULL,
  label        TEXT NOT NULL,
  created_turn INTEGER NOT NULL REFERENCES turns(id)
);
CREATE TABLE IF NOT EXISTS set_members (
  set_id       INTEGER NOT NULL REFERENCES sets(id),
  entity_id    INTEGER NOT NULL REFERENCES entities(id),
  added_turn   INTEGER NOT NULL REFERENCES turns(id),
  removed_turn INTEGER REFERENCES turns(id),
  PRIMARY KEY (set_id, entity_id, added_turn)
);

CREATE TABLE IF NOT EXISTS claims (
  id              INTEGER PRIMARY KEY,
  turn_id         INTEGER NOT NULL REFERENCES turns(id),
  user_id         TEXT NOT NULL,
  entity_id       INTEGER REFERENCES entities(id),
  aspect          TEXT NOT NULL,
  statement       TEXT NOT NULL,
  value           TEXT,
  volatility      TEXT NOT NULL,
  asserted_at     INTEGER NOT NULL,
  supersedes      INTEGER REFERENCES claims(id),
  status          TEXT NOT NULL DEFAULT 'active',
  last_checked_at INTEGER,
  last_verdict    TEXT
);
CREATE INDEX IF NOT EXISTS claims_by_turn   ON claims(turn_id);
CREATE INDEX IF NOT EXISTS claims_by_entity ON claims(entity_id, aspect, asserted_at);

CREATE TABLE IF NOT EXISTS evidence (
  id           INTEGER PRIMARY KEY,
  turn_id      INTEGER NOT NULL REFERENCES turns(id),
  url          TEXT NOT NULL,
  title        TEXT,
  chunk        TEXT NOT NULL,
  chunk_hash   TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  published_at INTEGER,
  via          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id    INTEGER NOT NULL REFERENCES claims(id),
  evidence_id INTEGER NOT NULL REFERENCES evidence(id),
  quote       TEXT NOT NULL,
  stance      TEXT NOT NULL,
  PRIMARY KEY (claim_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl_s      INTEGER NOT NULL
);
