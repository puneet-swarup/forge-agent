// tests/loom/index.test.js — spec §9: the public surface and its error boundary.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const loom = require('../../src/loom');

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-index-'));
  loom.close();
});

afterEach(() => {
  loom.close();
  try { fs.chmodSync(tmp, 0o755); } catch (_) { /* nothing to restore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const loomDirOf = (root) => path.join(root, '.forge', 'loom');

describe('loom.open — enabled', () => {
  it('creates the index directory and its .gitignore', () => {
    const result = loom.open({ root: tmp, env: {} });
    expect(result.skipped).toBe(false);
    expect(result.enabled).toBe(true);
    expect(result.dir).toBe(loomDirOf(tmp));
    expect(fs.existsSync(path.join(loomDirOf(tmp), '.gitignore'))).toBe(true);
    expect(loom.isEnabled()).toBe(true);
  });

  it('reports the driver and schema version', () => {
    const result = loom.open({ root: tmp, env: {}, forceJson: true });
    expect(result.kind).toBe('json');
    expect(result.fts).toBe(false);
    expect(result.version).toBe(1);
    expect(result.rebuilt).toBe(false);
  });

  it('exposes a usable store handle', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    const db = loom.db();
    expect(db).not.toBeNull();
    const id = db.insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    expect(db.get('files', id).rel_path).toBe('a.js');
  });

  it('reports status for an open store', () => {
    loom.open({ root: tmp, env: {}, forceJson: true, session: 'sess-1' });
    loom.db().insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });

    const status = loom.status();
    expect(status.open).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.kind).toBe('json');
    expect(status.dir).toBe(loomDirOf(tmp));
    expect(status.root).toBe(path.resolve(tmp));
    expect(status.schemaVersion).toBe(1);
    expect(status.files).toBe(1);
    expect(status.session).toBe('sess-1');
    expect(status.fallback).toBe(false);
    expect(status.projectId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('honours LOOM_DIR', () => {
    const custom = path.join(tmp, 'elsewhere');
    const result = loom.open({ root: tmp, env: { LOOM_DIR: custom }, forceJson: true });
    expect(result.dir).toBe(custom);
    expect(fs.existsSync(path.join(custom, '.gitignore'))).toBe(true);
  });

  it('reports counters, all zero on a fresh open', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    const stats = loom.stats();
    for (const key of loom.COUNTER_KEYS) {
      expect(stats[key]).toBe(0);
    }
    expect(stats.open).toBe(true);
    expect(stats.enabled).toBe(true);
  });
});

describe('loom.open — I2: the kill switch does no I/O', () => {
  it('creates nothing when LOOM_ENABLED=0', () => {
    const result = loom.open({ root: tmp, env: { LOOM_ENABLED: '0' } });
    expect(result).toEqual({ skipped: true, enabled: false });
    expect(loom.isEnabled()).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.forge'))).toBe(false);
    expect(loom.db()).toBeNull();
  });

  it('reports a closed, disabled status', () => {
    loom.open({ root: tmp, env: { LOOM_ENABLED: '0' } });
    const status = loom.status();
    expect(status.open).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.files).toBe(0);
    expect(status.dir).toBeNull();
  });

  it('closes an already-open store when reopened disabled', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    expect(loom.isEnabled()).toBe(true);
    loom.open({ root: tmp, env: { LOOM_ENABLED: '0' } });
    expect(loom.isEnabled()).toBe(false);
  });
});

describe('loom.open — recovery', () => {
  it('quarantines a corrupt store and rebuilds it', () => {
    const dir = loomDirOf(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), '{ this is not json');

    const result = loom.open({ root: tmp, env: {}, forceJson: true });
    expect(result.skipped).toBe(false);
    expect(result.enabled).toBe(true);
    expect(loom.stats().dbRebuilds).toBe(1);
    expect(fs.existsSync(path.join(dir, 'index.json.bad'))).toBe(true);
    expect(loom.status().files).toBe(0);
  });

  it('rebuilds when the recorded schema is unknown', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    loom.db().insert('migrations', { version: 99, checksum: 'x', run_at: 1 });
    loom.close();

    const result = loom.open({ root: tmp, env: {}, forceJson: true });
    expect(result.skipped).toBe(false);
    expect(loom.stats().dbRebuilds).toBe(1);
    expect(loom.status().schemaVersion).toBe(1);
  });

  it('never throws when the store cannot be created', () => {
    // `nested-file` is a plain file, so creating a directory beneath it fails.
    fs.writeFileSync(path.join(tmp, 'nested-file'), 'x');
    const result = loom.open({
      root: tmp,
      env: { LOOM_DIR: path.join(tmp, 'nested-file', 'loom') },
      forceJson: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.enabled).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(loom.isEnabled()).toBe(false);
  });

  it('falls back to the global directory when the project is not writable', () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores mode bits
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.chmodSync(tmp, 0o555);

    const result = loom.open({ root: tmp, env: {}, home, forceJson: true });
    expect(result.skipped).toBe(false);
    expect(result.dir.startsWith(path.join(home, '.forge-agent', 'loom'))).toBe(true);
    expect(loom.status().fallback).toBe(true);
  });
});

describe('loom.close', () => {
  it('flushes and releases the store', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    loom.db().insert('notes', { scope: 'project', text: 'a gotcha', origin: 'model', made_at: 1 });
    expect(loom.close()).toBe(true);
    expect(loom.isEnabled()).toBe(false);
    expect(loom.db()).toBeNull();

    const raw = JSON.parse(fs.readFileSync(path.join(loomDirOf(tmp), 'index.json'), 'utf8'));
    expect(raw.tables.notes).toHaveLength(1);
  });

  it('is safe to call twice', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    expect(loom.close()).toBe(true);
    expect(loom.close()).toBe(false);
  });

  it('is safe to call when never opened', () => {
    expect(loom.close()).toBe(false);
    expect(loom.isEnabled()).toBe(false);
  });

  it('preserves the index across a close and reopen', () => {
    loom.open({ root: tmp, env: {}, forceJson: true });
    loom.db().insert('files', { rel_path: 'a.js', lang: 'js', bytes: 1, mtime_ms: 1, content_sha: 'x', loc: 1, indexed_at: 1 });
    loom.close();

    loom.open({ root: tmp, env: {}, forceJson: true });
    expect(loom.status().files).toBe(1);
    expect(loom.stats().dbRebuilds).toBe(0);
  });
});

describe('loom.config', () => {
  it('returns the configuration in force', () => {
    loom.open({ root: tmp, env: { LOOM_DIGEST_TOKENS: '900' }, forceJson: true });
    expect(loom.config().digestTokens).toBe(900);
  });

  it('returns parsed defaults when closed', () => {
    loom.close();
    const cfg = loom.config();
    expect(cfg.digestTokens).toBe(1200);
    expect(cfg.warnings).toEqual([]);
  });
});
