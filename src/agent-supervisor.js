// src/agent-supervisor.js — Spawn and control child Forge Agent instances.
//
// Phase 4 (Supervisor Mode). A supervisor instance can:
//   4.1 spawn a child  `forge-agent --session <name> "<task>"`
//   4.2 hand off context (writes a scoped SESSION_CONTEXT.md / TODO slice)
//   4.3 monitor children via the session registry (heartbeat + PID)
//   4.4 kill a child by name/PID
//
// NOTE on sharing a browser: each child MUST use its own --session (its own
// Chromium profile dir). Chromium's launchPersistentContext takes an exclusive
// lock, so two agents cannot share one profile/window. Coordination happens via
// files (SESSION_CONTEXT.md / FORGE_TODO.md), never the browser.
'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { spawn } = require('child_process');

const registry = require('./session-registry');
const { SessionContext } = require('./session-context');

// ─────────────────────────────────────────────
//  Spawn
// ─────────────────────────────────────────────

/**
 * Resolve the forge-agent entry point.
 * Prefers the package bin; falls back to src/index.js next to this file.
 */
function entryPoint() {
  try {
    const pkg = require('../package.json');
    if (pkg && pkg.bin) {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
      if (bin) {
        const p = path.resolve(__dirname, '..', bin);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* ignore */ }
  return path.join(__dirname, 'index.js');
}

/**
 * Spawn a child agent.
 *
 * @param {Object} opts
 * @param {string} opts.session   session name for the child (required, unique)
 * @param {string} opts.task      task string for the child (required)
 * @param {string} [opts.role]    role label
 * @param {string} [opts.cwd]     working directory for the child
 * @param {string} [opts.context] extra context written to the child's SESSION_CONTEXT.md
 * @param {string[]} [opts.extraArgs] extra CLI args
 * @param {boolean} [opts.detached] detach so it outlives the supervisor
 * @returns {{ pid:number, session:string, cwd:string, entry:string }}
 */
function spawnAgent(opts = {}) {
  const session = opts.session;
  const task = opts.task;
  if (!session || typeof session !== 'string') {
    throw new Error('spawnAgent: a unique session name is required.');
  }
  if (!task || typeof task !== 'string') {
    throw new Error('spawnAgent: a task string is required.');
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  const entry = entryPoint();

  // 4.2 context handoff: seed a scoped SESSION_CONTEXT.md for the child.
  if (opts.context) {
    try {
      const sc = new SessionContext({ projectDir: cwd, sessionName: session, task });
      sc.create();
      sc.addDecision('Spawned by supervisor with handed-off context.');
      sc.data.open = String(opts.context).split('\n').filter(Boolean);
      sc.update();
    } catch (_) { /* best-effort */ }
  }

  const args = [entry, '--session', session, '--role', opts.role || session];
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  args.push(task);

  const child = spawn(process.execPath, args, {
    cwd,
    detached: !!opts.detached,
    stdio: opts.detached ? 'ignore' : 'inherit',
    env: { ...process.env, FORGE_SUPERVISOR_SESSION: process.env.FORGE_SESSION_NAME || '' },
  });

  if (opts.detached) child.unref();

  // Best-effort: write a heartbeat immediately so `ps` sees it before the
  // child's own registry write lands.
  try {
    fs.mkdirSync(registry.sessionDirFor(session), { recursive: true });
  } catch (_) { /* ignore */ }

  return { pid: child.pid, session, cwd, entry };
}

// ─────────────────────────────────────────────
//  Monitor
// ─────────────────────────────────────────────

/**
 * List child instances. Thin wrapper over the session registry.
 * @param {Object} opts  { includeDead, prune }
 */
function listChildren(opts = {}) {
  return registry.listInstances(opts);
}

/** Find one child by session name (or unique prefix). */
function findChild(nameOrPrefix) {
  return registry.findInstance(nameOrPrefix);
}

/** Read a child's SESSION_CONTEXT.md (progress), if present. */
function readChildContext(sessionName, cwd) {
  try {
    const dir = cwd || process.cwd();
    const file = path.join(dir, 'SESSION_CONTEXT.md');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────
//  Kill
// ─────────────────────────────────────────────

/**
 * Kill a child by session name or PID. Uses the recorded heartbeat PID when a
 * name is given.
 * @returns {{ ok:boolean, pid?:number, error?:string }}
 */
function killChild(nameOrPid) {
  let pid = null;
  if (typeof nameOrPid === 'number') {
    pid = nameOrPid;
  } else {
    const inst = registry.findInstance(nameOrPid);
    if (!inst) return { ok: false, error: 'No matching child instance: ' + nameOrPid };
    pid = inst.pid;
  }
  if (!pid) return { ok: false, error: 'No PID for child.' };
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, pid };
  } catch (e) {
    // Try a hard kill as a fallback.
    try { process.kill(pid, 'SIGKILL'); return { ok: true, pid }; }
    catch (e2) { return { ok: false, pid, error: e2.message }; }
  }
}

module.exports = {
  spawnAgent,
  listChildren,
  findChild,
  readChildContext,
  killChild,
  entryPoint,
};
