// src/worker-pool.js -- Concurrency-capped pool of child agents.
//
// Each task gets its own --session (its own Chromium profile) so children
// truly run in parallel. Results are INDEX-ALIGNED with the input list:
// results[i] always describes tasks[i], even when tasks finish out of order.
'use strict';

const { spawn } = require('child_process');

const supervisor = require('./agent-supervisor');

const DEFAULT_MAX_PARALLEL = 3;
const NL = String.fromCharCode(10);

function slugify(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return s || (fallback || 'task');
}

function buildChildEnv(session) {
  return Object.assign({}, process.env, { FORGE_SUPERVISOR_SESSION: session });
}

function seedContext(opts, cwd, session, task) {
  if (!opts.context) return;
  try {
    const SessionContext = require('./session-context').SessionContext;
    const sc = new SessionContext({ projectDir: cwd, sessionName: session, task: task });
    sc.create();
    sc.addDecision('Spawned by worker pool.');
    sc.data.open = String(opts.context).split(NL).filter(Boolean);
    sc.update();
  } catch (e) {
    void e;
  }
}

function runChild(task, opts, index) {
  return new Promise((resolve) => {
    const session = (opts.sessionPrefix || 'worker') + '-' + slugify(task) + '-' + index;
    const cwd = opts.cwd || process.cwd();

    seedContext(opts, cwd, session, task);

    const entry = supervisor.entryPoint();
    const args = [entry, '--session', session, '--role', session];
    if (Array.isArray(opts.extraArgs)) args.push.apply(args, opts.extraArgs);
    args.push(task);

    const child = spawn(process.execPath, args, {
      cwd: cwd,
      stdio: opts.quiet ? 'ignore' : 'inherit',
      env: buildChildEnv(session),
    });

    let killTimer = null;
    let hardKillTimer = null;
    if (Number(opts.childTimeout) > 0) {
      killTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (e) { void e; }
        hardKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e2) { void e2; }
        }, 5000);
      }, Number(opts.childTimeout));
    }

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
    };

    child.on('exit', (code, signal) => {
      clearTimers();
      resolve({ task: task, session: session, code: code, signal: signal, ok: code === 0 });
    });
    child.on('error', (err) => {
      clearTimers();
      resolve({ task: task, session: session, code: -1, signal: null, ok: false, error: err.message });
    });
  });
}

async function runPool(tasks, opts) {
  opts = opts || {};
  const list = (tasks || []).filter((t) => typeof t === 'string' && t.trim());
  const maxParallel = Math.max(1, opts.maxParallel || DEFAULT_MAX_PARALLEL);
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  const results = new Array(list.length);
  let nextIndex = 0;
  let active = 0;
  let completed = 0;
  let failed = 0;
  let stopped = false;

  return new Promise((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      onEvent({ type: 'complete', completed: completed, failed: failed, total: list.length });
      for (let i = 0; i < list.length; i++) {
        if (!results[i]) {
          results[i] = {
            task: list[i], session: null, code: null, signal: null,
            ok: false, skipped: true,
          };
        }
      }
      resolve({ results: results, completed: completed, failed: failed });
    };

    const launchNext = () => {
      if (finished) return;
      while (active < maxParallel && nextIndex < list.length) {
        const idx = nextIndex++;
        const task = list[idx];
        active++;
        onEvent({ type: 'start', index: idx, task: task });
        runChild(task, opts, idx).then((res) => {
          active--;
          results[idx] = res;
          if (res.ok) {
            completed++;
            onEvent({ type: 'done', index: idx, task: task, result: res });
          } else {
            failed++;
            onEvent({ type: 'fail', index: idx, task: task, result: res });
            if (opts.stopOnError) stopped = true;
          }
          if (active === 0 && (nextIndex >= list.length || stopped)) finish();
          else launchNext();
        });
      }
      if (list.length === 0) finish();
      else if (stopped && active === 0) finish();
    };

    launchNext();
  });
}

module.exports = {
  runPool: runPool,
  slugify: slugify,
  buildChildEnv: buildChildEnv,
  DEFAULT_MAX_PARALLEL: DEFAULT_MAX_PARALLEL,
  _buildChildEnvForTest: buildChildEnv,
};
