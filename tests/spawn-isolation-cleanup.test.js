// tests/spawn-isolation-cleanup.test.js — per-instance task files + cleanup.
//
// Verifies the user-reported concern: multiple children in the SAME cwd must
// each get their OWN task file (no shared/colliding file), and each child's
// artifacts (task file + session dir) must be cleaned up on kill / when orphaned.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-iso-home-'));
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-iso-cwd-'));
process.env.FORGE_HOME = TMP_HOME;
process.env.FORGE_SPAWN_NO_WINDOW = '1';

const sup = require('../src/agent-supervisor');
const reg = require('../src/session-registry');
const spawnTask = require('../src/spawn-task');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(TMP_CWD, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_SPAWN_NO_WINDOW;
});

describe('instanceTaskPath', () => {
  test('prefers an explicit taskFile', () => {
    expect(spawnTask.instanceTaskPath({ taskFile: '/x/y.md' })).toBe(path.resolve('/x/y.md'));
  });

  test('uses the session dir when provided (unique per instance)', () => {
    const p = spawnTask.instanceTaskPath({ sessionDir: '/home/sessions/a', identifier: 'forge-a-1' });
    expect(p).toBe(path.join(path.resolve('/home/sessions/a'), 'SESSION_TASK.md'));
  });

  test('falls back to <dir>/<identifier>.SESSION_TASK.md', () => {
    const p = spawnTask.instanceTaskPath({ dir: TMP_CWD, identifier: 'forge-b-2' });
    expect(p).toContain('forge-b-2.SESSION_TASK.md');
  });
});

describe('two children in the same cwd never share a task file', () => {
  test('distinct task files + isolated progress', async () => {
    const a = 'iso-a-' + Date.now().toString(36);
    const b = 'iso-b-' + Date.now().toString(36);

    const ia = sup.spawnAgent({ session: a, task: '--help', cwd: TMP_CWD, noWindow: true, subtasks: ['a1', 'a2'] });
    const ib = sup.spawnAgent({ session: b, task: '--help', cwd: TMP_CWD, noWindow: true, subtasks: ['b1', 'b2'] });

    // Distinct, non-shared task files.
    expect(ia.taskFile).not.toBe(ib.taskFile);
    expect(fs.existsSync(ia.taskFile)).toBe(true);
    expect(fs.existsSync(ib.taskFile)).toBe(true);

    // No stray shared SESSION_TASK.md in the cwd.
    expect(fs.existsSync(path.join(TMP_CWD, 'SESSION_TASK.md'))).toBe(false);

    // Progress is isolated: mark A's subtask, B's file must be unaffected.
    spawnTask.markSubtaskDone(ia.taskFile, 'a1');
    const pa = sup.readChildTask(a);
    const pb = sup.readChildTask(b);
    expect(pa.done).toBe(1);
    expect(pb.done).toBe(0);

    await sleep(500);
    await sup.killChild(a, { graceMs: 3000 });
    await sup.killChild(b, { graceMs: 3000 });
  }, 30000);
});

describe('cleanup lifecycle', () => {
  test('cleanupChild removes task file + session dir + heartbeat file', async () => {
    const s = 'cln-' + Date.now().toString(36);
    const info = sup.spawnAgent({ session: s, task: '--help', cwd: TMP_CWD, noWindow: true });
    expect(fs.existsSync(info.taskFile)).toBe(true);

    const inst = sup.findChild(s);
    const dir = inst.sessionDir;
    const hb = reg.heartbeatFileFor(inst.id);

    const res = sup.cleanupChild(inst);
    expect(res.removed).toBe(true);
    expect(fs.existsSync(info.taskFile)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(hb)).toBe(false);

    await sleep(300);
    // Best-effort kill in case the headless child lingers.
    try { await sup.killChild(s, { graceMs: 1500 }); } catch (_) {}
  }, 30000);

  test('killChild cleans up by default after stopping a child', async () => {
    const s = 'killcln-' + Date.now().toString(36);
    const info = sup.spawnAgent({ session: s, task: '--help', cwd: TMP_CWD, noWindow: true });
    await sleep(600);
    const res = await sup.killChild(s, { graceMs: 3000 });
    expect(res.ok).toBe(true);
    // The per-instance task file should be gone after kill cleanup.
    expect(fs.existsSync(info.taskFile)).toBe(false);
  }, 30000);

  test('killChild with cleanup:false keeps the task file', async () => {
    const s = 'keep-' + Date.now().toString(36);
    const info = sup.spawnAgent({ session: s, task: '--help', cwd: TMP_CWD, noWindow: true });
    await sleep(600);
    const res = await sup.killChild(s, { graceMs: 3000, cleanup: false });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(info.taskFile)).toBe(true);
    // Manual cleanup to tidy up.
    try { sup.cleanupChild(sup.findChild(s)); } catch (_) {}
  }, 30000);

  test('pruneOrphans removes dead children but not live ones', async () => {
    // A dead fake child (pid that does not exist).
    const deadName = 'orphan-' + Date.now().toString(36);
    const dir = reg.sessionDirFor(deadName);
    fs.mkdirSync(dir, { recursive: true });
    const tf = path.join(dir, 'SESSION_TASK.md');
    fs.writeFileSync(tf, 'x', 'utf8');
    const hb = reg.heartbeatFileFor(deadName);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({
      id: deadName, name: deadName, pid: 999999, sessionDir: dir, taskFile: tf,
      status: 'running', startedAt: Date.now(), lastHeartbeat: Date.now(),
    }), 'utf8');

    // A live child (our own pid).
    const liveName = 'livekeep-' + Date.now().toString(36);
    const liveDir = reg.sessionDirFor(liveName);
    fs.mkdirSync(liveDir, { recursive: true });
    const liveHb = reg.heartbeatFileFor(liveName);
    fs.writeFileSync(liveHb, JSON.stringify({
      id: liveName, name: liveName, pid: process.pid, sessionDir: liveDir,
      status: 'running', startedAt: Date.now(), lastHeartbeat: Date.now(),
    }), 'utf8');

    const res = sup.pruneOrphans();
    expect(res.pruned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(hb)).toBe(false);
    // Live one preserved.
    expect(fs.existsSync(liveDir)).toBe(true);
    expect(fs.existsSync(liveHb)).toBe(true);
  });
});
