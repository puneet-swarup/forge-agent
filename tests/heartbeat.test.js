// tests/heartbeat.test.js — periodic self-heartbeat loop (src/heartbeat.js)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hb-'));
process.env.FORGE_HOME = TMP;

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_SESSION_NAME;
  delete process.env.FORGE_SESSION_DIR;
  delete process.env.FORGE_HEARTBEAT_INTERVAL_MS;
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('heartbeat module', () => {
  let heartbeat;
  let registry;

  beforeEach(() => {
    jest.resetModules();
    heartbeat = require('../src/heartbeat');
    registry = require('../src/session-registry');
    process.env.FORGE_SESSION_NAME = 'hb-' + Date.now().toString(36);
    delete process.env.FORGE_SESSION_DIR;
  });

  afterEach(() => {
    heartbeat.stop();
  });

  test('start writes an immediate heartbeat', () => {
    const handle = heartbeat.start({ status: 'running' });
    expect(handle).toHaveProperty('beat');
    expect(heartbeat.isRunning()).toBe(true);
    const file = registry.heartbeatFileFor(process.env.FORGE_SESSION_NAME);
    expect(fs.existsSync(file)).toBe(true);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.status).toBe('running');
  });

  test('stop clears the timer', () => {
    heartbeat.start({ intervalMs: 1000 });
    expect(heartbeat.isRunning()).toBe(true);
    heartbeat.stop();
    expect(heartbeat.isRunning()).toBe(false);
  });

  test('setStatus changes the status written on the next beat', async () => {
    process.env.FORGE_HEARTBEAT_INTERVAL_MS = '50';
    heartbeat.start({ intervalMs: 50, status: 'starting' });
    heartbeat.setStatus('running');
    await sleep(120);
    const file = registry.heartbeatFileFor(process.env.FORGE_SESSION_NAME);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.status).toBe('running');
  });

  test('interval beats refresh lastHeartbeat', async () => {
    heartbeat.start({ intervalMs: 50, status: 'running' });
    const file = registry.heartbeatFileFor(process.env.FORGE_SESSION_NAME);
    const first = JSON.parse(fs.readFileSync(file, 'utf8')).lastHeartbeat;
    await sleep(120);
    const second = JSON.parse(fs.readFileSync(file, 'utf8')).lastHeartbeat;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test('start replaces an existing loop (no double timers)', () => {
    heartbeat.start({ intervalMs: 1000 });
    const h1 = heartbeat.isRunning();
    heartbeat.start({ intervalMs: 1000 });
    expect(h1).toBe(true);
    expect(heartbeat.isRunning()).toBe(true);
    heartbeat.stop();
  });
});
