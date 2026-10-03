// src/session-registry.js — Unique session identity + instance registry
//  (Items 1 & 6)
//
// Item 1 — every instance gets a unique, human-readable name and its own
//          browser-profile directory, so two instances never collide on the
//          shared Chromium profile.
// Item 6 — each running instance writes a heartbeat file that a CLI can scan
//          (`forge-agent ps`) to show all live instances.
//
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─────────────────────────────────────────────
//  Paths
// ─────────────────────────────────────────────

function baseDir() {
  return process.env.FORGE_HOME
    ? path.resolve(process.env.FORGE_HOME)
    : path.join(os.homedir(), '.deepseek-agent');
}

function sessionsRoot() {
  return path.join(baseDir(), 'sessions');
}

function sessionDirFor(name) {
  return path.join(sessionsRoot(), name);
}

// ─────────────────────────────────────────────
//  Human-readable name generation
// ─────────────────────────────────────────────

const ADJECTIVES = [
  'brave', 'swift', 'calm', 'bold', 'keen', 'bright', 'quiet', 'lucky',
  'cosmic', 'silent', 'rapid', 'clever', 'eager', 'noble', 'witty', 'vivid',
];

const ANIMALS = [
  'otter', 'falcon', 'tiger', 'panda', 'lynx', 'raven', 'wolf', 'heron',
  'fox', 'koala', 'badger', 'osprey', 'yeti', 'cobra', 'moth', 'yak',
];

function _pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function _shortId() {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Generate a unique, human-readable session name like "brave-otter-9f3a".
 * Ensures no existing session directory already uses it.
 */
function generateSessionName() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = _pick(ADJECTIVES) + '-' + _pick(ANIMALS) + '-' + _shortId();
    if (!fs.existsSync(sessionDirFor(name))) return name;
  }
  // Extremely unlikely fallback — fully random.
  return 'agent-' + Date.now().toString(36) + '-' + _shortId();
}

// ─────────────────────────────────────────────
//  Instance heartbeat files
// ─────────────────────────────────────────────

const INSTANCE_FILE = 'instance.json';

function instanceFileFor(sessionDir) {
  return path.join(sessionDir, INSTANCE_FILE);
}

/**
 * Write (or refresh) this process's heartbeat into its session dir.
 * Safe to call repeatedly; failures never throw into the agent.
 */
function writeHeartbeat(info = {}) {
  const sessionDir = info.sessionDir
    || process.env.FORGE_SESSION_DIR
    || sessionDirFor(process.env.FORGE_SESSION_NAME || 'default');
  const record = {
    id: process.env.FORGE_SESSION_NAME || info.name || 'default',
    name: process.env.FORGE_SESSION_NAME || info.name || 'default',
    role: process.env.FORGE_ROLE || null,
    pid: process.pid,
    ppid: process.ppid || null,
    cwd: process.cwd(),
    model: info.model || null,
    profile: info.profile || null,
    status: info.status || 'running',
    startedAt: info.startedAt || Date.now(),
    lastHeartbeat: Date.now(),
    sessionDir,
    argv: process.argv.slice(2).join(' ').slice(0, 300),
  };
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(instanceFileFor(sessionDir), JSON.stringify(record, null, 2), 'utf8');
    return record;
  } catch (_) {
    return null;
  }
}

/** Update just the status/heartbeat of an existing instance record. */
function updateHeartbeat(status) {
  try {
    const sessionDir = process.env.FORGE_SESSION_DIR;
    if (!sessionDir) return null;
    const file = instanceFileFor(sessionDir);
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    existing.status = status || existing.status;
    existing.lastHeartbeat = Date.now();
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8');
    return existing;
  } catch (_) {
    return null;
  }
}

function removeHeartbeat() {
  try {
    const sessionDir = process.env.FORGE_SESSION_DIR;
    if (sessionDir) fs.unlinkSync(instanceFileFor(sessionDir));
  } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────
//  Instance discovery (for `forge-agent ps`)
// ─────────────────────────────────────────────

/** Best-effort check whether a PID is alive on this host. */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal
    return true;
  } catch (err) {
    // EPERM => process exists but we can't signal it (still alive).
    return err.code === 'EPERM';
  }
}

/**
 * List all known instances by scanning session directories for
 * instance.json files. Marks each as alive/dead via PID check.
 *
 * @param {Object} opts
 * @param {boolean} opts.includeDead  include records whose PID is gone
 * @param {boolean} opts.prune        delete stale instance.json files
 * @returns {Array<Object>} sorted by startedAt (newest first)
 */
function listInstances(opts = {}) {
  const { includeDead = false, prune = false } = opts;
  const root = sessionsRoot();
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (_) {
    return [];
  }

  const out = [];
  for (const name of names) {
    const dir = sessionDirFor(name);
    const file = instanceFileFor(dir);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue; // no heartbeat => not a tracked instance
    }

    const alive = isPidAlive(record.pid);
    if (!alive && prune) {
      try { fs.unlinkSync(file); } catch (__) {}
      if (!includeDead) continue;
    }
    if (!alive && !includeDead) continue;

    const ageMs = Date.now() - (record.startedAt || record.lastHeartbeat || Date.now());
    out.push({
      ...record,
      alive,
      uptimeMs: ageMs,
      uptime: _formatDuration(ageMs),
    });
  }

  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

function _formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60) + 'm';
}

/** Find a single instance record by id/name (or a unique prefix). */
function findInstance(idOrPrefix) {
  if (!idOrPrefix) return null;
  const all = listInstances({ includeDead: true });
  const exact = all.find(i => i.id === idOrPrefix || i.name === idOrPrefix);
  if (exact) return exact;
  const matches = all.filter(i => (i.id || '').startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Render the instance list as a fixed-width text table.
 * @param {Array} instances
 * @param {boolean} color  use ANSI colors
 */
function formatInstanceTable(instances, color = true) {
  const c = (code, t) => (color ? '\x1b[' + code + 'm' + t + '\x1b[0m' : t);
  if (!instances || instances.length === 0) {
    return c('90', 'No running instances found.') + '\n' +
           c('90', 'Start one with: forge-agent --session <name> "<task>"');
  }

  const cols = [
    { key: 'id',       label: 'ID/NAME',   width: 22 },
    { key: 'role',     label: 'ROLE',      width: 16 },
    { key: 'pid',      label: 'PID',       width: 8 },
    { key: 'status',   label: 'STATUS',    width: 9 },
    { key: 'uptime',   label: 'UPTIME',    width: 10 },
    { key: 'model',    label: 'MODEL',     width: 10 },
    { key: 'cwd',      label: 'CWD',       width: 40 },
  ];

  const pad = (s, w) => {
    s = String(s == null ? '' : s);
    return s.length >= w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - s.length);
  };

  const header = cols.map(cl => pad(cl.label, cl.width)).join(' ');
  const lines = [c('1;36', header)];

  for (const inst of instances) {
    const statusText = inst.alive ? c('32', 'running') : c('31', 'dead');
    const row = cols.map(cl => {
      if (cl.key === 'status') return pad(statusText, cl.width + (color ? 9 : 0));
      return pad(inst[cl.key], cl.width);
    }).join(' ');
    lines.push(row);
  }

  lines.push('');
  lines.push(c('90', instances.length + ' instance(s). Use: forge-agent ps --json for machine output.'));
  return lines.join('\n');
}

module.exports = {
  baseDir,
  sessionsRoot,
  sessionDirFor,
  generateSessionName,
  writeHeartbeat,
  updateHeartbeat,
  removeHeartbeat,
  listInstances,
  findInstance,
  isPidAlive,
  formatInstanceTable,
};
