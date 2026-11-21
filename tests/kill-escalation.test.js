// tests/kill-escalation.test.js — graceful → force escalation on a stubborn child.
//
// Spawns a real node process that IGNORES SIGTERM (POSIX) / is hard to stop on
// win32, registers it as a Forge instance, and verifies killChild escalates to
// force when the graceful terminate is not enough. Skipped on win32 for the
// SIGTERM-ignoring part because taskkill semantics differ; the resolution and
// safety paths are covered elsewhere.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kill-'));
process.env.FORGE_HOME = TMP;

const sup = require('../src/agent-supervisor');
const registry = require('../src/session-registry');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Poll until `predicate()` is true, or fail.
 *
 * Replaces fixed sleeps: a 300 ms sleep raced the child's startup, so on a
 * loaded machine the SIGTERM handler was not installed yet, the child died
 * gracefully and `escalated` came back false. That was the flake.
 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Spawn a node child that ignores SIGTERM and report readiness through a file,
 * so the test never races the handler installation.
 */
function spawnStubborn(name) {
  const ready = path.join(TMP, name + '.ready');
  const child = spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});' +
    `require("fs").writeFileSync(${JSON.stringify(ready)},"1");` +
    'setInterval(()=>{},1000);'],
    { stdio: 'ignore', detached: true });
  child.unref();
  return { child, pid: child.pid, ready };
}

function register(name, pid) {
  const file = registry.heartbeatFileFor(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id: name, name, identifier: 'forge-' + name + '-' + pid, role: name,
    pid, ppid: process.pid, parentId: null, parentPid: null, isChild: true,
    cwd: process.cwd(), status: 'running',
    startedAt: Date.now(), lastHeartbeat: Date.now(),
    sessionDir: registry.sessionDirFor(name), argv: '',
  }, null, 2), 'utf8');
}

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
});

describe('killChild force escalation', () => {
  const isPosix = process.platform !== 'win32';
  const maybe = isPosix ? test : test.skip;

  maybe('force-kills a child that ignores SIGTERM', async () => {
    const name = 'stubborn-' + Date.now().toString(36);
    const { pid, ready } = spawnStubborn(name);
    register(name, pid);

    // Wait for the child to install its SIGTERM handler before killing it.
    await waitFor(() => fs.existsSync(ready), { label: 'child readiness' });
    expect(registry.isPidAlive(pid)).toBe(true);

    const res = await sup.killChild(name, { graceMs: 800 });
    expect(res.ok).toBe(true);
    expect(res.escalated).toBe(true);

    await waitFor(() => !registry.isPidAlive(pid), { label: 'child exit' });
    expect(registry.isPidAlive(pid)).toBe(false);
  }, 30000);

  maybe('graceful terminate succeeds for a normal child', async () => {
    const name = 'normal-' + Date.now().toString(36);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'],
      { stdio: 'ignore', detached: true });
    child.unref();
    const pid = child.pid;
    register(name, pid);

    await sleep(300);
    const res = await sup.killChild(name, { graceMs: 3000 });
    expect(res.ok).toBe(true);
    expect(res.escalated).toBe(false);
  }, 30000);
});
