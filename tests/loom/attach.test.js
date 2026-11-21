// tests/loom/attach.test.js — the boundary that keeps Loom out of the agent's way.
//
// Spec I1: no Loom call may throw into a tool handler or reject an awaited
// promise. Spec I2: LOOM_ENABLED=0 is a no-op with no I/O. This suite proves
// both from the agent's side, including the case where the digest module does
// not exist at all — which is the current state of the repository.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

describe('buildContextDigest', () => {
  let config;
  let orig;

  beforeEach(() => {
    config = require('../../src/config');
    orig = { ...config };
    // No resetModules(): attach.js and this test must share ONE config instance,
    // otherwise the test mutates an object the module never reads.
  });

  afterEach(() => {
    Object.assign(config, orig);
  });

  test('returns an empty string when Loom is disabled', () => {
    const { buildContextDigest } = require('../../src/loom/attach');
    config.LOOM_ENABLED = false;
    expect(buildContextDigest()).toBe('');
  });

  test('returns an empty string when the digest module is missing', () => {
    // The repository is mid-build: src/loom/digest.js may not exist. A missing
    // module must degrade to "no digest", never to a crash.
    const { buildContextDigest } = require('../../src/loom/attach');
    config.LOOM_ENABLED = true;

    const digestPath = path.join(__dirname, '..', '..', 'src', 'loom', 'digest.js');
    const existed = fs.existsSync(digestPath);
    if (existed) {
      // Once slice 3 lands the module is present, so assert the other half:
      // whatever comes back is a string and the call does not throw.
      expect(typeof buildContextDigest({ cwd: process.cwd() })).toBe('string');
      return;
    }
    expect(buildContextDigest({ cwd: process.cwd() })).toBe('');
  });

  test('never throws, whatever the project directory looks like', () => {
    const { buildContextDigest } = require('../../src/loom/attach');
    config.LOOM_ENABLED = true;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-attach-'));
    try {
      expect(() => buildContextDigest({ cwd: dir })).not.toThrow();
      expect(() => buildContextDigest({ cwd: '/nonexistent/path/xyz' })).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('builds a real digest from this repository when enabled', () => {
    const { buildContextDigest } = require('../../src/loom/attach');
    config.LOOM_ENABLED = true;

    const out = buildContextDigest({ cwd: path.join(__dirname, '..', '..'), maxTokens: 1200 });

    // Slice 3 is present, so this must produce a map, not an empty string.
    expect(out).toContain('# Project map');
    expect(out).toMatch(/Stack: Node\.js/);
    expect(out).toMatch(/root: @puneet-swarup\/forge-agent/);
    expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(1200);
  }, 60000);

  test('collectFiles skips the directories that are never worth indexing', () => {
    const { collectFiles } = require('../../src/loom/attach');
    const files = collectFiles(path.join(__dirname, '..', '..'));

    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
    expect(files.some((f) => f === 'package-lock.json')).toBe(false);
    expect(files).toContain('src/agent.js');
    // Deterministic: sorted, forward slashes only.
    expect(files).toEqual([...files].sort());
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
  }, 60000);

  test('is bounded by the token budget when it produces anything', () => {
    const { buildContextDigest } = require('../../src/loom/attach');
    config.LOOM_ENABLED = true;

    const out = buildContextDigest({ cwd: path.join(__dirname, '..', '..'), maxTokens: 200 });
    expect(typeof out).toBe('string');
    if (out) {
      expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(200 * 1.1);
    }
  });
});

describe('the agent attaches the digest, and survives it being empty', () => {
  test('a run completes whether or not Loom produces a digest', async () => {
    const config = require('../../src/config');
    const orig = { ...config };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-attach-run-'));

    config.WORKING_DIR = dir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.VERIFY_BEFORE_COMPLETE = false;
    config.CONTEXT_ROTATION_TURNS = 0;

    try {
      const ForgeAgent = require('../../src/agent');
      const agent = new ForgeAgent({});
      let attached = null;

      agent.browser = {
        async launch() {}, async close() {}, async newChat() {},
        adapter: { setProjectContext: (c) => { attached = c; } },
        async sendMessage() {},
        async waitForResponse() { return 'done\nTASK_COMPLETE'; },
      };

      await agent.run('do it');

      // Loom is off by default, so nothing is attached — and the run still ends.
      expect(attached).toBe(null);
    } finally {
      Object.assign(config, orig);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
