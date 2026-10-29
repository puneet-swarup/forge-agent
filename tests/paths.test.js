// tests/paths.test.js — unit tests for the model-agnostic home + migration.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// We test resolveExisting/forgePath with FORGE_HOME set to a temp dir.
// (migrateIfNeeded is exercised indirectly; a full legacy-dir test would touch
// the real home, so we keep those isolated.)

describe('paths - forgeHome / forgePath', () => {
  const prev = process.env.FORGE_HOME;
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
    process.env.FORGE_HOME = tmp;
    delete require.cache[require.resolve('../src/paths')];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    delete require.cache[require.resolve('../src/paths')];
  });

  test('forgeHome honours FORGE_HOME', () => {
    const paths = require('../src/paths');
    expect(paths.forgeHome()).toBe(path.resolve(tmp));
  });

  test('forgePath joins under the home', () => {
    const paths = require('../src/paths');
    expect(paths.forgePath('logs')).toBe(path.join(path.resolve(tmp), 'logs'));
  });

  test('forgePath supports multiple segments', () => {
    const paths = require('../src/paths');
    expect(paths.forgePath('sessions', 'x', 'summary.json'))
      .toBe(path.join(path.resolve(tmp), 'sessions', 'x', 'summary.json'));
  });
});

describe('paths - resolveExisting', () => {
  const prev = process.env.FORGE_HOME;
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
    process.env.FORGE_HOME = tmp;
    delete require.cache[require.resolve('../src/paths')];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    delete require.cache[require.resolve('../src/paths')];
  });

  test('returns the new path for a fresh create when nothing exists', () => {
    const paths = require('../src/paths');
    const p = paths.resolveExisting('config.json');
    expect(p).toBe(path.join(path.resolve(tmp), 'config.json'));
  });

  test('returns the new path when it exists', () => {
    const paths = require('../src/paths');
    const target = path.join(path.resolve(tmp), 'config.json');
    fs.writeFileSync(target, '{}');
    expect(paths.resolveExisting('config.json')).toBe(target);
  });
});

describe('paths - migrateIfNeeded', () => {
  test('returns a structured result and never throws', () => {
    const paths = require('../src/paths');
    const r = paths.migrateIfNeeded();
    expect(r).toHaveProperty('migrated');
    expect(r).toHaveProperty('from');
    expect(r).toHaveProperty('to');
    expect(typeof r.migrated).toBe('boolean');
  });

  test('does not migrate when FORGE_HOME is explicitly set', () => {
    const prev = process.env.FORGE_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
    process.env.FORGE_HOME = tmp;
    delete require.cache[require.resolve('../src/paths')];
    try {
      const paths = require('../src/paths');
      const r = paths.migrateIfNeeded();
      expect(r.migrated).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      delete require.cache[require.resolve('../src/paths')];
    }
  });
});
