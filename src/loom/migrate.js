'use strict';
// src/loom/migrate.js — schema versioning.
//
// Spec: src/loom_specs.md §3.3 and §15 (failure matrix). The index is
// *derivable*: it can always be rebuilt from the working tree. So the policy
// for anything unexpected — an unknown schema version, a checksum mismatch, a
// corrupt store — is not to repair it in place but to report `rebuilt: true`
// and let the caller drop and recreate it. One cold start, never a wrong index.

const fs = require('fs');
const path = require('path');

const log = require('./log');
const { sha256Text } = require('./hash');

const ACCESS_RETENTION_DAYS = 90;

const SCHEMA_DIR = path.join(__dirname, 'schema');

const MIGRATIONS = Object.freeze([
  { version: 1, name: '001_init.sql', file: path.join(SCHEMA_DIR, '001_init.sql') },
]);

function readSql(migration) {
  return fs.readFileSync(migration.file, 'utf8');
}

function checksumOf(migration) {
  return sha256Text(readSql(migration));
}

/** Latest schema version this build knows about. */
function latestVersion() {
  return MIGRATIONS[MIGRATIONS.length - 1].version;
}

// ── meta ────────────────────────────────────────────────────────────────────

function getMeta(db, key) {
  try {
    const row = db.get('meta', key);
    return row ? row.value : null;
  } catch (_) {
    return null;
  }
}

function setMeta(db, key, value) {
  try {
    db.insert('meta', { key, value: String(value) });
    return true;
  } catch (err) {
    log.debug(`meta write failed for ${key}: ${err.message}`);
    return false;
  }
}

function setMetaIfAbsent(db, key, value) {
  if (getMeta(db, key) !== null) return false;
  return setMeta(db, key, value);
}

/** Current schema version recorded in the store, or 0 when unmigrated. */
function schemaVersion(db) {
  const recorded = Number(getMeta(db, 'schema_version'));
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  try {
    const rows = db.all('migrations');
    if (rows.length) return Math.max(...rows.map((r) => Number(r.version) || 0));
  } catch (_) { /* fall through */ }
  return 0;
}

// ── access retention ────────────────────────────────────────────────────────

/** Drop access rows older than the retention window (spec §3.3, on open()). */
function purgeOldAccess(db, now = Date.now(), days = ACCESS_RETENTION_DAYS) {
  const cutoff = now - days * 86400000;
  try {
    const stale = db.where('access', {});
    const old = stale.filter((row) => Number(row.ts) < cutoff);
    for (const row of old) db.remove('access', row.id);
    return old.length;
  } catch (_) {
    return 0;
  }
}

// ── the migration run ───────────────────────────────────────────────────────

/**
 * Bring the store to the latest schema version.
 *
 * @param {object} db handle from ./db
 * @param {{ projectId?: string, now?: number, forgeVersion?: string }} [opts]
 * @returns {{ version: number, applied: number[], rebuilt: boolean, reason: string|null }}
 */
function apply(db, opts = {}) {
  const now = opts.now || Date.now();
  const forgeVersion = opts.forgeVersion || readForgeVersion();

  let applied = [];
  try {
    applied = db.all('migrations').map((row) => ({
      version: Number(row.version),
      checksum: String(row.checksum),
    }));
  } catch (_) {
    applied = [];
  }

  const known = new Map(MIGRATIONS.map((m) => [m.version, m]));

  // A store written by a newer build cannot be understood; rebuild.
  for (const row of applied) {
    if (!known.has(row.version)) {
      return { version: schemaVersion(db), applied: [], rebuilt: true, reason: 'unknown-version' };
    }
  }

  // A migration whose bytes changed after it ran means the two sides disagree
  // about what the schema is. Rebuild rather than guess.
  for (const row of applied) {
    const expected = checksumOf(known.get(row.version));
    if (row.checksum !== expected) {
      return { version: schemaVersion(db), applied: [], rebuilt: true, reason: 'checksum-mismatch' };
    }
  }

  const done = new Set(applied.map((r) => r.version));
  const ran = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    const sql = readSql(migration);
    // The JSON backend has no SQL surface: its tables are created by db.open(),
    // so running the DDL is a no-op there and only the record is written.
    if (db.kind === 'sqlite') db.exec(sql);
    db.insert('migrations', {
      version: migration.version,
      checksum: sha256Text(sql),
      run_at: now,
    });
    ran.push(migration.version);
  }

  setMetaIfAbsent(db, 'schema_version', String(latestVersion()));
  if (opts.projectId) setMetaIfAbsent(db, 'project_id', opts.projectId);
  setMetaIfAbsent(db, 'forge_version', forgeVersion);
  setMetaIfAbsent(db, 'built_at', '0');
  setMetaIfAbsent(db, 'full_rehash_at', '0');

  purgeOldAccess(db, now);

  return { version: latestVersion(), applied: ran, rebuilt: false, reason: null };
}

function readForgeVersion() {
  try {
    // src/loom/migrate.js -> ../../package.json
    return String(require('../../package.json').version || '0.0.0');
  } catch (_) {
    return '0.0.0';
  }
}

module.exports = {
  ACCESS_RETENTION_DAYS,
  MIGRATIONS,
  latestVersion,
  checksumOf,
  getMeta,
  setMeta,
  setMetaIfAbsent,
  schemaVersion,
  purgeOldAccess,
  apply,
};
