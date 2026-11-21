// tests/loom/migrate.test.js — spec §3.3 and §15: versioning, meta, retention.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dbmod = require('../../src/loom/db');
const migrate = require('../../src/loom/migrate');

let tmp;
let storeFile;
let db;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migrate-'));
  storeFile = path.join(tmp, 'index.db');
  db = dbmod.open(storeFile, { forceJson: true });
});

afterEach(() => {
  try { db.close(); } catch (_) { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loom/migrate.apply', () => {
  it('applies migration 1 to a fresh store', () => {
    const result = migrate.apply(db, { projectId: 'abc123', now: 1000 });
    expect(result.rebuilt).toBe(false);
    expect(result.applied).toEqual([1]);
    expect(result.version).toBe(1);
    expect(db.count('migrations')).toBe(1);
    expect(migrate.schemaVersion(db)).toBe(1);
  });

  it('seeds the meta rows the digest and doctor read', () => {
    migrate.apply(db, { projectId: 'abc123', now: 1000, forgeVersion: '9.9.9' });
    expect(migrate.getMeta(db, 'schema_version')).toBe('1');
    expect(migrate.getMeta(db, 'project_id')).toBe('abc123');
    expect(migrate.getMeta(db, 'forge_version')).toBe('9.9.9');
    expect(migrate.getMeta(db, 'built_at')).toBe('0');
    expect(migrate.getMeta(db, 'full_rehash_at')).toBe('0');
  });

  it('is idempotent', () => {
    migrate.apply(db, { projectId: 'abc123', now: 1000 });
    const second = migrate.apply(db, { projectId: 'abc123', now: 2000 });
    expect(second.applied).toEqual([]);
    expect(second.rebuilt).toBe(false);
    expect(db.count('migrations')).toBe(1);
  });

  it('does not overwrite an existing meta value', () => {
    migrate.apply(db, { projectId: 'abc123', now: 1000 });
    migrate.setMeta(db, 'project_id', 'changed');
    migrate.apply(db, { projectId: 'abc123', now: 2000 });
    expect(migrate.getMeta(db, 'project_id')).toBe('changed');
  });

  it('records the checksum of the migration it ran', () => {
    migrate.apply(db, { projectId: 'abc123', now: 1000 });
    const row = db.get('migrations', 1);
    expect(row.checksum).toBe(migrate.checksumOf(migrate.MIGRATIONS[0]));
    expect(row.run_at).toBe(1000);
  });

  it('asks for a rebuild when an applied checksum no longer matches', () => {
    migrate.apply(db, { projectId: 'abc123', now: 1000 });
    db.update('migrations', 1, { checksum: 'deadbeef' });
    const result = migrate.apply(db, { projectId: 'abc123', now: 2000 });
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe('checksum-mismatch');
  });

  it('asks for a rebuild when the store was written by a newer build', () => {
    migrate.apply(db, { projectId: 'abc123', now: 1000 });
    db.insert('migrations', { version: 99, checksum: 'whatever', run_at: 1000 });
    const result = migrate.apply(db, { projectId: 'abc123', now: 2000 });
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe('unknown-version');
  });

  it('reports version 0 for an unmigrated store', () => {
    expect(migrate.schemaVersion(db)).toBe(0);
  });

  it('reads the forge version from package.json by default', () => {
    const result = migrate.apply(db, { projectId: 'abc123', now: 1000 });
    expect(result.applied).toEqual([1]);
    expect(migrate.getMeta(db, 'forge_version')).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('loom/migrate.purgeOldAccess', () => {
  it('drops access rows older than the retention window', () => {
    const now = 100 * 86400000;
    db.insertMany('access', [
      { file_id: 1, ts: now - 1 * 86400000, session: 's', op: 'read', lines: 1 },
      { file_id: 1, ts: now - 89 * 86400000, session: 's', op: 'read', lines: 1 },
      { file_id: 1, ts: now - 91 * 86400000, session: 's', op: 'read', lines: 1 },
    ]);
    expect(migrate.purgeOldAccess(db, now)).toBe(1);
    expect(db.count('access')).toBe(2);
  });

  it('runs on apply()', () => {
    const now = 100 * 86400000;
    db.insert('access', { file_id: 1, ts: 0, session: 's', op: 'read', lines: 1 });
    migrate.apply(db, { projectId: 'abc123', now });
    expect(db.count('access')).toBe(0);
  });

  it('never throws on an empty store', () => {
    expect(() => migrate.purgeOldAccess(db, Date.now())).not.toThrow();
  });
});

describe('loom/migrate schema file', () => {
  it('ships 001_init.sql with every table', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../src/loom/schema/001_init.sql'), 'utf8');
    for (const table of dbmod.TABLES) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
  });

  it('declares the same columns as db.js', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../src/loom/schema/001_init.sql'), 'utf8');
    for (const [table, columns] of Object.entries(dbmod.COLUMNS)) {
      const match = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
      expect(match).not.toBeNull();
      for (const column of columns) {
        expect(match[1]).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
      }
    }
  });
});
