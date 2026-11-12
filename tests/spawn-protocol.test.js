// tests/spawn-protocol.test.js — Parent/child spawn protocol (docs/SPAWN_PROTOCOL.md)
//
// Covers: liveness classification (running/unresponsive/dead), heartbeat TTL,
// parent-child relationship fields in the registry, identifier format, tree
// building for UI, and the kill resolution/classification logic.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proto-'));
process.env.FORGE_HOME = TMP;

let reg;
let sup;

beforeEach(() => {
  jest.resetModules();
  // Clear any registry records left by previous tests.
  try { fs.rmSync(path.join(TMP, 'instances'), { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(path.join(TMP, 'sessions'), { recursive: true, force: true }); } catch (_) {}
  reg = require('../src/session-registry');
  sup = require('../src/agent-supervisor');
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_HEARTBEAT_TTL_MS;
  delete process.env.FORGE_HEARTBEAT_INTERVAL_MS;
});

function writeRecord(name, extra) {
  const file = reg.heartbeatFileFor(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = Object.assign({
    id: name, name, identifier: 'forge-' + name + '-1', role: name,
    pid: process.pid, ppid: 1, parentId: null, parentPid: null, isChild: false,
    cwd: process.cwd(), status: 'running',
    startedAt: Date.now() - 1000, lastHeartbeat: Date.now(),
    sessionDir: reg.sessionDirFor(name), argv: '',
  }, extra || {});
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

describe('heartbeat TTL + classification', () => {
  test('default interval and TTL', () => {
    expect(reg.heartbeatIntervalMs()).toBe(5000);
    expect(reg.heartbeatTtlMs()).toBe(20000);
  });

  test('env overrides interval and TTL', () => {
    process.env.FORGE_HEARTBEAT_INTERVAL_MS = '2000';
    process.env.FORGE_HEARTBEAT_TTL_MS = '8000';
    expect(reg.heartbeatIntervalMs()).toBe(2000);
    expect(reg.heartbeatTtlMs()).toBe(8000);
  });

  test('classifyInstance: alive + fresh => running', () => {
    const r = { pid: process.pid, lastHeartbeat: Date.now() };
    expect(reg.classifyInstance(r, { now: Date.now(), ttl: 20000 })).toBe('running');
  });

  test('classifyInstance: alive + stale => unresponsive', () => {
    const now = Date.now();
    const r = { pid: process.pid, lastHeartbeat: now - 30000 };
    expect(reg.classifyInstance(r, { now, ttl: 20000 })).toBe('unresponsive');
  });

  test('classifyInstance: dead pid => dead', () => {
    const r = { pid: 999999, lastHeartbeat: Date.now() };
    expect(reg.classifyInstance(r)).toBe('dead');
  });

  test('listInstances exposes state + beatAge', () => {
    writeRecord('proto-live', { lastHeartbeat: Date.now() });
    const list = reg.listInstances({ includeDead: true });
    const inst = list.find(i => i.id === 'proto-live');
    expect(inst).toBeTruthy();
    expect(inst.state).toBe('running');
    expect(typeof inst.beatAge).toBe('string');
  });

  test('listInstances marks a stale heartbeat as unresponsive', () => {
    writeRecord('proto-stale', { lastHeartbeat: Date.now() - 60000 });
    const list = reg.listInstances({ includeDead: true });
    const inst = list.find(i => i.id === 'proto-stale');
    expect(inst.state).toBe('unresponsive');
  });
});

describe('parent-child relationship', () => {
  test('writeHeartbeat records parent + identifier from env', () => {
    const prev = { ...process.env };
    process.env.FORGE_SESSION_NAME = 'child-a';
    process.env.FORGE_PARENT_ID = 'parent-x';
    process.env.FORGE_PARENT_PID = String(process.pid);
    process.env.FORGE_CHILD_ID = 'forge-child-a-123';
    try {
      const rec = reg.writeHeartbeat({ status: 'running' });
      expect(rec.parentId).toBe('parent-x');
      expect(rec.parentPid).toBe(process.pid);
      expect(rec.isChild).toBe(true);
      expect(rec.identifier).toBe('forge-child-a-123');
    } finally {
      delete process.env.FORGE_SESSION_NAME;
      delete process.env.FORGE_PARENT_ID;
      delete process.env.FORGE_PARENT_PID;
      delete process.env.FORGE_CHILD_ID;
    }
  });

  test('buildInstanceTree nests children under their parent', () => {
    const parentPid = 11111;
    const list = [
      { id: 'p', pid: parentPid, parentPid: null, parentId: null },
      { id: 'c1', pid: 22222, parentPid: parentPid, parentId: 'p' },
      { id: 'c2', pid: 33333, parentPid: parentPid, parentId: 'p' },
    ];
    const tree = reg.buildInstanceTree(list);
    expect(tree.length).toBe(1);
    expect(tree[0].record.id).toBe('p');
    expect(tree[0].children.length).toBe(2);
  });

  test('buildInstanceTree treats orphans as roots', () => {
    const list = [
      { id: 'orphan', pid: 44444, parentPid: 99999, parentId: 'gone' },
    ];
    const tree = reg.buildInstanceTree(list);
    expect(tree.length).toBe(1);
    expect(tree[0].record.id).toBe('orphan');
  });
});

describe('formatInstanceTable (relationship columns)', () => {
  test('renders PARENT and BEAT columns and root/child counts', () => {
    writeRecord('tbl-parent', { pid: process.pid });
    writeRecord('tbl-child', {
      pid: process.pid, parentPid: process.pid, parentId: 'tbl-parent', isChild: true,
    });
    const list = reg.listInstances({ includeDead: true })
      .filter(i => i.id === 'tbl-parent' || i.id === 'tbl-child');
    const table = reg.formatInstanceTable(list, false);
    expect(table).toMatch(/PARENT/);
    expect(table).toMatch(/BEAT/);
    expect(table).toMatch(/tbl-parent/);
    expect(table).toMatch(/1 root, 1 child/);
  });
});

describe('killChild resolution + safety', () => {
  test('unknown instance resolves to an error', async () => {
    const res = await sup.killChild('nope-xyz');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No matching/);
  });

  test('an already-dead known instance returns ok alreadyDead', async () => {
    writeRecord('dead-child', { pid: 999999 });
    const res = await sup.killChild('dead-child', { graceMs: 200 });
    expect(res.ok).toBe(true);
    expect(res.alreadyDead).toBe(true);
  });

  test('numeric PID of an unknown process requires force', async () => {
    const res = await sup.killChild(999999, { graceMs: 100 });
    // PID is not a known Forge instance: refuse unless force.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a known Forge instance/);
  });
});

describe('spawnAgent identifier + task file', () => {
  test('spawnAgent requires session and task', () => {
    expect(() => sup.spawnAgent({ task: 'x' })).toThrow(/session/);
    expect(() => sup.spawnAgent({ session: 's' })).toThrow(/task/);
  });

  test('findChild resolves by identifier and unique prefix', () => {
    writeRecord('fnd', { identifier: 'forge-fnd-777', pid: process.pid });
    expect(sup.findChild('forge-fnd-777')).toBeTruthy();
    expect(sup.findChild('fnd')).toBeTruthy();
  });

  test('readChildTask parses an existing task file', () => {
    const spawnTask = require('../src/spawn-task');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rt-'));
    const res = spawnTask.writeTaskFile({
      dir, identifier: 'forge-rt-1', task: 't', subtasks: ['a', 'b'],
    });
    writeRecord('rt-child', { identifier: 'forge-rt-1', pid: process.pid, taskFile: res.path });
    const parsed = sup.readChildTask('rt-child');
    expect(parsed).toBeTruthy();
    expect(parsed.total).toBe(2);
    expect(parsed.done).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('killChild edge cases', () => {
  test('ambiguous prefix resolves to null (not a crash)', () => {
    writeRecord('amb-aa', { pid: process.pid });
    writeRecord('amb-ab', { pid: process.pid });
    expect(sup.findChild('amb-a')).toBeNull();
  });

  test('malformed registry JSON is tolerated by listInstances', () => {
    const file = reg.heartbeatFileFor('bad-json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not valid json', 'utf8');
    expect(() => reg.listInstances({ includeDead: true })).not.toThrow();
  });
});
