// tests/tools-spawn.test.js — agent-facing spawn_agent / list_agents / kill_agent tools.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-toolhome-'));
const TMP_WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-toolwork-'));

async function waitForHeartbeat(session, TOOLS, sleep, timeoutMs = 8000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await TOOLS.list_agents.execute({});
    if (last.includes(session)) return last;
    await sleep(150);
  }
  return last; // return whatever we last saw; the assertion will fail with a real reason
}

process.env.FORGE_HOME = TMP_HOME;
process.env.FORGE_SPAWN_NO_WINDOW = '1';
process.env._DSA_TEST_DIR = TMP_WORK;

jest.mock('../src/config', () => ({
  WORKING_DIR: process.env._DSA_TEST_DIR,
  MAX_OUTPUT_LENGTH: 8000,
  SESSION_DIR: require('path').join(require('os').tmpdir(), 'dsa-tool-session'),
  DEBUG: false,
}));

const { TOOLS } = require('../src/tools');
const sup = require('../src/agent-supervisor');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(TMP_WORK, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_SPAWN_NO_WINDOW;
  delete process.env._DSA_TEST_DIR;
});

describe('spawn_agent tool', () => {
  test('reports a failure when session is missing', async () => {
    const out = await TOOLS.spawn_agent.execute({ task: 'x' });
    expect(out).toMatch(/Failed to spawn/);
  });

  test('spawns headless, prints identifier/window/task-file, then kills', async () => {
    const session = 'tool-worker-' + Date.now().toString(36);
    const out = await TOOLS.spawn_agent.execute({
      session, task: '--help', noWindow: true, subtasks: ['a', 'b'],
    });
    expect(out).toMatch(/Spawned child agent/);
    expect(out).toMatch(/identifier: forge-/);
    expect(out).toMatch(/window\s*: headless/);
    expect(out).toMatch(/task file/);

    await sleep(800);
    const kill = await TOOLS.kill_agent.execute({ name: session });
    expect(kill).toMatch(/Stopped child agent/);
  }, 30000);
});

describe('list_agents tool', () => {
  test('renders a table including PARENT and BEAT columns', async () => {
    const session = 'tool-list-' + Date.now().toString(36);
    sup.spawnAgent({ session, task: '--help', noWindow: true });
    const table = await waitForHeartbeat(session, TOOLS, sleep);
    expect(table).toMatch(/PARENT/);
    expect(table).toMatch(/BEAT/);
    expect(table).toContain(session);
    await sup.killChild(session, { graceMs: 3000 });
  }, 30000);

  test('json:true emits machine-readable records with parent fields', async () => {
    const session = 'tool-json-' + Date.now().toString(36);
    sup.spawnAgent({ session, task: '--help', noWindow: true });
    // Poll until the child's heartbeat is visible (same reason as above).
    {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const probe = JSON.parse(await TOOLS.list_agents.execute({ json: true }));
        if (Array.isArray(probe) && probe.some(r => r.id === session)) break;
        await sleep(150);
      }
    }
    const out = await TOOLS.list_agents.execute({ json: true });
    const arr = JSON.parse(out);
    expect(Array.isArray(arr)).toBe(true);
    const rec = arr.find(r => r.id === session);
    expect(rec).toBeTruthy();
    expect(rec).toHaveProperty('identifier');
    expect(rec).toHaveProperty('isChild');
    expect(rec).toHaveProperty('parentPid');
    await sup.killChild(session, { graceMs: 3000 });
  }, 30000);
});

describe('kill_agent tool', () => {
  test('reports unknown name gracefully', async () => {
    const out = await TOOLS.kill_agent.execute({ name: 'no-such-agent-zzz' });
    expect(out).toMatch(/Could not stop child/);
  });

  test('accepts a numeric PID string and refuses non-Forge PID without force', async () => {
    const out = await TOOLS.kill_agent.execute({ name: '999999' });
    expect(out).toMatch(/Could not stop child/);
    expect(out).toMatch(/not a known Forge instance/);
  });
});

describe('read_agent_task tool', () => {
  test('reports a clear message for an unknown child', async () => {
    const out = await TOOLS.read_agent_task.execute({ name: 'no-such-child-xyz' });
    expect(out).toMatch(/No task file found/);
  });

  test('reads a spawned child task progress (subtasks + log)', async () => {
    const session = 'tool-readtask-' + Date.now().toString(36);
    await TOOLS.spawn_agent.execute({
      session, task: '--help', noWindow: true, subtasks: ['alpha', 'beta'],
    });
    await sleep(400);

    const sup2 = require('../src/agent-supervisor');
    const inst = sup2.findChild(session);
    const spawnTask = require('../src/spawn-task');
    spawnTask.markSubtaskDone(inst.taskFile, 'alpha');

    const out = await TOOLS.read_agent_task.execute({ name: session });
    expect(out).toMatch(/Progress : 1\/2 subtasks done/);
    expect(out).toMatch(/\[x\] alpha/);
    expect(out).toMatch(/\[ \] beta/);

    await sup2.killChild(session, { graceMs: 3000 });
  }, 30000);
});

describe('read_agent_task tool', () => {
  test('reports a clear message for an unknown child', async () => {
    const out = await TOOLS.read_agent_task.execute({ name: 'no-such-child-xyz' });
    expect(out).toMatch(/No task file found/);
  });

  test('reads a spawned child task progress (subtasks + log)', async () => {
    const session = 'tool-readtask-' + Date.now().toString(36);
    await TOOLS.spawn_agent.execute({
      session, task: '--help', noWindow: true, subtasks: ['alpha', 'beta'],
    });
    await sleep(400);

    const sup2 = require('../src/agent-supervisor');
    const inst = sup2.findChild(session);
    const spawnTask = require('../src/spawn-task');
    spawnTask.markSubtaskDone(inst.taskFile, 'alpha');

    const out = await TOOLS.read_agent_task.execute({ name: session });
    expect(out).toMatch(/Progress : 1\/2 subtasks done/);
    expect(out).toMatch(/\[x\] alpha/);
    expect(out).toMatch(/\[ \] beta/);

    await sup2.killChild(session, { graceMs: 3000 });
  }, 30000);
});
