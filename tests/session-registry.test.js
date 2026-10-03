// tests/session-registry.test.js — Items 1 & 6: unique names + instance registry
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect FORGE_HOME to a throwaway dir BEFORE loading the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reg-'));
process.env.FORGE_HOME = TMP;

describe('session-registry', () => {
  let reg;

  beforeEach(() => {
    jest.resetModules();
    reg = require('../src/session-registry');
  });

  afterAll(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    delete process.env.FORGE_HOME;
  });

  test('sessionsRoot lives under FORGE_HOME', () => {
    expect(reg.sessionsRoot()).toBe(path.join(TMP, 'sessions'));
  });

  test('generateSessionName is human-readable and unique-shaped', () => {
    const name = reg.generateSessionName();
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  });

  test('generateSessionName avoids names whose dir already exists', () => {
    const first = reg.generateSessionName();
    fs.mkdirSync(reg.sessionDirFor(first), { recursive: true });
    // Generate many; none should equal the taken one.
    for (let i = 0; i < 200; i++) {
      expect(reg.generateSessionName()).not.toBe(first);
    }
  });

  test('writeHeartbeat records pid, name, and timestamp', () => {
    process.env.FORGE_SESSION_NAME = 'brave-otter-9f3a';
    process.env.FORGE_SESSION_DIR = reg.sessionDirFor('brave-otter-9f3a');
    process.env.FORGE_ROLE = 'brave-otter-9f3a';
    const rec = reg.writeHeartbeat({ model: 'deepseek', status: 'running' });
    expect(rec).toBeTruthy();
    expect(rec.pid).toBe(process.pid);
    expect(rec.name).toBe('brave-otter-9f3a');
    expect(rec.model).toBe('deepseek');
    expect(typeof rec.startedAt).toBe('number');
    const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.FORGE_SESSION_DIR, 'instance.json'), 'utf8'));
    expect(onDisk.pid).toBe(process.pid);
  });

  test('listInstances finds live instances and skips untracked dirs', () => {
    process.env.FORGE_SESSION_NAME = 'live-one';
    process.env.FORGE_SESSION_DIR = reg.sessionDirFor('live-one');
    reg.writeHeartbeat({ model: 'deepseek' });

    // A dir with no instance.json must be ignored.
    fs.mkdirSync(reg.sessionDirFor('no-heartbeat'), { recursive: true });

    const list = reg.listInstances();
    const live = list.find(i => i.name === 'live-one');
    expect(live).toBeTruthy();
    expect(live.alive).toBe(true);
    expect(live.pid).toBe(process.pid);
    // The directory without an instance.json must NOT appear.
    expect(list.find(i => i.name === 'no-heartbeat')).toBeUndefined();
  });
});

describe('session-registry — liveness & lookup', () => {
  let reg;

  beforeEach(() => {
    jest.resetModules();
    reg = require('../src/session-registry');
  });

  function writeFakeInstance(name, pid) {
    const dir = reg.sessionDirFor(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({
      id: name, name, role: name, pid, cwd: process.cwd(),
      status: 'running', startedAt: Date.now() - 5000, lastHeartbeat: Date.now(),
    }), 'utf8');
  }

  test('isPidAlive reports true for our own pid, false for an unused pid', () => {
    expect(reg.isPidAlive(process.pid)).toBe(true);
    expect(reg.isPidAlive(999999)).toBe(false);
  });

  test('listInstances hides dead instances by default', () => {
    writeFakeInstance('dead-one', 999999);
    const live = reg.listInstances();
    expect(live.find(i => i.name === 'dead-one')).toBeUndefined();
  });

  test('listInstances can include dead instances', () => {
    writeFakeInstance('dead-two', 999999);
    const all = reg.listInstances({ includeDead: true });
    const found = all.find(i => i.name === 'dead-two');
    expect(found).toBeTruthy();
    expect(found.alive).toBe(false);
  });

  test('prune deletes stale instance.json files', () => {
    writeFakeInstance('stale-one', 999999);
    reg.listInstances({ prune: true });
    const file = path.join(reg.sessionDirFor('stale-one'), 'instance.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('findInstance resolves an exact name', () => {
    writeFakeInstance('find-me', process.pid);
    const found = reg.findInstance('find-me');
    expect(found).toBeTruthy();
    expect(found.name).toBe('find-me');
  });

  test('formatInstanceTable renders a header and rows', () => {
    writeFakeInstance('tbl-row', process.pid);
    const list = reg.listInstances();
    const table = reg.formatInstanceTable(list, false);
    expect(table).toContain('ID/NAME');
    expect(table).toContain('tbl-row');
    expect(table).toContain('running');
  });

  test('formatInstanceTable handles the empty case', () => {
    const table = reg.formatInstanceTable([], false);
    expect(table).toContain('No running instances');
  });

  test('removeHeartbeat deletes this instance record', () => {
    process.env.FORGE_SESSION_NAME = 'rm-me';
    process.env.FORGE_SESSION_DIR = reg.sessionDirFor('rm-me');
    reg.writeHeartbeat({});
    const file = path.join(process.env.FORGE_SESSION_DIR, 'instance.json');
    expect(fs.existsSync(file)).toBe(true);
    reg.removeHeartbeat();
    expect(fs.existsSync(file)).toBe(false);
  });
});
