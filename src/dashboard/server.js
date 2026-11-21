// src/dashboard/server.js — the local dashboard HTTP server.
//
// Built on Node's own http module: no express, no new dependency, no build.
// The server binds 127.0.0.1 ONLY — a dashboard that can be reached from the
// network is a dashboard that leaks your task history, working directories and
// process list, so anything but loopback is refused outright.
//
// Routes (all of them need the token, by ?token= or the x-forge-token header;
// an unknown path is a 404 whether or not a token was supplied):
//   GET  /                                    the dashboard page
//   GET  /api/state                           collectState() as JSON, uncached
//   POST /api/agents/:id/stop                 stop a child via the supervisor
//   GET  /api/sessions/:name/log?lines=200    last N lines of a session's log
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { collectState } = require('./state');
const { renderPage } = require('./page');

const HOST = '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 5000;

// ─────────────────────────────────────────────
//  Response helpers — every response is no-store
// ─────────────────────────────────────────────

function applyNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body === undefined ? {} : body);
  applyNoStore(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function sendText(res, status, text, contentType) {
  const payload = String(text == null ? '' : text);
  applyNoStore(res);
  res.statusCode = status;
  res.setHeader('Content-Type', (contentType || 'text/plain') + '; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function sendHtml(res, html) {
  const payload = String(html == null ? '' : html);
  applyNoStore(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' });
}

/** Constant-time token comparison (length differences are hashed away). */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided === '' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────
//  Session logs
// ─────────────────────────────────────────────

/**
 * Where a session's log could live. Forge writes per-run conversation logs to
 * <home>/logs/session-<timestamp>.txt (src/agent.js) and per-session artifacts
 * into <home>/sessions/<name>/; neither is keyed by session name today, so we
 * look for the plausible per-session names first and report honestly when none
 * exists rather than guessing at an unrelated file.
 */
function logCandidates(home, name, dir) {
  return [
    path.join(dir, 'session.log'),
    path.join(dir, 'log.txt'),
    path.join(dir, 'agent.log'),
    path.join(home, 'logs', name + '.log'),
    path.join(home, 'logs', name + '.txt'),
    path.join(home, 'logs', 'session-' + name + '.txt'),
  ];
}

function readLastLines(file, lines) {
  const text = fs.readFileSync(file, 'utf8');
  const all = text.split(/\r?\n/);
  // A trailing newline yields a final empty element; it is not a log line.
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

function safeSessionName(raw) {
  let name;
  try { name = decodeURIComponent(raw); } catch (_) { return null; }
  if (!name || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name;
}

function parseLines(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_LINES;
  return Math.min(n, MAX_LOG_LINES);
}

// ─────────────────────────────────────────────
//  Agent stop — through the supervisor's kill path
// ─────────────────────────────────────────────

/**
 * Stop one agent.
 * Returns { status, body } — the caller only serialises it.
 */
async function stopAgentById(forgeHome, id) {
  const snapshot = collectState({ forgeHome });
  const agent = (snapshot.agents || []).find(
    (a) => a.id === id || a.session === id || String(a.pid) === String(id));
  if (!agent) {
    return { status: 400, body: { error: 'unknown agent', id } };
  }

  let supervisor;
  try {
    supervisor = require('../agent-supervisor');
  } catch (err) {
    return { status: 500, body: { error: 'supervisor unavailable: ' + (err && err.message) } };
  }

  let result = null;
  try {
    // Graceful first, then force — the supervisor owns that escalation.
    result = await supervisor.killChild(agent.id, { graceMs: 2000 });
    if (!result || !result.ok) {
      // The registry lookup is keyed off FORGE_HOME; when the record came from
      // an explicitly-passed home the lookup can miss. The PID we just read
      // from that same registry is a known Forge instance, so retry by PID.
      if (agent.pid) {
        result = await supervisor.killChild(agent.pid, { graceMs: 2000, force: true });
      }
    }
  } catch (err) {
    return { status: 500, body: { error: 'stop failed: ' + (err && err.message) } };
  }

  if (!result || !result.ok) {
    return {
      status: 500,
      body: { error: (result && result.error) || 'could not stop agent', id: agent.id, pid: agent.pid },
    };
  }

  return {
    status: 200,
    body: {
      stopped: true,
      id: agent.id,
      pid: agent.pid === undefined ? null : agent.pid,
      alreadyDead: result.alreadyDead === true,
      escalated: result.escalated === true,
    },
  };
}

// ─────────────────────────────────────────────
//  Server
// ─────────────────────────────────────────────

/**
 * Create (and start) the dashboard server.
 *
 * @param {Object} [opts]
 * @param {number} [opts.port]      port to bind (0 = let the OS choose)
 * @param {string} [opts.forgeHome] forge home to report on (default: ~/.forge-agent)
 * @param {string} [opts.token]     shared secret (default: 24 random bytes, hex)
 * @param {string} [opts.host]      loopback only; anything else throws
 * @returns {{ server: import('http').Server, url: string, close: () => Promise<void>, token: string }}
 */
function createDashboardServer(opts = {}) {
  const host = opts.host === undefined || opts.host === null ? HOST : String(opts.host);
  if (!LOOPBACK.has(host)) {
    throw new Error(
      'createDashboardServer: refusing to bind ' + host +
      '. The dashboard binds loopback only (127.0.0.1) — it exposes task history, ' +
      'working directories and PIDs, so it must never be reachable from the network.'
    );
  }

  const forgeHome = opts.forgeHome ? path.resolve(opts.forgeHome) : undefined;
  const token = typeof opts.token === 'string' && opts.token !== ''
    ? opts.token
    : crypto.randomBytes(24).toString('hex');
  const requestedPort = opts.port === undefined || opts.port === null ? 0 : opts.port;

  // The supervisor resolves its registry through paths.forgeHome(), which reads
  // FORGE_HOME. Point it at the same home we report on so a stop request kills
  // the agent we displayed, not a same-named one in another home.
  if (forgeHome && process.env.FORGE_HOME !== forgeHome) {
    process.env.FORGE_HOME = forgeHome;
  }

  const routes = [
    {
      method: 'GET',
      pattern: /^\/$/,
      handle: async (req, res) => sendHtml(res, renderPage({ token, forgeHome: forgeHome || '' })),
    },
    {
      method: 'GET',
      pattern: /^\/api\/state$/,
      handle: async (req, res) => sendJson(res, 200, collectState({ forgeHome })),
    },
    {
      method: 'POST',
      pattern: /^\/api\/agents\/([^/]+)\/stop$/,
      handle: async (req, res, m) => {
        let id;
        try { id = decodeURIComponent(m[1]); } catch (_) { return notFound(res); }
        const outcome = await stopAgentById(forgeHome, id);
        sendJson(res, outcome.status, outcome.body);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/sessions\/([^/]+)\/log$/,
      handle: async (req, res, m, url) => {
        const name = safeSessionName(m[1]);
        if (!name) return notFound(res);
        const home = forgeHome || require('./state').resolveHome();
        const dir = path.join(home, 'sessions', name);
        let isDir = false;
        try { isDir = fs.statSync(dir).isDirectory(); } catch (_) { isDir = false; }
        if (!isDir) return sendJson(res, 404, { error: 'unknown session', name });

        const lines = parseLines(url.searchParams.get('lines'));
        const candidates = logCandidates(home, name, dir);
        const file = candidates.find((c) => {
          try { return fs.statSync(c).isFile(); } catch (_) { return false; }
        });
        if (!file) {
          return sendText(res, 200,
            'no log file for session "' + name + '"\n' +
            'looked for session.log in ' + dir + '\n' +
            'and logs/' + name + '.log under ' + home + '\n');
        }
        let body;
        try {
          body = readLastLines(file, lines);
        } catch (err) {
          return sendText(res, 200,
            'could not read ' + file + ': ' + (err && err.message) + '\n');
        }
        sendText(res, 200, body === '' ? '(log is empty)\n' : body + '\n');
      },
    },
  ];

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://' + HOST);
    const pathname = url.pathname;

    // 1) Route first: an unknown path is a 404 even with a valid token, and
    //    stays a 404 without one (no route enumeration through 401s).
    const route = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
    if (!route) return notFound(res);

    // 2) Then the token.
    const provided = url.searchParams.get('token') || req.headers['x-forge-token'] || '';
    if (!tokenMatches(Array.isArray(provided) ? provided[0] : provided, token)) {
      return sendJson(res, 401, { error: 'unauthorized', hint: 'pass ?token= or the x-forge-token header' });
    }

    // 3) Dispatch.
    const match = route.pattern.exec(pathname);
    return route.handle(req, res, match, url);
  }

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((err) => {
        // Never throw out of a request handler.
        try {
          process.stderr.write('[forge-dashboard] ' + ((err && err.stack) || String(err)) + '\n');
        } catch (_) { /* stderr is best-effort */ }
        try {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
          else res.end();
        } catch (_) { /* connection already gone */ }
      });
  });

  let closed = false;
  server.on('error', (err) => {
    try {
      process.stderr.write('[forge-dashboard] listen error: ' + (err && err.message) + '\n');
    } catch (_) { /* ignore */ }
  });

  server.listen(requestedPort, host);

  const result = {
    server,
    token,
    /** Resolved lazily so the port is real once the socket is bound. */
    get url() {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : requestedPort;
      return 'http://' + HOST + ':' + port + '/?token=' + encodeURIComponent(token);
    },
    close() {
      return new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    },
  };

  return result;
}

module.exports = { createDashboardServer, HOST };
