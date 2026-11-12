// src/agent-supervisor.js — Spawn and control child Forge Agent instances.
//
// Implements docs/SPAWN_PROTOCOL.md. A parent instance can:
//   * spawn a child in its OWN terminal window (src/spawn-window.js)
//   * assign it an independent session + a limited task (SESSION_TASK.md)
//   * hold its PID and unique identifier (forge-<session>-<pid>)
//   * monitor it via heartbeats and the session registry
//   * stop it gracefully, escalating to force kill
//
// NOTE on sharing a browser: each child MUST use its own --session (its own
// Chromium profile dir). Chromium's launchPersistentContext takes an exclusive
// lock, so two agents cannot share one profile/window. Coordination happens via
// files (SESSION_CONTEXT.md / SESSION_TASK.md), never the browser.
'use strict';

const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');

const registry   = require('./session-registry');
const spawnWindow = require('./spawn-window');
const spawnTask   = require('./spawn-task');
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

function sanitizeId(s) {
  return String(s || 'child').replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Spawn a child agent in a NEW window.
 *
 * @param {Object} opts
 * @param {string} opts.session   session name for the child (required, unique)
 * @param {string} opts.task      task string for the child (required)
 * @param {string} [opts.role]    role label
 * @param {string} [opts.cwd]     working directory for the child
 * @param {string} [opts.context] extra context written to the child's files
 * @param {string[]} [opts.subtasks] explicit subtasks for SESSION_TASK.md
 * @param {string} [opts.taskFile] explicit path for SESSION_TASK.md
 * @param {string[]} [opts.extraArgs] extra CLI args
 * @param {boolean} [opts.detached] detach so it outlives the supervisor
 * @param {boolean} [opts.noWindow] force headless (tests / no terminal)
 * @returns {{ pid:number|null, session:string, identifier:string, cwd:string,
 *             entry:string, mode:string, taskFile:string }}
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
  const role = opts.role || session;
  const parentId = process.env.FORGE_SESSION_NAME || '';
  const parentPid = process.pid;

  // 4.2 context handoff: seed a scoped SESSION_CONTEXT.md for the child,
  // INSIDE its own session dir so children in the same cwd never share it.
  const childSessionDir = registry.sessionDirFor(session);
  if (opts.context) {
    try {
      const sc = new SessionContext({ projectDir: childSessionDir, sessionName: session, task });
      sc.create();
      sc.addDecision('Spawned by supervisor with handed-off context.');
      sc.data.open = String(opts.context).split('\n').filter(Boolean);
      sc.update();
    } catch (_) { /* best-effort */ }
  }

  // Write the child's PER-INSTANCE task file BEFORE spawning so it exists
  // immediately. It lives inside the child's own session dir (unique per
  // instance) so multiple children in the same cwd never collide.
  const provisionalId = 'forge-' + sanitizeId(session);
  const taskFileRes = spawnTask.writeTaskFile({
    dir: cwd,
    sessionDir: childSessionDir,
    taskFile: opts.taskFile,
    identifier: provisionalId,
    session,
    parentId,
    parentPid,
    role,
    cwd,
    task,
    subtasks: opts.subtasks,
    context: opts.context,
  });
  const taskFile = taskFileRes.path;

  const args = [entry, '--session', session, '--role', role];
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  args.push(task);

  const childEnv = {
    ...process.env,
    FORGE_SUPERVISOR_SESSION: parentId,
    FORGE_PARENT_ID: parentId,
    FORGE_PARENT_PID: String(parentPid),
    FORGE_TASK_FILE: taskFile,
    FORGE_SPAWN_WINDOW: opts.noWindow ? 'headless' : 'new',
  };

  // Launch in a new window. The launcher returns the OS pid of the window
  // host (cmd.exe / terminal emulator). For the headless path the pid is the
  // node process; for a window path it is the window host — both are tracked.
  const launch = spawnWindow.launchInWindow({
    node: process.execPath,
    entry,
    args,
    cwd,
    title: 'Forge ' + session,
    env: childEnv,
    forceHeadless: !!opts.noWindow,
    platform: opts.platform,
  });

  const pid = launch.pid;
  const identifier = 'forge-' + sanitizeId(session) + '-' + (pid || 'x');

  // Upgrade the task file with the final identifier (same per-instance path).
  try {
    spawnTask.writeTaskFile({
      dir: cwd, sessionDir: childSessionDir, taskFile,
      identifier, session, parentId, parentPid, role, cwd,
      task, subtasks: opts.subtasks, context: opts.context,
    });
  } catch (_) {}

  // Record a provisional heartbeat so `ps` sees the child immediately, and so
  // the parent holds the child's pid/identifier in the registry.
  writeChildRecord({
    session, identifier, role, pid, cwd,
    parentId, parentPid, taskFile, mode: launch.mode,
  });

  return { pid, session, identifier, cwd, entry, mode: launch.mode, taskFile };
}

/**
 * Write a provisional registry record for a freshly spawned child, keyed by
 * session. The child overwrites it with its own live heartbeat on start.
 */
function writeChildRecord(info) {
  const file = registry.heartbeatFileFor(info.session);
  try {
    fs.mkdirSync(registry.sessionDirFor(info.session), { recursive: true });
  } catch (_) { /* ignore */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = {
      id: info.session,
      name: info.session,
      identifier: info.identifier,
      role: info.role || info.session,
      pid: info.pid || null,
      ppid: process.pid,
      parentId: info.parentId || null,
      parentPid: info.parentPid || null,
      isChild: true,
      taskFile: info.taskFile || null,
      window: info.mode || null,
      cwd: info.cwd,
      model: null,
      profile: null,
      status: 'starting',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      sessionDir: registry.sessionDirFor(info.session),
      argv: '',
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  } catch (_) { /* best-effort */ }
}

// ─────────────────────────────────────────────
//  Monitor
// ─────────────────────────────────────────────

/** List instances (parents + children) via the registry. */
function listChildren(opts = {}) {
  return registry.listInstances(opts);
}

/** Find one instance by identifier, session name, or unique prefix. */
function findChild(nameOrPrefix) {
  if (!nameOrPrefix) return null;
  const all = registry.listInstances({ includeDead: true });
  const exact = all.find(i =>
    i.identifier === nameOrPrefix || i.id === nameOrPrefix || i.name === nameOrPrefix);
  if (exact) return exact;
  const matches = all.filter(i =>
    (i.identifier || '').startsWith(nameOrPrefix) || (i.id || '').startsWith(nameOrPrefix));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Read a child's SESSION_CONTEXT.md (progress), if present.
 * Reads the PER-INSTANCE file from the child's own session dir by default
 * (so multiple children never share one context file). Pass an explicit
 * `cwd` only when you really want to read a legacy shared file.
 */
function readChildContext(sessionName, cwd) {
  try {
    let dir = cwd;
    if (!dir) {
      const inst = findChild(sessionName);
      dir = (inst && inst.sessionDir) || registry.sessionDirFor(sessionName);
    }
    const file = path.join(dir, 'SESSION_CONTEXT.md');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

/** Read + parse a child's SESSION_TASK.md progress. */
function readChildTask(nameOrPrefix) {
  const inst = findChild(nameOrPrefix);
  const file = inst && inst.taskFile;
  const content = spawnTask.readTaskFile(file);
  if (!content) return null;
  return { file, ...spawnTask.parseTaskFile(content) };
}

// ─────────────────────────────────────────────
//  Kill (graceful -> force)
// ─────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Send a terminate signal to a pid. On win32 this runs taskkill and returns a
 * promise that resolves when taskkill exits (so callers can poll reliably).
 * On POSIX it sends the signal synchronously and resolves immediately.
 */
function terminate(pid, force) {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        const r = spawn('taskkill', args, { stdio: 'ignore' });
        r.on('error', finish);
        r.on('exit', finish);
        // Safety: never hang the kill if taskkill misbehaves.
        const t = setTimeout(finish, 1500);
        if (t && typeof t.unref === 'function') t.unref();
      } catch (_) { finish(); }
    });
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (_) {}
  return Promise.resolve();
}

/**
 * Kill a child by identifier, session name, unique prefix, or PID.
 * Graceful first, then force after graceMs.
 *
 * @param {string|number} nameOrPid
 * @param {Object} [opts] { graceMs, force }
 * @returns {Promise<{ ok:boolean, pid?:number, error?:string, escalated?:boolean }>}
 */
async function killChild(nameOrPid, opts = {}) {
  const graceMs = opts.graceMs != null ? opts.graceMs : 5000;
  let pid = null;
  let inst = null;

  if (typeof nameOrPid === 'number') {
    pid = nameOrPid;
    inst = findChildByPid(pid);
  } else {
    inst = findChild(nameOrPid);
    if (!inst) return { ok: false, error: 'No matching child instance: ' + nameOrPid };
    pid = inst.pid;
  }
  if (!pid) return { ok: false, error: 'No PID for child.' };

  // Safety: only kill known Forge instances unless force is explicit.
  if (!inst && !opts.force) {
    return { ok: false, pid, error: 'PID is not a known Forge instance; pass force to override.' };
  }

  const doCleanup = opts.cleanup !== false;
  const finish = (extra) => {
    markKilled(inst);
    if (doCleanup) cleanupChild(inst);
    return Object.assign({ ok: true, pid }, extra);
  };

  if (!registry.isPidAlive(pid)) {
    return finish({ alreadyDead: true });
  }

  // Graceful terminate.
  await terminate(pid, false);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!registry.isPidAlive(pid)) {
      return finish({ escalated: false });
    }
  }

  // Escalate to force.
  await terminate(pid, true);
  await sleep(200);
  if (!registry.isPidAlive(pid)) {
    return finish({ escalated: true });
  }
  return { ok: false, pid, error: 'Process survived force kill.' };
}

/**
 * Clean up a terminal child's per-instance artifacts: its task file, its
 * session dir (browser profile + scoped context), and its registry file.
 * Best-effort; never throws. Safe to call for an already-gone child.
 *
 * @param {Object} inst  registry record (needs sessionDir / taskFile / id)
 * @param {Object} [opts] { keepTaskFile?:boolean }
 * @returns {{ removed:boolean, dir:string|null, taskFile:string|null }}
 */
function cleanupChild(inst, opts = {}) {
  const out = { removed: false, dir: null, taskFile: null };
  if (!inst) return out;
  try {
    const id = inst.id || inst.name;
    const dir = inst.sessionDir || (id ? registry.sessionDirFor(id) : null);
    const taskFile = inst.taskFile || null;

    if (taskFile && opts.keepTaskFile !== true) {
      spawnTask.cleanupTaskFile(taskFile);
      out.taskFile = taskFile;
    }
    // Remove the whole session dir (profile + scoped context + task file).
    if (dir) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          out.removed = true;
        }
      } catch (_) { /* best-effort */ }
      out.dir = dir;
    }
    // Remove the canonical registry heartbeat file.
    if (id) {
      try { fs.unlinkSync(registry.heartbeatFileFor(id)); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
  return out;
}

/**
 * Prune ORPHANED child artifacts: session dirs + registry files whose recorded
 * PID is dead. Live children are never touched.
 *
 * @param {Object} [opts] { includeUnresponsive?:boolean }
 * @returns {{ pruned:number, ids:string[] }}
 */
function pruneOrphans(opts = {}) {
  const pruned = [];
  let all = [];
  try { all = registry.listInstances({ includeDead: true }); } catch (_) { return { pruned: 0, ids: [] }; }
  for (const inst of all) {
    const alive = registry.isPidAlive(inst.pid);
    const state = registry.classifyInstance(inst, { alive });
    if (state === 'dead') {
      cleanupChild(inst);
      pruned.push(inst.id || inst.name);
    }
  }
  return { pruned: pruned.length, ids: pruned };
}

function findChildByPid(pid) {
  const all = registry.listInstances({ includeDead: true });
  return all.find(i => i.pid === pid) || null;
}

/** Mark an instance record as killed (best-effort). */
function markKilled(inst) {
  if (!inst || !inst.id) return;
  try {
    const file = registry.heartbeatFileFor(inst.id);
    if (!fs.existsSync(file)) return;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.status = 'killed';
    rec.lastHeartbeat = Date.now();
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  } catch (_) { /* ignore */ }
}

module.exports = {
  spawnAgent,
  listChildren,
  findChild,
  readChildContext,
  readChildTask,
  killChild,
  cleanupChild,
  pruneOrphans,
  entryPoint,
};
