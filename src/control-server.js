// src/control-server.js — Browser-based control UI server (Item 2)
//
// Zero-dependency HTTP server (Node built-ins only) that:
//   - serves a dashboard (static files from src/control-server/public)
//   - lists running instances via session-registry
//   - streams live events (SSE) by tailing each session's events.jsonl
//   - spawns new instances on request
//   - relays user input to a running instance via a per-session inbox file
//
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const registry = require('./session-registry');
const eventLog = require('./event-log');

const PUBLIC_DIR = path.join(__dirname, 'control-server', 'public');
const TAIL_INTERVAL_MS = 500;
const SSE_HEARTBEAT_MS = 15000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─────────────────────────────────────────────
//  SSE client registry
// ─────────────────────────────────────────────

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

// Track how far we've read each session's events file (byte offset).
// Map<sessionDir, { file, offset, partial }>
const tailState = new Map();

function _broadcast(payload) {
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of sseClients) {
    try { res.write(line); } catch (_) { /* client gone */ }
  }
}

function _sseSend(res, payload) {
  try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch (_) {}
}

// ─────────────────────────────────────────────
//  Event tailing (poll file offsets, stream new lines)
// ─────────────────────────────────────────────

function _tailOnce() {
  const instances = registry.listInstances({ includeDead: true });
  for (const inst of instances) {
    const dir = inst.sessionDir;
    if (!dir) continue;
    const file = eventLog.eventsFile(dir);
    if (!file) continue;

    let state = tailState.get(dir);
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) { continue; }

    if (!state) {
      // New session: start at current end (dashboard gets backfill via /api/events).
      tailState.set(dir, { file, offset: size, partial: '' });
      continue;
    }

    // Handle log rotation.
    if (state.file !== file || size < state.offset) {
      state = { file, offset: 0, partial: '' };
      tailState.set(dir, state);
    }

    if (size === state.offset) continue;

    let chunk = '';
    try {
      const fd = fs.openSync(file, 'r');
      const len = size - state.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch (_) {
      continue;
    }
    state.offset = size;

    const combined = state.partial + chunk;
    const lines = combined.split('\n');
    state.partial = lines.pop(); // keep incomplete tail

    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }
      _broadcast({ stream: 'event', instance: inst.id || inst.name, sessionDir: dir, event: evt });
    }
  }
}

let _tailTimer = null;
function startTailing() {
  if (_tailTimer) return;
  _tailTimer = setInterval(_tailOnce, TAIL_INTERVAL_MS);
  if (_tailTimer.unref) _tailTimer.unref();
}

// ─────────────────────────────────────────────
//  Instance input inbox (dashboard -> agent)
// ─────────────────────────────────────────────

function _inboxFile(sessionDir) {
  return path.join(sessionDir, 'inbox.jsonl');
}

/** Queue a message for an instance to pick up (read by the agent's input handler). */
function queueInstanceInput(sessionDir, message, from = 'ui') {
  const record = { ts: Date.now(), from, message: String(message || '') };
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.appendFileSync(_inboxFile(sessionDir), JSON.stringify(record) + '\n', 'utf8');
    eventLog.emit('ui_input', { message: record.message, from }, { sessionDir });
    return record;
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────
//  Instance spawning (dashboard -> new agent process)
// ─────────────────────────────────────────────

/**
 * Spawn a new detached agent instance with an auto-generated session name.
 * @param {Object} opts { task, session, role, model, profile }
 * @returns {{ ok:boolean, session?:string, pid?:number, error?:string }}
 */
function spawnInstance(opts = {}) {
  const session = opts.session && opts.session !== 'auto'
    ? opts.session
    : registry.generateSessionName();

  const entry = path.join(__dirname, 'index.js');
  const args = [entry, '--session', session];
  if (opts.role)    args.push('--role', opts.role);
  if (opts.model)   args.push('--model', opts.model);
  if (opts.profile) args.push('--profile', opts.profile);
  args.push('--no-interactive');
  if (opts.headless) args.push('--headless');
  if (opts.task)    args.push(opts.task);

  try {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd || process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, session, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────────

function _sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function _readBody(req, limit = 1024 * 256) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { req.destroy(); resolve(''); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function _serveStatic(req, res, urlPath) {
  // Map "/" -> index.html; prevent path traversal.
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ─────────────────────────────────────────────
//  Request handler
// ─────────────────────────────────────────────

async function _handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // CORS for local dev tools
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API: list instances ──
  if (pathname === '/api/instances' && req.method === 'GET') {
    const instances = registry.listInstances({ prune: true, includeDead: url.searchParams.get('dead') === '1' });
    return _sendJson(res, 200, { instances });
  }

  // ── API: backfill events for one instance ──
  if (pathname === '/api/events' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const limit = parseInt(url.searchParams.get('limit') || '400', 10);
    const inst = registry.findInstance(id);
    if (!inst) return _sendJson(res, 404, { error: 'instance not found' });
    return _sendJson(res, 200, { events: eventLog.readEvents(inst.sessionDir, limit) });
  }

  // ── API: spawn a new instance ──
  if (pathname === '/api/spawn' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await _readBody(req) || '{}'); } catch (_) { body = {}; }
    const result = spawnInstance(body);
    return _sendJson(res, result.ok ? 200 : 500, result);
  }

  // ── API: send input to an instance ──
  if (pathname === '/api/input' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await _readBody(req) || '{}'); } catch (_) { body = {}; }
    const inst = registry.findInstance(body.id);
    if (!inst) return _sendJson(res, 404, { error: 'instance not found' });
    const rec = queueInstanceInput(inst.sessionDir, body.message);
    if (!rec) return _sendJson(res, 500, { error: 'could not queue input' });
    return _sendJson(res, 200, { ok: true, queued: rec });
  }

  // ── API: stop an instance (best-effort SIGTERM) ──
  if (pathname === '/api/stop' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await _readBody(req) || '{}'); } catch (_) { body = {}; }
    const inst = registry.findInstance(body.id);
    if (!inst) return _sendJson(res, 404, { error: 'instance not found' });
    try { process.kill(inst.pid, 'SIGTERM'); } catch (err) { return _sendJson(res, 500, { error: err.message }); }
    return _sendJson(res, 200, { ok: true, pid: inst.pid });
  }

  // ── SSE stream ──
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);

    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, SSE_HEARTBEAT_MS);
    if (hb.unref) hb.unref();

    // send an initial snapshot of instances
    _sseSend(res, { stream: 'instances', instances: registry.listInstances({ prune: true }) });

    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return;
  }

  // ── Static dashboard ──
  if (req.method === 'GET') {
    return _serveStatic(req, res, pathname);
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
}

// ─────────────────────────────────────────────
//  Server bootstrap
// ─────────────────────────────────────────────

let _instanceBroadcastTimer = null;

function _broadcastInstances() {
  const instances = registry.listInstances({ prune: true });
  _broadcast({ stream: 'instances', instances });
  return instances;
}

/**
 * Start the control server.
 * @param {Object} opts { port, host, quiet }
 * @returns {Promise<{ server, port, url, close }>}
 */
function startServer(opts = {}) {
  const port = opts.port != null ? opts.port : 7331;
  const host = opts.host || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      _handle(req, res).catch(err => {
        try { _sendJson(res, 500, { error: err.message }); } catch (_) {}
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error('Port ' + port + ' is already in use. Try --port <other>.'));
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      startTailing();
      _instanceBroadcastTimer = setInterval(_broadcastInstances, 2000);
      if (_instanceBroadcastTimer.unref) _instanceBroadcastTimer.unref();

      const actualPort = server.address().port;
      const url = 'http://' + host + ':' + actualPort;
      resolve({
        server,
        port: actualPort,
        url,
        close: () => new Promise(r => {
          if (_instanceBroadcastTimer) clearInterval(_instanceBroadcastTimer);
          if (_tailTimer) clearInterval(_tailTimer);
          _tailTimer = null;
          for (const c of sseClients) { try { c.end(); } catch (_) {} }
          sseClients.clear();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = {
  startServer,
  spawnInstance,
  queueInstanceInput,
  _handle,
  _tailOnce,
  _broadcast,
};

// Allow `node src/control-server.js [--port N]` to launch directly.
if (require.main === module) {
  const argv = process.argv.slice(2);
  let port = 7331;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) port = parseInt(argv[i + 1], 10);
    if (argv[i].startsWith('--port=')) port = parseInt(argv[i].split('=')[1], 10);
  }
  startServer({ port }).then(({ url }) => {
    console.log('Forge Agent control UI running at ' + url);
    console.log('Press Ctrl+C to stop.');
  }).catch(err => {
    console.error('Failed to start control server: ' + err.message);
    process.exit(1);
  });
}
