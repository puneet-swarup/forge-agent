// tests/loom/paths.test.js — spec §3.1 and invariant I6.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../src/loom/paths');

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-paths-'));
});

afterEach(() => {
  try { fs.chmodSync(tmp, 0o755); } catch (_) { /* nothing to restore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loom/paths.normalizeRel', () => {
  it('converts Windows separators to forward slashes', () => {
    expect(paths.normalizeRel('src\\loom\\db.js')).toBe('src/loom/db.js');
  });

  it('strips a leading ./ and collapses duplicate separators', () => {
    expect(paths.normalizeRel('./src//loom/./db.js')).toBe('src/loom/db.js');
  });

  it('strips a trailing slash', () => {
    expect(paths.normalizeRel('src/loom/')).toBe('src/loom');
  });

  it('rejects anything that escapes the project', () => {
    expect(paths.normalizeRel('../etc/passwd')).toBeNull();
    expect(paths.normalizeRel('src/../../etc/passwd')).toBeNull();
    expect(paths.normalizeRel('..')).toBeNull();
  });

  it('rejects absolute paths on every platform', () => {
    expect(paths.normalizeRel('/etc/passwd')).toBeNull();
    expect(paths.normalizeRel('C:\\Users\\me\\file.js')).toBeNull();
    expect(paths.normalizeRel('C:/Users/me/file.js')).toBeNull();
    expect(paths.normalizeRel('//server/share/file.js')).toBeNull();
  });

  it('rejects empty and non-string input', () => {
    expect(paths.normalizeRel('')).toBeNull();
    expect(paths.normalizeRel('   ')).toBeNull();
    expect(paths.normalizeRel('.')).toBeNull();
    expect(paths.normalizeRel('./')).toBeNull();
    expect(paths.normalizeRel(null)).toBeNull();
    expect(paths.normalizeRel(42)).toBeNull();
  });

  it('keeps a plain filename', () => {
    expect(paths.normalizeRel('index.js')).toBe('index.js');
  });
});

describe('loom/paths.toRel', () => {
  it('makes an absolute path relative to the root', () => {
    expect(paths.toRel('/work/proj', '/work/proj/src/a.js')).toBe('src/a.js');
  });

  it('returns null for a path outside the root', () => {
    expect(paths.toRel('/work/proj', '/work/other/a.js')).toBeNull();
  });

  it('returns null for the root itself', () => {
    expect(paths.toRel('/work/proj', '/work/proj')).toBeNull();
  });
});

describe('loom/paths.relDir', () => {
  it('returns the directory part', () => {
    expect(paths.relDir('src/loom/db.js')).toBe('src/loom');
    expect(paths.relDir('index.js')).toBe('');
  });
});

describe('loom/paths.projectId', () => {
  it('is stable for the same root', () => {
    expect(paths.projectId('/work/proj')).toBe(paths.projectId('/work/proj'));
  });

  it('differs for different roots and is 16 hex chars', () => {
    const a = paths.projectId('/work/a');
    const b = paths.projectId('/work/b');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalises relative roots', () => {
    const resolved = path.resolve('/work/proj');
    expect(paths.projectId('/work/proj')).toBe(paths.projectId(resolved));
  });
});

describe('loom/paths.loomDir', () => {
  it('uses <root>/.forge/loom by default', () => {
    const loc = paths.loomDir({ root: tmp });
    expect(loc.dir).toBe(path.join(tmp, '.forge', 'loom'));
    expect(loc.fallback).toBe(false);
    expect(loc.projectId).toBe(paths.projectId(tmp));
  });

  it('honours an explicit dir, resolved against the root', () => {
    const loc = paths.loomDir({ root: tmp, dir: 'custom/loom' });
    expect(loc.dir).toBe(path.join(tmp, 'custom', 'loom'));
    expect(loc.fallback).toBe(false);
  });

  it('falls back to the global directory when the project is not writable', () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores the mode bits
    fs.chmodSync(tmp, 0o555);
    const home = path.join(tmp, 'home');
    const loc = paths.loomDir({ root: tmp, home });
    expect(loc.fallback).toBe(true);
    expect(loc.dir).toBe(path.join(home, '.forge-agent', 'loom', paths.projectId(tmp)));
  });
});

describe('loom/paths.ensureGitignore', () => {
  it('creates .gitignore with exactly the generated artifacts', () => {
    const dir = path.join(tmp, '.forge', 'loom');
    const result = paths.ensureGitignore(dir);
    expect(result.created).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('index.db\nindex.db-wal\nindex.db-shm\n*.bad\n');
  });

  it('never modifies an existing .gitignore', () => {
    const dir = path.join(tmp, '.forge', 'loom');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '.gitignore');
    fs.writeFileSync(file, 'mine\n');

    const result = paths.ensureGitignore(dir);
    expect(result.created).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine\n');
  });

  it('never touches the project root .gitignore', () => {
    const rootIgnore = path.join(tmp, '.gitignore');
    fs.writeFileSync(rootIgnore, 'node_modules\n');
    paths.ensureGitignore(path.join(tmp, '.forge', 'loom'));
    expect(fs.readFileSync(rootIgnore, 'utf8')).toBe('node_modules\n');
  });
});

describe('loom/paths.dbFile / jsonFileFor', () => {
  it('names the store index.db and its JSON sibling index.json', () => {
    expect(paths.dbFile('/x')).toBe(path.join('/x', 'index.db'));
    expect(paths.jsonFileFor('/x/index.db')).toBe('/x/index.json');
  });
});
