// @ts-check
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
  // Delegate to the single source of truth (model-agnostic ~/.forge-agent).
  return require('./paths').forgeHome();
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

// Canonical directory for heartbeats, INDEPENDENT of where the browser profile
// lives. This is what makes `ps` reliable: a run started with --session-dir <x>
// still records its heartbeat here, so it is always discoverable.
function instancesRoot() {
  return path.join(baseDir(), 'instances');
}

function heartbeatFileFor(name) {
  const safe = String(name || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(instancesRoot(), safe + '.json');
}

function instanceFileFor(sessionDir) {
  return path.join(sessionDir, INSTANCE_FILE);
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

/**
 * Write (or refresh) this process's heartbeat into its session dir.
 * Safe to call repeatedly; failures never throw into the agent.
 */
function writeHeartbeat(info = {}) {
  const sessionDir = info.sessionDir
    || process.env.FORGE_SESSION_DIR
    || sessionDirFor(process.env.FORGE_SESSION_NAME || 'default');
  const name = process.env.FORGE_SESSION_NAME || info.name || 'default';
  const parentPid = parseInt(process.env.FORGE_PARENT_PID, 10) || null;
  const parentId = process.env.FORGE_PARENT_ID || null;
  const identifier = process.env.FORGE_CHILD_ID || info.identifier || name;
  const record = {
    id: name,
    name: name,
    identifier: identifier,
    role: process.env.FORGE_ROLE || info.role || null,
    pid: process.pid,
    ppid: process.ppid || null,
    parentId: parentId,
    parentPid: parentPid,
    isChild: !!(parentId || parentPid),
    taskFile: process.env.FORGE_TASK_FILE || info.taskFile || null,
    window: process.env.FORGE_SPAWN_WINDOW || info.window || null,
    cwd: process.cwd(),
    model: info.model || null,
    profile: info.profile || null,
    status: info.status || 'running',
    startedAt: info.startedAt || Date.now(),
    lastHeartbeat: Date.now(),
    sessionDir,
    argv: process.argv.slice(2).join(' ').slice(0, 300),
  };
  const json = JSON.stringify(record, null, 2);
  // 1) Canonical heartbeat file - always discoverable by `ps`.
  try {
    fs.mkdirSync(instancesRoot(), { recursive: true });
    atomicWrite(heartbeatFileFor(name), json, 'utf8');
  } catch (_) { /* best-effort */ }
  // 2) Legacy session-dir copy - keeps older tooling working.
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    atomicWrite(instanceFileFor(sessionDir), json, 'utf8');
  } catch (_) { /* best-effort */ }
  return record;
}

/** Update just the status/heartbeat of an existing instance record. */
function updateHeartbeat(status) {
  try {
    const name = process.env.FORGE_SESSION_NAME || 'default';
    const file = heartbeatFileFor(name);
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    existing.status = status || existing.status;
    existing.lastHeartbeat = Date.now();
    const json = JSON.stringify(existing, null, 2);
    atomicWrite(file, json, 'utf8');
    // Keep the legacy session-dir copy in sync too.
    try { atomicWrite(instanceFileFor(existing.sessionDir), json, 'utf8'); } catch (_) {}
    return existing;
  } catch (_) {
    return null;
  }
}

function removeHeartbeat() {
  const name = process.env.FORGE_SESSION_NAME || 'default';
  try { fs.unlinkSync(heartbeatFileFor(name)); } catch (_) { /* ignore */ }
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
 * @param {boolean} [opts.includeDead]  include records whose PID is gone
 * @param {boolean} [opts.prune]        delete stale instance.json files
 * @returns {Array<Object>} sorted by startedAt (newest first)
 */
function listInstances(opts = {}) {
  const { includeDead = false, prune = false } = opts;
  const seen = new Map(); // name -> { record, file }

  // 1) Canonical heartbeat files (always written, regardless of --session-dir).
  try {
    const files = fs.readdirSync(instancesRoot()).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const file = path.join(instancesRoot(), f);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        seen.set(record.id || record.name || f, { record, file });
      } catch (_) {}
    }
  } catch (_) {}

  // 2) Legacy session-dir instance.json files (only if not already seen).
  try {
    const names = fs.readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const name of names) {
      const file = instanceFileFor(sessionDirFor(name));
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        const key = record.id || record.name || name;
        if (!seen.has(key)) seen.set(key, { record, file });
      } catch (_) {}
    }
  } catch (_) {}

  const ttl = heartbeatTtlMs();
  const now = Date.now();
  const out = [];
  for (const entry of seen.values()) {
    const record = entry.record;
    const file = entry.file;
    const alive = isPidAlive(record.pid);
    const state = classifyInstance(record, { alive, now, ttl });
    if (state === 'dead' && prune) {
      try { fs.unlinkSync(file); } catch (__) {}
      if (!includeDead) continue;
    }
    if (state === 'dead' && !includeDead) continue;

    const ageMs = now - (record.startedAt || record.lastHeartbeat || now);
    const beatAgeMs = record.lastHeartbeat ? (now - record.lastHeartbeat) : null;
    out.push({
      ...record,
      alive,
      state,
      uptimeMs: ageMs,
      uptime: _formatDuration(ageMs),
      beatAgeMs,
      beatAge: beatAgeMs == null ? '-' : _formatDuration(beatAgeMs),
      lastStatus: _readLastSummaryStatus(record),
    });
  }

  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

// ─────────────────────────────────────────────
//  Liveness classification (protocol §5 / §6)
// ─────────────────────────────────────────────

/** Heartbeat interval used by child agents (ms). */
function heartbeatIntervalMs() {
  const v = parseInt(process.env.FORGE_HEARTBEAT_INTERVAL_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/** Heartbeat TTL: older than this ⇒ unresponsive (ms). */
function heartbeatTtlMs() {
  const v = parseInt(process.env.FORGE_HEARTBEAT_TTL_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 20000;
}

/**
 * Classify an instance as 'running' | 'unresponsive' | 'dead'.
 * @param {Object} record
 * @param {Object} [ctx]  { alive, now, ttl } — precomputed values (optional)
 */
function classifyInstance(record, ctx = {}) {
  if (!record) return 'dead';
  const alive = ctx.alive != null ? ctx.alive : isPidAlive(record.pid);
  if (!alive) return 'dead';
  const ttl = ctx.ttl != null ? ctx.ttl : heartbeatTtlMs();
  const now = ctx.now != null ? ctx.now : Date.now();
  const beat = record.lastHeartbeat || record.startedAt || 0;
  if (!beat) return 'running';
  return (now - beat) > ttl ? 'unresponsive' : 'running';
}

/**
 * Build a parent→child tree from a flat instance list (for UI consumption).
 * Returns an array of root nodes; each node is { record, children: [...] }.
 * A record is a child if its pid === some other record's parentPid, or its
 * parentId matches another record's id.
 */
function buildInstanceTree(instances) {
  const list = Array.isArray(instances) ? instances : [];
  const byPid = new Map();
  const byId = new Map();
  for (const rec of list) {
    if (rec.pid) byPid.set(rec.pid, rec);
    if (rec.id) byId.set(rec.id, rec);
  }
  const nodes = new Map();
  for (const rec of list) nodes.set(rec, { record: rec, children: [] });
  const roots = [];
  for (const rec of list) {
    const node = nodes.get(rec);
    const parent = (rec.parentPid && byPid.get(rec.parentPid)) ||
                   (rec.parentId && byId.get(rec.parentId)) || null;
    if (parent && parent !== rec && nodes.has(parent)) {
      nodes.get(parent).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Best-effort read of the last run summary status for this instance.
 * Read-only; never throws into the caller. Returns null when no summary
 * exists yet (e.g. a still-running agent that has not finished a run).
 *
 * @param {Object} record  instance heartbeat record
 * @returns {string|null}  one of 'completed' | 'failed' | 'timeout' | ...
 */
function _readLastSummaryStatus(record) {
  try {
    if (!record || !record.sessionDir) return null;
    const jsonPath = path.join(record.sessionDir, 'summary.json');
    if (!fs.existsSync(jsonPath)) return null;
    const summary = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return summary && summary.status ? String(summary.status) : null;
  } catch (_) {
    return null;
  }
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
    { key: 'id',         label: 'ID/NAME',  width: 22 },
    { key: 'role',       label: 'ROLE',     width: 14 },
    { key: 'pid',        label: 'PID',      width: 8  },
    { key: 'parent',     label: 'PARENT',   width: 18 },
    { key: 'status',     label: 'STATUS',   width: 12 },
    { key: 'beatAge',    label: 'BEAT',     width: 6  },
    { key: 'lastStatus', label: 'LAST',     width: 10 },
    { key: 'cwd',        label: 'CWD',      width: 36 },
  ];

  const pad = (s, w) => {
    s = String(s == null ? '' : s);
    return s.length >= w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - s.length);
  };

  const header = cols.map(cl => pad(cl.label, cl.width)).join(' ');
  const lines = [c('1;36', header)];

  for (const inst of instances) {
    const state = inst.state || (inst.alive ? 'running' : 'dead');
    let statusText;
    if (state === 'running') statusText = c('32', 'running');
    else if (state === 'unresponsive') statusText = c('33', 'unresponsive');
    else statusText = c('31', 'dead');

    const parentTxt = inst.parentId || (inst.parentPid ? ('pid ' + inst.parentPid) : '-');
    const row = cols.map(cl => {
      if (cl.key === 'status') return pad(statusText, cl.width + (color ? 9 : 0));
      if (cl.key === 'parent') return pad(parentTxt, cl.width);
      if (cl.key === 'beatAge') return pad(inst.beatAge == null ? '-' : inst.beatAge, cl.width);
      if (cl.key === 'lastStatus') {
        const ls = inst.lastStatus;
        const txt = ls ? String(ls) : '-';
        const colored = !ls ? c('90', txt) : (ls === 'completed' ? c('32', txt) : c('33', txt));
        return pad(colored, cl.width + (color ? 9 : 0));
      }
      return pad(inst[cl.key], cl.width);
    }).join(' ');
    lines.push(row);
  }

  lines.push('');
  const parents = instances.filter(i => !i.parentId && !i.parentPid).length;
  const children = instances.length - parents;
  lines.push(c('90', instances.length + ' instance(s) (' + parents + ' root, ' + children +
    ' child). Use: forge-agent ps --json for machine output.'));
  return lines.join('\n');
}

module.exports = {
  baseDir,
  sessionsRoot,
  sessionDirFor,
  instancesRoot,
  heartbeatFileFor,
  generateSessionName,
  writeHeartbeat,
  updateHeartbeat,
  removeHeartbeat,
  listInstances,
  findInstance,
  isPidAlive,
  formatInstanceTable,
  classifyInstance,
  heartbeatIntervalMs,
  heartbeatTtlMs,
  buildInstanceTree,
};
