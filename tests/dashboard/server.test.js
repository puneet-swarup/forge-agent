// tests/dashboard/server.test.js — the local dashboard server, end to end.
//
// Everything here goes through real HTTP on 127.0.0.1: the point of the server
// is that a browser can talk to it, so a mocked request object would prove
// nothing. Ports are 0 (OS-assigned) so a busy machine cannot fail the suite.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDashboardServer } = require('../../src/dashboard/server');

const TOKEN = 'test-token-1234567890';
const DEAD_PID = 2147483647; // Linux caps pids far below this
const ORIGINAL_FORGE_HOME = process.env.FORGE_HOME;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

/** A small forge home: one dead agent, one finished session, one history entry. */
function buildHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-server-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  writeText(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  writeJson(path.join(home, 'history.json'), {
    version: 1,
    entries: [{
      id: 'h1',
      timestamp: '2026-11-20T10:30:00.000Z',
      task: 'Build the dashboard server',
      workingDir: project,
      model: 'deepseek',
      profile: 'default',
      status: 'completed',
      durationMs: 1000,
      stepsCount: 3,
      filesWritten: ['src/dashboard/server.js'],
    }],
  });

  writeJson(path.join(home, 'instances', 'worker-one.json'), {
    id: 'worker-one',
    name: 'worker-one',
    identifier: 'forge-worker-one-' + DEAD_PID,
    pid: DEAD_PID,
    cwd: project,
    status: 'running',
    startedAt: 1763631600000,
    lastHeartbeat: 1763631600000,
    sessionDir: path.join(home, 'sessions', 'sess-one'),
  });

  writeJson(path.join(home, 'sessions', 'sess-one', 'summary.json'), {
    session: 'sess-one',
    task: 'Build the dashboard server',
    status: 'completed',
    workingDir: project,
    filesWritten: ['src/dashboard/server.js'],
    durationMs: 1000,
    finishedAt: '2026-11-20T10:30:00.000Z',
  });

  // A session with a log file, for /api/sessions/:name/log.
  const logLines = [];
  for (let i = 1; i <= 10; i++) logLines.push('line-' + i);
  writeText(path.join(home, 'sessions', 'sess-log', 'session.log'), logLines.join('\n') + '\n');
  writeJson(path.join(home, 'sessions', 'sess-log', 'summary.json'), {
    session: 'sess-log',
    task: 'Talk a lot',
    status: 'completed',
    workingDir: project,
  });

  // A dedicated agent whose stop we exercise (the supervisor's cleanup deletes
  // its session dir, so it must not be shared with other assertions).
  writeJson(path.join(home, 'instances', 'worker-stop.json'), {
    id: 'worker-stop',
    name: 'worker-stop',
    identifier: 'forge-worker-stop-' + DEAD_PID,
    pid: DEAD_PID,
    cwd: project,
    status: 'running',
    startedAt: 1763631600000,
    lastHeartbeat: 1763631600000,
    sessionDir: path.join(home, 'sessions', 'sess-stop'),
  });
  fs.mkdirSync(path.join(home, 'sessions', 'sess-stop'), { recursive: true });

  return { home, project };
}

/** Start a dashboard and resolve once the socket is actually listening. */
function startServer(opts) {
  return new Promise((resolve, reject) => {
    const dash = createDashboardServer(opts);
    if (dash.server.listening) return resolve(dash);
    dash.server.once('listening', () => resolve(dash));
    dash.server.once('error', reject);
  });
}

function baseUrl(dash) {
  return 'http://127.0.0.1:' + dash.server.address().port;
}

describe('createDashboardServer — binding', () => {
  test('refuses to bind anything but loopback', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(() => createDashboardServer({ host, port: 0, token: TOKEN }))
        .toThrow(/refusing to bind/i);
    }
  });

  test('binds 127.0.0.1 by default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-bind-'));
    const dash = await startServer({ port: 0, forgeHome: home, token: TOKEN });
    try {
      const addr = dash.server.address();
      expect(addr.address).toBe('127.0.0.1');
      expect(typeof addr.port).toBe('number');
      expect(dash.url).toContain('http://127.0.0.1:');
      expect(dash.url).toContain(encodeURIComponent(TOKEN));
    } finally {
      await dash.close();
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('generates a token when none is passed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-token-'));
    const dash = await startServer({ port: 0, forgeHome: home });
    try {
      expect(typeof dash.token).toBe('string');
      expect(dash.token).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes, hex
    } finally {
      await dash.close();
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe('dashboard server', () => {
  let ctx;
  let dash;
  let base;

  beforeAll(async () => {
    ctx = buildHome();
    dash = await startServer({ port: 0, forgeHome: ctx.home, token: TOKEN });
    base = baseUrl(dash);
  });

  afterAll(async () => {
    if (dash) await dash.close();
    try { fs.rmSync(ctx.home, { recursive: true, force: true }); } catch (_) {}
    if (ORIGINAL_FORGE_HOME === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = ORIGINAL_FORGE_HOME;
  });

  // ── auth ───────────────────────────────────────────────────────────────

  test('no token is a 401', async () => {
    const res = await fetch(base + '/api/state');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  test('a wrong token is a 401', async () => {
    const res = await fetch(base + '/api/state?token=not-the-token');
    expect(res.status).toBe(401);
    const viaHeader = await fetch(base + '/api/state', { headers: { 'x-forge-token': 'nope' } });
    expect(viaHeader.status).toBe(401);
  });

  test('the token works as a query parameter and as a header', async () => {
    const viaQuery = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN));
    expect(viaQuery.status).toBe(200);
    const viaHeader = await fetch(base + '/api/state', { headers: { 'x-forge-token': TOKEN } });
    expect(viaHeader.status).toBe(200);
  });

  // ── state ──────────────────────────────────────────────────────────────

  test('/api/state returns the documented shape, read from disk', async () => {
    const res = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const state = await res.json();
    expect(Object.keys(state).sort()).toEqual(
      ['agents', 'forgeHome', 'generatedAt', 'processes', 'projects', 'sessions', 'tasks']);
    expect(state.forgeHome).toBe(path.resolve(ctx.home));
    expect(new Date(state.generatedAt).toISOString()).toBe(state.generatedAt);

    expect(state.agents.map((a) => a.session).sort()).toEqual(['worker-one', 'worker-stop']);
    expect(state.agents.every((a) => a.alive === false && a.status === 'dead')).toBe(true);
    expect(state.sessions.map((s) => s.name).sort()).toEqual(['sess-log', 'sess-one', 'sess-stop']);
    expect(state.tasks.length).toBe(1);
    expect(state.tasks[0].task).toBe('Build the dashboard server');
    expect(state.projects.length).toBe(1);
    expect(state.projects[0].gitBranch).toBe('main');
    expect(Array.isArray(state.processes)).toBe(true);
  });

  test('/api/state is never cached', async () => {
    const res = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN));
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
  });

  test('/api/state reflects a change on disk on the very next request', async () => {
    const file = path.join(ctx.home, 'history.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const after = JSON.parse(JSON.stringify(before));
    after.entries.unshift({
      id: 'h2', timestamp: '2026-11-21T00:00:00.000Z', task: 'A fresh task',
      workingDir: ctx.project, status: 'completed',
    });
    writeJson(file, after);
    try {
      const res = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN));
      const state = await res.json();
      expect(state.tasks.length).toBe(2);
      expect(state.tasks[0].task).toBe('A fresh task');
    } finally {
      writeJson(file, before);
    }
  });

  // ── 404s ───────────────────────────────────────────────────────────────

  test('an unknown path is a 404 JSON, with or without a token', async () => {
    const withToken = await fetch(base + '/nope?token=' + encodeURIComponent(TOKEN));
    expect(withToken.status).toBe(404);
    expect(withToken.headers.get('content-type')).toContain('application/json');
    expect((await withToken.json()).error).toBe('not found');

    const withoutToken = await fetch(base + '/nope');
    expect(withoutToken.status).toBe(404);
  });

  test('a known path with the wrong method is a 404', async () => {
    const res = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  // ── the page ───────────────────────────────────────────────────────────

  test('GET / serves the dashboard page with the token injected', async () => {
    const res = await fetch(base + '/?token=' + encodeURIComponent(TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('no-store');

    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Forge Agent');
    expect(html).toContain(TOKEN);
    // Every section heading is present.
    for (const heading of ['Agents', 'Sessions', 'Projects', 'Tasks', 'Processes']) {
      expect(html).toContain(heading);
    }
    // It polls, and it says so explicitly.
    expect(html).toContain('/api/state');
    expect(html).toContain('2000');
  });

  test('the page makes no external request', async () => {
    const res = await fetch(base + '/?token=' + encodeURIComponent(TOKEN));
    const html = await res.text();
    const urls = html.match(/https?:\/\/[^\s"'<>)]*/g) || [];
    for (const url of urls) {
      expect(url).toContain('127.0.0.1');
    }
    // No CDN, no fonts, no images, no scripts pulled from anywhere.
    expect(html).not.toContain('<script src');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('//cdn');
    expect(html).not.toContain('@import');
  });

  test('the page still needs a token', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(401);
  });

  // ── session logs ───────────────────────────────────────────────────────

  test('a session log is served as plain text, last N lines', async () => {
    const res = await fetch(
      base + '/api/sessions/sess-log/log?lines=3&token=' + encodeURIComponent(TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.text()).trim();
    expect(body.split('\n')).toEqual(['line-8', 'line-9', 'line-10']);
  });

  test('the log defaults to 200 lines when lines is absent or nonsense', async () => {
    const all = await fetch(base + '/api/sessions/sess-log/log?token=' + encodeURIComponent(TOKEN));
    expect(all.status).toBe(200);
    expect((await all.text()).trim().split('\n').length).toBe(10);

    const junk = await fetch(
      base + '/api/sessions/sess-log/log?lines=abc&token=' + encodeURIComponent(TOKEN));
    expect((await junk.text()).trim().split('\n').length).toBe(10);
  });

  test('an unknown session log is a 404', async () => {
    const res = await fetch(base + '/api/sessions/nope/log?token=' + encodeURIComponent(TOKEN));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown session');
  });

  test('a session name cannot escape the sessions directory', async () => {
    for (const name of ['..%2F..%2Fetc', '..%2f..%2fpasswd', '%2e%2e', 'a%00b']) {
      const res = await fetch(base + '/api/sessions/' + name + '/log?token=' + encodeURIComponent(TOKEN));
      expect(res.status).toBe(404);
    }
  });

  test('a session with no log file says so instead of inventing one', async () => {
    const res = await fetch(base + '/api/sessions/sess-one/log?token=' + encodeURIComponent(TOKEN));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('no log file for session "sess-one"');
  });

  test('a log request without a token is a 401', async () => {
    const res = await fetch(base + '/api/sessions/sess-log/log');
    expect(res.status).toBe(401);
  });

  // ── stop ───────────────────────────────────────────────────────────────

  test('stopping an unknown agent is a 400', async () => {
    const res = await fetch(base + '/api/agents/not-an-agent/stop?token=' + encodeURIComponent(TOKEN),
      { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown agent');
  });

  test('stopping a known agent goes through the supervisor kill path', async () => {
    const res = await fetch(base + '/api/agents/forge-worker-stop-' + DEAD_PID + '/stop?token=' +
      encodeURIComponent(TOKEN), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopped).toBe(true);
    expect(body.pid).toBe(DEAD_PID);
    // The PID was already gone, so the supervisor reports it rather than killing.
    expect(body.alreadyDead).toBe(true);

    // The supervisor's cleanup removed the registry record, so a second stop
    // now correctly reports an unknown agent.
    const again = await fetch(base + '/api/agents/forge-worker-stop-' + DEAD_PID + '/stop?token=' +
      encodeURIComponent(TOKEN), { method: 'POST' });
    expect(again.status).toBe(400);
  });

  test('stopping without a token is a 401 and kills nothing', async () => {
    const res = await fetch(base + '/api/agents/worker-one/stop', { method: 'POST' });
    expect(res.status).toBe(401);
    const still = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN));
    const state = await still.json();
    expect(state.agents.some((a) => a.session === 'worker-one')).toBe(true);
  });
});

describe('close()', () => {
  test('closes the socket cleanly and refuses further requests', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-close-'));
    const dash = await startServer({ port: 0, forgeHome: home, token: TOKEN });
    const base = baseUrl(dash);
    try {
      const before = await fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN));
      expect(before.status).toBe(200);

      await dash.close();
      expect(dash.server.listening).toBe(false);

      await expect(fetch(base + '/api/state?token=' + encodeURIComponent(TOKEN))).rejects.toThrow();
      // A second close is harmless.
      await expect(dash.close()).resolves.toBeUndefined();
    } finally {
      await dash.close();
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      if (ORIGINAL_FORGE_HOME === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = ORIGINAL_FORGE_HOME;
    }
  });
});
