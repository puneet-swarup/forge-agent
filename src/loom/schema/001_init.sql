-- src/loom/schema/001_init.sql — Loom schema, version 1.
-- Spec: src/loom_specs.md §3.3. Column order and types are normative: the JSON
-- fallback in ../db.js mirrors this file table-for-table, so a change here needs
-- a new migration (002_*.sql), never an edit.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT NOT NULL UNIQUE,
  lang          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  content_sha   TEXT NOT NULL,
  loc           INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL,
  parse_state   TEXT NOT NULL DEFAULT 'ok',
  importers_sig TEXT NOT NULL DEFAULT '',
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_state ON files(parse_state, deleted);
CREATE INDEX idx_files_sha   ON files(content_sha);

CREATE TABLE symbols (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end   INTEGER NOT NULL,
  signature  TEXT NOT NULL DEFAULT '',
  exported   INTEGER NOT NULL DEFAULT 0,
  parent     TEXT NOT NULL DEFAULT '',
  doc        TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.6
);
CREATE INDEX idx_sym_name ON symbols(name);
CREATE INDEX idx_sym_file ON symbols(file_id, line_start);

CREATE TABLE imports (
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  resolved  TEXT,
  kind      TEXT NOT NULL
);
CREATE INDEX idx_imp_file     ON imports(file_id);
CREATE INDEX idx_imp_resolved ON imports(resolved);

CREATE TABLE summaries (
  file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  source      TEXT NOT NULL,
  sha         TEXT NOT NULL,
  base_conf   REAL NOT NULL,
  made_at     INTEGER NOT NULL,
  role_stale  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE access (
  id      INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  session TEXT NOT NULL,
  op      TEXT NOT NULL,
  lines   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_access_file ON access(file_id, ts);

CREATE TABLE notes (
  id       INTEGER PRIMARY KEY,
  scope    TEXT NOT NULL,
  text     TEXT NOT NULL,
  origin   TEXT NOT NULL,
  sha_at   TEXT NOT NULL DEFAULT '',
  made_at  INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_notes_scope ON notes(scope);

CREATE TABLE migrations (
  version  INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  run_at   INTEGER NOT NULL
);
