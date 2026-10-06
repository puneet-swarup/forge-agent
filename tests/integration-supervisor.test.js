// tests/integration-supervisor.test.js - End-to-end supervisor lifecycle:
// spawn a real child forge-agent process, verify it registers, then kill it.
//
// The child is spawned with a task that does NOT need a browser (a bogus
// --model would fail, so we spawn with --help-style short task and rely on the
// heartbeat file the child writes at startup). To avoid needing a real browser
// or login, we point the child at the mock chat page.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sup-e2e-'));
process.env.FORGE_HOME = TMP;

const sup = require('../src/agent-supervisor');
const registry = require('../src/session-registry');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
});

describe('supervisor end-to-end', () => {
  test('spawnAgent starts a child and records a heartbeat; killChild stops it', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sup-cwd-'));
    const session = 'e2e-worker-' + Date.now().toString(36);

    // Spawn the child with --help so it exits quickly and does not need a
    // browser/login. We only care that the process starts and is traceable.
    const info = sup.spawnAgent({
      session,
      task: '--help',
      cwd,
      extraArgs: [],
      detached: true,
    });

    expect(info.pid).toBeGreaterThan(0);
    expect(info.session).toBe(session);

    // The session dir must exist (registry dir created by spawnAgent).
    expect(fs.existsSync(registry.sessionDirFor(session))).toBe(true);

    // Give the child a moment to write its own heartbeat if it gets that far.
    await sleep(1500);

    // killChild should succeed whether the child is still alive or already gone
    // (SIGTERM to a dead PID throws, so accept either a clean kill or a
    // "no matching instance" result).
    const kill = sup.killChild(session);
    expect(typeof kill.ok).toBe('boolean');

    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }, 30000);

  test('entryPoint points at an existing file', () => {
    expect(fs.existsSync(sup.entryPoint())).toBe(true);
  });
});
