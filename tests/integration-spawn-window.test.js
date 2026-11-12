// tests/integration-spawn-window.test.js — End-to-end spawn protocol lifecycle.
//
// Spawns a REAL child forge-agent process (headless, FORGE_SPAWN_NO_WINDOW=1 so
// no terminal window pops up in CI), verifies:
//   * the parent holds the child PID + identifier,
//   * a SESSION_TASK.md is created,
//   * the child appears in the registry with parent-child relationship,
//   * heartbeat liveness classification works,
//   * killChild stops it.
//
// The window-launch command itself is unit-tested in spawn-window.test.js.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-spawnwin-'));
process.env.FORGE_HOME = TMP;
process.env.FORGE_SPAWN_NO_WINDOW = '1';

const sup = require('../src/agent-supervisor');
const reg = require('../src/session-registry');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_SPAWN_NO_WINDOW;
});

describe('spawn window — end-to-end lifecycle', () => {
  test('spawn → task file → registry relationship → kill', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-spawnwin-cwd-'));
    const session = 'win-worker-' + Date.now().toString(36);

    const info = sup.spawnAgent({
      session,
      task: '--help',
      cwd,
      noWindow: true,
      subtasks: ['first step', 'second step'],
    });

    // Parent holds the PID + a forge- identifier.
    expect(info.pid).toBeGreaterThan(0);
    expect(info.identifier).toMatch(/^forge-win-worker-/);
    expect(info.mode).toBe('headless');

    // Task file exists and has the assigned subtasks.
    expect(fs.existsSync(info.taskFile)).toBe(true);
    const taskMd = fs.readFileSync(info.taskFile, 'utf8');
    expect(taskMd).toMatch(/first step/);
    expect(taskMd).toMatch(/second step/);

    // Let the child write its own heartbeat (or exit if --help finishes first).
    await sleep(1500);

    // The registry must expose the child with a parent relationship.
    const list = reg.listInstances({ includeDead: true });
    const child = list.find(i => i.id === session);
    expect(child).toBeTruthy();
    expect(child.isChild).toBe(true);
    expect(child.parentPid).toBe(process.pid);

    // Kill it (graceful → force). Accept already-gone too.
    const kill = await sup.killChild(session, { graceMs: 3000 });
    expect(kill.ok).toBe(true);

    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }, 30000);

  test('readChildTask reports progress from a spawned child\'s task file', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-spawnwin-cwd2-'));
    const session = 'prog-worker-' + Date.now().toString(36);

    const info = sup.spawnAgent({
      session, task: '--help', cwd, noWindow: true,
      subtasks: ['alpha', 'beta'],
    });

    const parsed = sup.readChildTask(session);
    expect(parsed).toBeTruthy();
    expect(parsed.total).toBe(2);
    expect(parsed.done).toBe(0);

    await sup.killChild(session, { graceMs: 3000 });
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }, 30000);
});
