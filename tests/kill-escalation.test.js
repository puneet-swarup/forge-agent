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
    // A node process that ignores SIGTERM and stays alive.
    const child = spawn(process.execPath, ['-e',
      'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'],
      { stdio: 'ignore', detached: true });
    child.unref();
    const pid = child.pid;
    register(name, pid);

    await sleep(300);
    expect(registry.isPidAlive(pid)).toBe(true);

    const res = await sup.killChild(name, { graceMs: 800 });
    expect(res.ok).toBe(true);
    expect(res.escalated).toBe(true);
    await sleep(300);
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
