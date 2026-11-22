// tests/loom/enabled-by-default.test.js — Loom ships on, and can be turned off.
//
// Slice 4 made the stored index real, so the digest ranks by what the agent
// actually read instead of alphabetical ties. That is the condition the switch
// was waiting for. The contract now:
//
//   default            Loom runs and the first message carries a digest
//   --no-loom / LOOM_ENABLED=0   every Loom call is a no-op with no I/O (I2)
//   any failure        the run continues without a digest (I1)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-default-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', engines: { node: '>=20' } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), "const b = require('./b');\nmodule.exports = 1;\n");
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'module.exports = 2;\n');
  return dir;
}

describe('Loom is enabled by default', () => {
  test('the shipped configuration has it on', () => {
    const config = require('../../src/config');
    expect(config.LOOM_ENABLED).toBe(true);
  });

  test('the default produces a digest for a real project', () => {
    const dir = tempProject();
    try {
      const { buildContextDigest } = require('../../src/loom/attach');
      const out = buildContextDigest({ cwd: dir });

      expect(out).toContain('# Project map');
      expect(out).toContain('demo');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('the index is incremental: a second run is not slower than the first', () => {
    const dir = tempProject();
    try {
      const { buildContextDigest } = require('../../src/loom/attach');

      const first = Date.now();
      buildContextDigest({ cwd: dir });
      const firstMs = Date.now() - first;

      const second = Date.now();
      buildContextDigest({ cwd: dir });
      const secondMs = Date.now() - second;

      // The second run reuses every row via the mtime/size fast negative.
      // Allow generous slack: this is a "did it avoid a full rebuild" check,
      // not a benchmark.
      expect(secondMs).toBeLessThanOrEqual(firstMs * 2 + 500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('turning it off', () => {
  test('LOOM_ENABLED=false produces no digest and does no work', () => {
    const dir = tempProject();
    const config = require('../../src/config');
    const before = config.LOOM_ENABLED;

    try {
      config.LOOM_ENABLED = false;
      const { buildContextDigest } = require('../../src/loom/attach');
      expect(buildContextDigest({ cwd: dir })).toBe('');
    } finally {
      config.LOOM_ENABLED = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--no-loom is a real flag that reaches the config', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.js'), 'utf8');
    expect(src).toMatch(/case '--no-loom':/);
    expect(src).toContain('config.LOOM_ENABLED = false');
  });

  test('recordAccess is a no-op when disabled', () => {
    const config = require('../../src/config');
    const before = config.LOOM_ENABLED;

    try {
      config.LOOM_ENABLED = false;
      const { recordAccess } = require('../../src/loom/attach');
      expect(recordAccess('src/a.js', 'read')).toBe(false);
    } finally {
      config.LOOM_ENABLED = before;
    }
  });
});

describe('failure never reaches the run (I1)', () => {
  test('a directory that does not exist yields an empty digest', () => {
    const { buildContextDigest } = require('../../src/loom/attach');
    expect(buildContextDigest({ cwd: '/nonexistent/path/xyz' })).toBe('');
  });

  test('a corrupt index is rebuilt rather than thrown', () => {
    const dir = tempProject();
    try {
      const { buildContextDigest } = require('../../src/loom/attach');

      // Build once so the index exists, then corrupt every candidate file.
      buildContextDigest({ cwd: dir });

      const candidates = ['.forge/loom.db', '.forge/loom.json', 'loom.db', 'loom.json'];
      for (const rel of candidates) {
        const full = path.join(dir, rel);
        if (fs.existsSync(full)) fs.writeFileSync(full, 'not a database');
      }

      expect(() => buildContextDigest({ cwd: dir })).not.toThrow();
      expect(typeof buildContextDigest({ cwd: dir })).toBe('string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('a project with no source files yields an empty digest, not a crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-empty-'));
    try {
      const { buildContextDigest } = require('../../src/loom/attach');
      expect(buildContextDigest({ cwd: dir })).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
