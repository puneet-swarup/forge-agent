// tests/loom/db.test.js — spec §3.2/§3.3: the two backends behind one interface.
//
// The JSON backend is exercised unconditionally: `package.json` declares
// `engines >= 20`, where `node:sqlite` does not exist, so JSON is what most
// users run. The SQLite backend runs only where the runtime provides it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dbmod = require('../../src/loom/db');

function sqliteAvailable() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    probe.close();
    return true;
  } catch (_) {
    return false;
  }
}

const HAS_SQLITE = sqliteAvailable();

let tmp;
let storeFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-db-'));
  storeFile = path.join(tmp, 'index.db');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loom/db schema declaration', () => {
  it('declares every table of 001_init.sql', () => {
    expect(dbmod.TABLES).toEqual([
      'meta', 'files', 'symbols', 'imports', 'summaries', 'access', 'notes', 'migrations',
    ]);
  });

  it('knows the primary key of each table', () => {
    expect(dbmod.primaryKeyOf('meta')).toBe('key');
    expect(dbmod.primaryKeyOf('migrations')).toBe('version');
    expect(dbmod.primaryKeyOf('summaries')).toBe('file_id');
    expect(dbmod.primaryKeyOf('files')).toBe('id');
    expect(dbmod.primaryKeyOf('access')).toBe('id');
  });

  it('sanitises a row down to declared columns', () => {
    const clean = dbmod.sanitizeRow('files', { rel_path: 'a.js', lang: 'js', bogus: 1, bytes: undefined });
    expect(clean).toEqual({ rel_path: 'a.js', lang: 'js' });
  });

  it('rejects an unknown table', () => {
    expect(() => dbmod.sanitizeRow('nope', {})).toThrow(/unknown table/);
  });
});

describe('loom/db JSON backend', () => {
  let db;

  beforeEach(() => {
    db = dbmod.open(storeFile, { forceJson: true });
  });

  afterEach(() => {
    db.close();
  });

  it('opens as the json kind with no FTS', () => {
    expect(db.kind).toBe('json');
    expect(db.fts).toBe(false);
    expect(db.file).toBe(path.join(tmp, 'index.json'));
  });

  it('assigns auto-increment ids and returns them', () => {
    const a = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    const b = db.insert('files', { rel_path: 'b.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'y', loc: 1, indexed_at: 1 });
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(db.count('files')).toBe(2);
  });

  it('honours an explicit primary key', () => {
    db.insert('meta', { key: 'schema_version', value: '1' });
    expect(db.get('meta', 'schema_version').value).toBe('1');
  });

  it('updates a row', () => {
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    expect(db.update('files', id, { bytes: 99 })).toBe(true);
    expect(db.get('files', id).bytes).toBe(99);
    expect(db.update('files', 999, { bytes: 1 })).toBe(false);
  });

  it('refuses to update the primary key through update()', () => {
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    db.update('files', id, { id: 42, bytes: 2 });
    expect(db.get('files', 42)).toBeNull();
    expect(db.get('files', id).bytes).toBe(2);
  });

  it('removes a row', () => {
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    expect(db.remove('files', id)).toBe(true);
    expect(db.remove('files', id)).toBe(false);
    expect(db.count('files')).toBe(0);
  });

  it('removes by predicate', () => {
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    db.insertMany('symbols', [
      { file_id: id, name: 'a', kind: 'function', line_start: 1, line_end: 2 },
      { file_id: id, name: 'b', kind: 'function', line_start: 3, line_end: 4 },
      { file_id: 99, name: 'c', kind: 'function', line_start: 1, line_end: 2 },
    ]);
    expect(db.removeWhere('symbols', { file_id: id })).toBe(2);
    expect(db.count('symbols')).toBe(1);
  });

  it('replaces the rows of a predicate atomically enough for imports', () => {
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    db.replaceWhere('imports', { file_id: id }, [{ file_id: id, specifier: './a', resolved: 'a.js', kind: 'require' }]);
    db.replaceWhere('imports', { file_id: id }, [{ file_id: id, specifier: './b', resolved: 'b.js', kind: 'import' }]);
    const rows = db.where('imports', { file_id: id });
    expect(rows).toHaveLength(1);
    expect(rows[0].specifier).toBe('./b');
  });

  it('returns rows sorted by primary key', () => {
    db.insert('files', { rel_path: 'z.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'z', loc: 1, indexed_at: 1 });
    db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'a', loc: 1, indexed_at: 1 });
    expect(db.all('files').map((r) => r.rel_path)).toEqual(['z.js', 'a.js']);
  });

  it('persists atomically and reopens with the same rows', () => {
    db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    expect(fs.existsSync(db.file)).toBe(false); // debounced, not written yet
    expect(db.flush()).toBe(true);
    expect(fs.existsSync(db.file)).toBe(true);
    expect(fs.existsSync(`${db.file}.tmp`)).toBe(false);
    db.close();

    const reopened = dbmod.open(storeFile, { forceJson: true });
    expect(reopened.count('files')).toBe(1);
    expect(reopened.get('files', 1).rel_path).toBe('a.js');
    reopened.close();
  });

  it('keeps ids monotonic across a reopen', () => {
    db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    db.close();
    const reopened = dbmod.open(storeFile, { forceJson: true });
    const id = reopened.insert('files', { rel_path: 'b.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'y', loc: 1, indexed_at: 1 });
    expect(id).toBe(2);
    reopened.close();
  });

  it('writes on close even when nothing was flushed', () => {
    db.insert('notes', { scope: 'project', text: 'a gotcha', origin: 'model', made_at: 1 });
    db.close();
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'index.json'), 'utf8'));
    expect(raw.tables.notes).toHaveLength(1);
  });

  it('starts from an empty store when the file is absent', () => {
    expect(db.all('files')).toEqual([]);
    expect(db.all('meta')).toEqual([]);
  });

  it('throws a tagged error for a corrupt store', () => {
    const file = path.join(tmp, 'corrupt.json');
    fs.writeFileSync(file, 'not json at all');
    expect(() => dbmod.open(path.join(tmp, 'corrupt.db'), { forceJson: true })).toThrow();
  });

  it('exposes a no-op exec so migrations can branch on kind', () => {
    expect(db.exec('CREATE TABLE x (y)')).toBeNull();
  });
});

describe('loom/db driver selection', () => {
  it('falls back to JSON when node:sqlite is unavailable', () => {
    if (HAS_SQLITE) return; // the next test covers the other branch
    const db = dbmod.open(storeFile);
    expect(db.kind).toBe('json');
    db.close();
  });

  it('uses SQLite when the runtime provides it', () => {
    if (!HAS_SQLITE) return;
    const db = dbmod.open(storeFile);
    expect(db.kind).toBe('sqlite');
    expect(typeof db.fts).toBe('boolean');
    db.close();
  });

  it('creates the directory that holds the store', () => {
    const nested = path.join(tmp, 'deep', 'nested', 'index.db');
    const db = dbmod.open(nested, { forceJson: true });
    expect(fs.existsSync(path.dirname(nested))).toBe(true);
    db.close();
  });
});

describe('loom/db SQLite backend', () => {
  const maybe = HAS_SQLITE ? it : it.skip;

  maybe('round-trips rows through the same interface', () => {
    const db = dbmod.open(storeFile, { forceJson: false });
    if (db.kind !== 'sqlite') { db.close(); return; }

    db.exec(require('fs').readFileSync(path.join(__dirname, '../../src/loom/schema/001_init.sql'), 'utf8'));
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    expect(id).toBe(1);
    expect(db.get('files', id).rel_path).toBe('a.js');

    db.update('files', id, { bytes: 5 });
    expect(db.get('files', id).bytes).toBe(5);

    db.insertMany('symbols', [
      { file_id: id, name: 'a', kind: 'function', line_start: 1, line_end: 2 },
      { file_id: id, name: 'b', kind: 'function', line_start: 3, line_end: 4 },
    ]);
    expect(db.count('symbols')).toBe(2);
    expect(db.where('symbols', { file_id: id })).toHaveLength(2);
    expect(db.removeWhere('symbols', { file_id: id })).toBe(2);

    db.insert('meta', { key: 'k', value: 'v' });
    expect(db.get('meta', 'k').value).toBe('v');
    db.insert('meta', { key: 'k', value: 'v2' }); // a supplied key replaces
    expect(db.get('meta', 'k').value).toBe('v2');
    db.close();
  });

  maybe('rejects an unknown predicate column instead of interpolating it', () => {
    const db = dbmod.open(storeFile, { forceJson: false });
    if (db.kind !== 'sqlite') { db.close(); return; }
    db.exec(require('fs').readFileSync(path.join(__dirname, '../../src/loom/schema/001_init.sql'), 'utf8'));
    expect(() => db.where('files', { 'id = 1 OR 1=1 --': 1 })).toThrow(/unknown predicate column/);
    db.close();
  });
});
