// tests/control-server.test.js — Item 2: browser-based control UI
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Isolate FORGE_HOME before loading modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ui-'));
process.env.FORGE_HOME = TMP;
process.env.FORGE_NO_EVENTS = '';

const registry = require('../src/session-registry');
const eventLog = require('../src/event-log');
const { startServer } = require('../src/control-server');

// ── tiny HTTP GET helper ──
function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function postJson(port, pathname, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('control-server', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = await startServer({ port: 0 });
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    delete process.env.FORGE_HOME;
  });

  test('serves the dashboard HTML at /', async () => {
    const res = await get(port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Forge Agent');
    expect(res.body).toContain('instanceList');
  });

  test('serves the CSS and JS assets', async () => {
    const css = await get(port, '/style.css');
    const js = await get(port, '/app.js');
    expect(css.status).toBe(200);
    expect(css.body).toContain('.instance-list');
    expect(js.status).toBe(200);
    expect(js.body).toContain('EventSource');
  });

  test('blocks path traversal', async () => {
    const res = await get(port, '/../package.json');
    expect([403, 404]).toContain(res.status);
  });

  test('GET /api/instances returns a JSON list', async () => {
    const res = await get(port, '/api/instances');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data.instances)).toBe(true);
  });
});

describe('event-log', () => {
  test('emit writes a JSON line readable by readEvents', () => {
    const dir = path.join(TMP, 'sessions', 'evt-test');
    fs.mkdirSync(dir, { recursive: true });
    eventLog.emit('task', { task: 'hello' }, { sessionDir: dir });
    eventLog.emit('step', { step: 1 }, { sessionDir: dir });
    const events = eventLog.readEvents(dir, 100);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('task');
    expect(events[0].data.task).toBe('hello');
    expect(events[1].type).toBe('step');
    expect(typeof events[0].ts).toBe('number');
  });

  test('readEvents respects the limit (returns newest)', () => {
    const dir = path.join(TMP, 'sessions', 'evt-limit');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) eventLog.emit('step', { step: i }, { sessionDir: dir });
    const events = eventLog.readEvents(dir, 3);
    expect(events.length).toBe(3);
    expect(events[2].data.step).toBe(9);
  });

  test('FORGE_NO_EVENTS disables emission', () => {
    const dir = path.join(TMP, 'sessions', 'evt-off');
    fs.mkdirSync(dir, { recursive: true });
    const saved = process.env.FORGE_NO_EVENTS;
    process.env.FORGE_NO_EVENTS = '1';
    eventLog.emit('task', { task: 'nope' }, { sessionDir: dir });
    expect(eventLog.readEvents(dir).length).toBe(0);
    if (saved === undefined) delete process.env.FORGE_NO_EVENTS; else process.env.FORGE_NO_EVENTS = saved;
  });

  test('readEvents returns [] for a missing session dir', () => {
    expect(eventLog.readEvents(path.join(TMP, 'does-not-exist'))).toEqual([]);
  });
});

describe('control-server — API', () => {
  let server, port;

  beforeAll(async () => {
    server = await startServer({ port: 0 });
    port = server.port;
  });
  afterAll(async () => { await server.close(); });

  test('POST /api/spawn returns a session and pid', async () => {
    const res = await postJson(port, '/api/spawn', { task: '', headless: true });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(typeof data.session).toBe('string');
    expect(typeof data.pid).toBe('number');
  });

  test('POST /api/input queues a message and emits a ui_input event', async () => {
    // Create a fake live instance so findInstance resolves it.
    const name = 'input-target';
    const dir = registry.sessionDirFor(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({
      id: name, name, role: name, pid: process.pid, cwd: process.cwd(),
      status: 'running', startedAt: Date.now(), lastHeartbeat: Date.now(), sessionDir: dir,
    }), 'utf8');

    const res = await postJson(port, '/api/input', { id: name, message: 'do the thing' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);

    const inbox = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n');
    const msg = JSON.parse(inbox[inbox.length - 1]);
    expect(msg.message).toBe('do the thing');

    const events = eventLog.readEvents(dir);
    expect(events.some(e => e.type === 'ui_input')).toBe(true);
  });

  test('POST /api/input 404s for an unknown instance', async () => {
    const res = await postJson(port, '/api/input', { id: 'ghost', message: 'x' });
    expect(res.status).toBe(404);
  });

  test('GET /api/events 404s for an unknown instance', async () => {
    const res = await get(port, '/api/events?id=ghost');
    expect(res.status).toBe(404);
  });
});
