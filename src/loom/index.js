'use strict';
// src/loom/index.js — Loom's public surface.
//
// Spec: src/loom_specs.md §9. This file is the *error boundary* the rest of the
// agent talks to, and it is the only place that owns module state. Two
// invariants are enforced here and nowhere else:
//
//   I1 — nothing throws into a tool handler. Every exported function catches,
//        logs at debug, and returns a neutral value.
//   I2 — `LOOM_ENABLED=0` performs no I/O at all: `open()` returns before the
//        first `fs` call, so a disabled Loom cannot create `.forge/loom`.
//
// Scope of this slice: the store (open / migrate / status / counters). The
// indexer, digest and tool middleware land in later slices; see
// docs/LOOM.md for the plan and NEXT_SESSION.md for the current position.

const fs = require('fs');
const path = require('path');

const log = require('./log');
const configMod = require('./config');
const paths = require('./paths');
const dbmod = require('./db');
const migrate = require('./migrate');

const COUNTER_KEYS = Object.freeze([
  'hookErrors',
  'parseErrors',
  'busySkips',
  'digestTruncations',
  'workerFallbacks',
  'dbRebuilds',
  'droppedUpdates',
]);

/** Module state. `null` means "not open"; `_disabled` means "open() said no". */
let _state = null;
let _disabled = false;

function emptyCounters() {
  const counters = {};
  for (const key of COUNTER_KEYS) counters[key] = 0;
  return counters;
}

/** Errors that mean "this file is not a Loom store", not "the disk is broken". */
function looksCorrupt(err) {
  const message = String((err && (err.message || err.code)) || '');
  return /not a database|Unexpected token|JSON|LOOM_DB_CORRUPT|malformed|unexpected end/i.test(message);
}

function quarantine(file) {
  const targets = [file, paths.jsonFileFor(file)];
  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) continue;
      const bad = `${target}.bad`;
      try { fs.rmSync(bad, { force: true }); } catch (_) { /* best effort */ }
      fs.renameSync(target, bad);
      log.debug(`quarantined ${path.basename(target)} -> ${path.basename(bad)}`);
    } catch (_) {
      // A store we cannot move is a store we will try to open again; the retry
      // below decides whether that worked.
    }
  }
}

/**
 * Open the store, quarantining a corrupt one and rebuilding from scratch.
 * Never throws.
 */
function openStore(file, counters, forceJson) {
  try {
    return dbmod.open(file, { counters, forceJson });
  } catch (err) {
    if (!looksCorrupt(err)) throw err;
    counters.dbRebuilds += 1;
    log.warn(`index unreadable (${err.message}); rebuilding`);
    quarantine(file);
    return dbmod.open(file, { counters, forceJson });
  }
}

/**
 * Open Loom for a project.
 *
 * @param {{ root?: string, session?: string, env?: object, home?: string,
 *           forceJson?: boolean, silent?: boolean }} [opts]
 * @returns {{ skipped: boolean, enabled: boolean, dir?: string, kind?: string,
 *             fts?: boolean, version?: number, rebuilt?: boolean, error?: string }}
 */
function open(opts = {}) {
  close();

  const cfg = configMod.load(opts.env || process.env, { silent: opts.silent === true });
  if (!cfg.enabled) {
    // I2: return before any filesystem work.
    _disabled = true;
    _state = null;
    return { skipped: true, enabled: false };
  }
  _disabled = false;

  const root = path.resolve(opts.root || process.cwd());
  const counters = emptyCounters();

  try {
    const loc = paths.loomDir({ root, dir: cfg.dir, home: opts.home });
    paths.ensureGitignore(loc.dir);

    const file = paths.dbFile(loc.dir);

    // Two backends: `node:sqlite` when the runtime provides a usable one, and a
    // JSON store that always works. db.js falls back when the module is missing,
    // but a runtime can also provide it and then fail on PRAGMA, on the schema,
    // or on a statement — and until now that disabled Loom for the whole run,
    // silently, because attach.js turns a skipped store into an empty digest.
    //
    // So the fallback happens here too: if the sqlite store cannot be opened and
    // migrated, the run gets the JSON store rather than nothing.
    let db;
    let migration;

    try {
      db = openStore(file, counters, opts.forceJson === true);
      migration = migrate.apply(db, { projectId: loc.projectId, forgeVersion: opts.forgeVersion });
    } catch (err) {
      // Only a caller that already asked for JSON is out of options. `db` being
      // undefined is the ordinary case here — openStore threw — and is exactly
      // what the fallback is for.
      if (opts.forceJson === true) throw err;

      log.warn(`sqlite store unusable (${err.message}); using the JSON store`);
      try { if (db) db.close(); } catch (_) { /* already gone */ }
      quarantine(file);

      db = openStore(file, counters, true);
      migration = migrate.apply(db, { projectId: loc.projectId, forgeVersion: opts.forgeVersion });
    }
    if (migration.rebuilt) {
      counters.dbRebuilds += 1;
      log.warn(`${migration.reason}; rebuilding the index`);
      try { db.close(); } catch (_) { /* already gone */ }
      quarantine(file);
      db = openStore(file, counters, opts.forceJson === true);
      migration = migrate.apply(db, { projectId: loc.projectId, forgeVersion: opts.forgeVersion });
    }

    _state = {
      cfg,
      root,
      dir: loc.dir,
      file,
      fallback: loc.fallback,
      projectId: loc.projectId,
      session: opts.session || null,
      db,
      counters,
      migration,
    };

    if (loc.fallback) {
      log.info(`project directory is not writable; index lives at ${loc.dir}`);
    }

    return {
      skipped: false,
      enabled: true,
      dir: loc.dir,
      kind: db.kind,
      fts: db.fts,
      version: migration.version,
      rebuilt: migration.rebuilt,
    };
  } catch (err) {
    log.warn(`disabled for this run: ${err.message}`);
    _state = null;
    return { skipped: true, enabled: false, error: err.message };
  }
}

/** Is Loom enabled and open? */
function isEnabled() {
  return Boolean(_state);
}

/** The configuration in force, or a freshly parsed one when closed. */
function config() {
  if (_state) return _state.cfg;
  try {
    return configMod.load(process.env, { silent: true });
  } catch (_) {
    return { ...configMod.DEFAULTS, warnings: [] };
  }
}

/** The store handle, for the indexer and query layers. `null` when closed. */
function db() {
  return _state ? _state.db : null;
}

/** Counters, as reported by `--loom stats` and `--loom doctor`. */
function stats() {
  const counters = _state ? { ..._state.counters } : emptyCounters();
  return { ...counters, open: Boolean(_state), enabled: !_disabled };
}

/**
 * A one-object description of the store, for `--loom doctor`.
 * Safe to call when closed: every field degrades to a neutral value.
 */
function status() {
  if (!_state) {
    return {
      enabled: !_disabled,
      open: false,
      kind: null,
      fts: false,
      dir: null,
      root: null,
      fallback: false,
      schemaVersion: 0,
      files: 0,
      session: null,
      counters: stats(),
    };
  }
  const { db: handle, counters } = _state;
  let files = 0;
  let schemaVersion = 0;
  try {
    files = handle.count('files');
    schemaVersion = migrate.schemaVersion(handle);
  } catch (err) {
    log.debug(`status read failed: ${err.message}`);
  }
  return {
    enabled: true,
    open: true,
    kind: handle.kind,
    fts: handle.fts,
    dir: _state.dir,
    root: _state.root,
    fallback: _state.fallback,
    projectId: _state.projectId,
    schemaVersion,
    files,
    session: _state.session,
    counters: { ...counters },
  };
}

/** Flush and close. Never throws; safe to call when closed. */
function close() {
  if (!_state) {
    _disabled = false;
    return false;
  }
  try {
    _state.db.flush();
    _state.db.close();
  } catch (err) {
    log.debug(`close failed: ${err.message}`);
  }
  _state = null;
  return true;
}

module.exports = {
  COUNTER_KEYS,
  open,
  close,
  isEnabled,
  config,
  db,
  stats,
  status,
};
