'use strict';
// src/loom/db.js — the storage driver.
//
// Spec: src/loom_specs.md §3.2. Two backends behind one interface:
//
//   * `sqlite` — `node:sqlite`, when the runtime provides it (Node >= 22.5 with
//     the flag, Node >= 23.4 without). WAL, NORMAL sync, 3000 ms busy timeout.
//   * `json`   — the mandatory fallback. `package.json` declares `engines >=20`,
//     where `node:sqlite` does not exist at all, so this is the path most users
//     actually run. The whole store is one JSON file, written atomically
//     (`.tmp` + rename) and debounced by 500 ms.
//
// The interface is *table-oriented*, not SQL-oriented, on purpose: the JSON
// backend cannot parse SQL, and a second dialect would drift from the schema.
// Tables, columns and primary keys are declared once below and both backends
// honour the same declaration.
//
// Invariant I1: nothing here may throw into a tool handler. Read helpers return
// neutral values; write helpers are the caller's problem (they run inside the
// indexer's own try/catch) except `flush()`/`close()`, which never throw.

const fs = require('fs');
const path = require('path');

const log = require('./log');

/** Tables, in dependency order, with the exact columns of schema/001_init.sql. */
const COLUMNS = Object.freeze({
  meta       : ['key', 'value'],
  files      : ['id', 'rel_path', 'lang', 'bytes', 'mtime_ms', 'content_sha', 'loc',
                'indexed_at', 'parse_state', 'importers_sig', 'deleted'],
  symbols    : ['id', 'file_id', 'name', 'kind', 'line_start', 'line_end', 'signature',
                'exported', 'parent', 'doc', 'confidence'],
  imports    : ['file_id', 'specifier', 'resolved', 'kind'],
  summaries  : ['file_id', 'purpose', 'source', 'sha', 'base_conf', 'made_at', 'role_stale'],
  access     : ['id', 'file_id', 'ts', 'session', 'op', 'lines'],
  notes      : ['id', 'scope', 'text', 'origin', 'sha_at', 'made_at', 'verified'],
  migrations : ['version', 'checksum', 'run_at'],
});

const TABLES = Object.freeze(Object.keys(COLUMNS));

/** Primary key per table; anything not listed uses an auto-increment `id`. */
const PRIMARY_KEYS = Object.freeze({ meta: 'key', migrations: 'version', summaries: 'file_id' });

/** Tables whose key is assigned by the store rather than the caller. */
const AUTO_ID_TABLES = Object.freeze(['files', 'symbols', 'access', 'notes']);

const FLUSH_DEBOUNCE_MS = 500;
const BUSY_RETRY_MS = 50;

function primaryKeyOf(table) {
  return PRIMARY_KEYS[table] || 'id';
}

function columnsOf(table) {
  const cols = COLUMNS[table];
  if (!cols) throw new Error(`[Loom] unknown table: ${table}`);
  return cols;
}

/** Keep only declared columns, and drop `undefined` values. */
function sanitizeRow(table, row) {
  const allowed = columnsOf(table);
  const out = {};
  for (const key of Object.keys(row || {})) {
    if (!allowed.includes(key)) continue;
    if (row[key] === undefined) continue;
    out[key] = row[key];
  }
  return out;
}

function sleepSync(ms) {
  try {
    const shared = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(shared), 0, 0, ms);
  } catch (_) {
    // No shared memory: skip the pause, the retry still happens.
  }
}

function isBusy(err) {
  const message = String((err && (err.message || err.code)) || '');
  return /SQLITE_BUSY|database is locked/i.test(message);
}

// ── sqlite backend ──────────────────────────────────────────────────────────

function probeFts(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)');
    db.exec('DROP TABLE temp.__fts_probe');
    return true;
  } catch (_) {
    return false;
  }
}

function openSqlite(file, counters) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA foreign_keys = ON');
  const fts = probeFts(db);

  const statements = new Map();
  function prepare(sql) {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  }

  function withBusyRetry(fn) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err)) throw err;
      sleepSync(BUSY_RETRY_MS);
      try {
        return fn();
      } catch (err2) {
        if (isBusy(err2)) {
          if (counters) counters.busySkips += 1;
          return null;
        }
        throw err2;
      }
    }
  }

  function whereClause(pred) {
    const keys = Object.keys(pred || {});
    if (keys.length === 0) return { sql: '', params: [] };
    for (const key of keys) {
      if (!COLUMNS_TABLE_COLUMNS_CHECKED.has(key)) {
        throw new Error(`[Loom] unknown predicate column: ${key}`);
      }
    }
    return { sql: ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`, params: keys.map((k) => pred[k]) };
  }

  // Predicate columns are checked against the union of every declared column so
  // a caller cannot smuggle SQL through a key name.
  const COLUMNS_TABLE_COLUMNS_CHECKED = new Set(Object.values(COLUMNS).flat());

  return {
    kind: 'sqlite',
    file,
    fts,
    exec(sql) {
      return withBusyRetry(() => db.exec(sql));
    },
    insert(table, row) {
      const clean = sanitizeRow(table, row);
      const cols = Object.keys(clean);
      const pk = primaryKeyOf(table);
      // A caller-supplied key replaces (meta, migrations, summaries are keyed by
      // identity, not by insertion order); an omitted key is auto-assigned.
      const verb = clean[pk] !== undefined ? 'INSERT OR REPLACE INTO' : 'INSERT INTO';
      const sql = cols.length
        ? `${verb} ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        : `INSERT INTO ${table} DEFAULT VALUES`;
      const result = withBusyRetry(() => prepare(sql).run(...cols.map((c) => clean[c])));
      if (!result) return null;
      return clean[pk] !== undefined ? clean[pk] : Number(result.lastInsertRowid);
    },
    insertMany(table, rows) {
      const ids = [];
      for (const row of rows || []) ids.push(this.insert(table, row));
      return ids;
    },
    update(table, key, patch) {
      const clean = sanitizeRow(table, patch);
      const cols = Object.keys(clean).filter((c) => c !== primaryKeyOf(table));
      if (cols.length === 0) return false;
      const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${primaryKeyOf(table)} = ?`;
      const result = withBusyRetry(() => prepare(sql).run(...cols.map((c) => clean[c]), key));
      return Boolean(result && result.changes > 0);
    },
    remove(table, key) {
      const sql = `DELETE FROM ${table} WHERE ${primaryKeyOf(table)} = ?`;
      const result = withBusyRetry(() => prepare(sql).run(key));
      return Boolean(result && result.changes > 0);
    },
    removeWhere(table, pred) {
      const { sql, params } = whereClause(pred);
      const result = withBusyRetry(() => prepare(`DELETE FROM ${table}${sql}`).run(...params));
      return result ? Number(result.changes) : 0;
    },
    replaceWhere(table, pred, rows) {
      this.removeWhere(table, pred);
      return this.insertMany(table, rows);
    },
    all(table) {
      columnsOf(table);
      return withBusyRetry(() => prepare(`SELECT * FROM ${table} ORDER BY ${primaryKeyOf(table)}`).all()) || [];
    },
    get(table, key) {
      const sql = `SELECT * FROM ${table} WHERE ${primaryKeyOf(table)} = ?`;
      return withBusyRetry(() => prepare(sql).get(key)) || null;
    },
    where(table, pred) {
      const { sql, params } = whereClause(pred);
      return withBusyRetry(() => prepare(`SELECT * FROM ${table}${sql}`).all(...params)) || [];
    },
    count(table) {
      columnsOf(table);
      const row = withBusyRetry(() => prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
      return row ? Number(row.n) : 0;
    },
    flush() { return true; },
    close() {
      try {
        statements.clear();
        db.close();
      } catch (_) { /* closing a closed handle is not an error worth raising */ }
    },
  };
}

// ── JSON backend ────────────────────────────────────────────────────────────

function emptyState() {
  const tables = {};
  const seq = {};
  for (const table of TABLES) {
    tables[table] = [];
    seq[table] = 0;
  }
  return { loom_version: 1, tables, seq };
}

function readJsonStore(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.tables !== 'object') {
    const err = new Error('[Loom] JSON store has no tables');
    err.code = 'LOOM_DB_CORRUPT';
    throw err;
  }
  const state = emptyState();
  for (const table of TABLES) {
    const rows = parsed.tables[table];
    state.tables[table] = Array.isArray(rows) ? rows : [];
    state.seq[table] = Number.isInteger(parsed.seq && parsed.seq[table])
      ? parsed.seq[table]
      : state.tables[table].length;
  }
  return state;
}

function openJson(file, counters) {
  const state = fs.existsSync(file) ? readJsonStore(file) : emptyState();
  let timer = null;
  let closed = false;
  let dirty = false;

  function writeNow() {
    if (!dirty || closed) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (err) {
      if (counters) counters.droppedUpdates += 1;
      log.debug(`json flush failed: ${err.message}`);
      return false;
    }
  }

  function schedule() {
    dirty = true;
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, FLUSH_DEBOUNCE_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function rows(table) {
    columnsOf(table);
    return state.tables[table];
  }

  function matches(row, pred) {
    for (const key of Object.keys(pred || {})) {
      if (row[key] !== pred[key]) return false;
    }
    return true;
  }

  const handle = {
    kind: 'json',
    file,
    fts: false,
    exec() {
      // The JSON backend has no SQL surface; migrations are shape-based.
      return null;
    },
    insert(table, row) {
      const clean = sanitizeRow(table, row);
      const pk = primaryKeyOf(table);
      if (clean[pk] === undefined) {
        state.seq[table] = (state.seq[table] || 0) + 1;
        clean[pk] = state.seq[table];
      } else {
        if (typeof clean[pk] === 'number') {
          state.seq[table] = Math.max(state.seq[table] || 0, clean[pk]);
        }
        // Same rule as the SQLite backend: a supplied key replaces the row.
        const existing = rows(table).findIndex((r) => r[pk] === clean[pk]);
        if (existing !== -1) {
          state.tables[table][existing] = clean;
          schedule();
          return clean[pk];
        }
      }
      rows(table).push(clean);
      schedule();
      return clean[pk];
    },
    insertMany(table, list) {
      const ids = [];
      for (const row of list || []) ids.push(handle.insert(table, row));
      return ids;
    },
    update(table, key, patch) {
      const pk = primaryKeyOf(table);
      const clean = sanitizeRow(table, patch);
      const row = rows(table).find((r) => r[pk] === key);
      if (!row) return false;
      for (const col of Object.keys(clean)) {
        if (col === pk) continue;
        row[col] = clean[col];
      }
      schedule();
      return true;
    },
    remove(table, key) {
      const pk = primaryKeyOf(table);
      const list = rows(table);
      const idx = list.findIndex((r) => r[pk] === key);
      if (idx === -1) return false;
      list.splice(idx, 1);
      schedule();
      return true;
    },
    removeWhere(table, pred) {
      const list = rows(table);
      const kept = list.filter((r) => !matches(r, pred));
      const removed = list.length - kept.length;
      state.tables[table] = kept;
      if (removed) schedule();
      return removed;
    },
    replaceWhere(table, pred, list) {
      handle.removeWhere(table, pred);
      return handle.insertMany(table, list);
    },
    all(table) {
      const pk = primaryKeyOf(table);
      return rows(table)
        .slice()
        .sort((a, b) => (a[pk] > b[pk] ? 1 : a[pk] < b[pk] ? -1 : 0));
    },
    get(table, key) {
      const pk = primaryKeyOf(table);
      const row = rows(table).find((r) => r[pk] === key);
      return row || null;
    },
    where(table, pred) {
      return rows(table).filter((r) => matches(r, pred));
    },
    count(table) {
      return rows(table).length;
    },
    flush() { return writeNow(); },
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = true;
      writeNow();
      closed = true;
    },
  };

  return handle;
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Open (or create) a Loom store.
 *
 * @param {string} file path of `index.db`
 * @param {{ counters?: object, forceJson?: boolean }} [opts]
 * @returns {object} handle — see the two backends above for the surface
 */
function open(file, opts = {}) {
  const counters = opts.counters || null;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // The JSON store is the default, deliberately.
  //
  // `node:sqlite` is present from Node 22.5 (behind a flag) and stable from
  // 23.4, but "present" is not "serves this schema": on Node 22 and 24 the store
  // opens and then indexes nothing, so the digest is empty and the agent silently
  // loses its project map. That is worse than the slower backend, and it is not
  // reproducible on Node 20 where sqlite does not exist at all.
  //
  // So sqlite is opt-in until it is verified on every version the CI matrix runs:
  //   LOOM_STORE=sqlite
  const wantsSqlite = opts.store === 'sqlite' || process.env.LOOM_STORE === 'sqlite';

  if (!opts.forceJson && wantsSqlite) {
    try {
      return openSqlite(file, counters);
    } catch (err) {
      log.debug(`sqlite unavailable: ${err.message}`);
    }
  }

  const jsonPath = file.replace(/\.db$/, '.json');
  return openJson(jsonPath, counters);
}

module.exports = {
  COLUMNS,
  TABLES,
  PRIMARY_KEYS,
  AUTO_ID_TABLES,
  FLUSH_DEBOUNCE_MS,
  open,
  primaryKeyOf,
  sanitizeRow,
};
