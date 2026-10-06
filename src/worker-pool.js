// src/worker-pool.js — Concurrency-capped pool of child agents.
//
// Phase 5 (throughput). Given a list of independent tasks (e.g. open
// FORGE_TODO.md items, or a batch of file-scoped jobs), run up to
// `maxParallel` child agents at once. Each child gets its own --session (its
// own Chromium profile), so they truly run in parallel. This is the biggest
// throughput win for independent work.
//
// Safety:
//   - Hard cap on concurrency (default MAX_PARALLEL_TOOL_CALLS or 3).
//   - Each task gets a unique session name derived from a slug + index.
//   - Results are collected per-task; a failure does not stop the others
//     unless `stopOnError` is set.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const supervisor = require('./agent-supervisor');

const DEFAULT_MAX_PARALLEL = 3;

/** Turn a task string into a short, filesystem-safe slug. */
function slugify(text, fallback = 'task') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return s || fallback;
}

/**
 * Spawn one child and resolve when it exits.
 * @returns {Promise<{task, session, code, signal, ok}>}
 */
function runChild(task, opts, index) {
  return new Promise((resolve) => {
    const session = `${opts.sessionPrefix || 'worker'}-${slugify(task)}-${index}`;
    const cwd = opts.cwd || process.cwd();

    // Context handoff (optional): seed the child's SESSION_CONTEXT.md.
    if (opts.context) {
      try {
        const { SessionContext } = require('./session-context');
        const sc = new SessionContext({ projectDir: cwd, sessionName: session, task });
        sc.create();
        sc.addDecision('Spawned by worker pool.');
        sc.data.open = String(opts.context).split('\n').filter(Boolean);
        sc.update();
      } catch (_) { /* best-effort */ }
    }

    const entry = supervisor.entryPoint();
    const args = [entry, '--session', session, '--role', session];
    if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
    args.push(task);

    const child = spawn(process.execPath, args, {
      cwd,
      stdio: opts.quiet ? 'ignore' : 'inherit',
      env: { ...process.env, FORGE_SUPERVISOR_SESSION: process.env.FORGE_SESSION_NAME || '' },
    });

    child.on('exit', (code, signal) => {
      resolve({ task, session, code, signal, ok: code === 0 });
    });
    child.on('error', (err) => {
      resolve({ task, session, code: -1, signal: null, ok: false, error: err.message });
    });
  });
}

/**
 * Run a list of independent tasks through a concurrency-capped pool.
 *
 * @param {string[]} tasks
 * @param {Object} [opts]
 * @param {number} [opts.maxParallel=3]  cap on concurrent children
 * @param {string} [opts.cwd]            working dir for children
 * @param {string} [opts.sessionPrefix]  session name prefix
 * @param {string} [opts.context]        shared context written to each child
 * @param {boolean}[opts.quiet]          silence child stdout/stderr
 * @param {boolean}[opts.stopOnError]    stop launching new work after a failure
 * @param {Function}[opts.onEvent]       called with {type,...} progress events
 * @returns {Promise<{results:Array, completed:number, failed:number}>}
 */
async function runPool(tasks, opts = {}) {
  const list = (tasks || []).filter(t => typeof t === 'string' && t.trim());
  const maxParallel = Math.max(1, opts.maxParallel || DEFAULT_MAX_PARALLEL);
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  const results = [];
  let nextIndex = 0;
  let active = 0;
  let completed = 0;
  let failed = 0;
  let stopped = false;

  return new Promise((resolve) => {
    const launchNext = () => {
      if (stopped) {
        if (active === 0) finish();
        return;
      }
      while (active < maxParallel && nextIndex < list.length) {
        const idx = nextIndex++;
        const task = list[idx];
        active++;
        onEvent({ type: 'start', index: idx, task });
        runChild(task, opts, idx).then((res) => {
          active--;
          results.push(res);
          if (res.ok) { completed++; onEvent({ type: 'done', index: idx, task, result: res }); }
          else {
            failed++;
            onEvent({ type: 'fail', index: idx, task, result: res });
            if (opts.stopOnError) stopped = true;
          }
          if (active === 0 && (nextIndex >= list.length || stopped)) finish();
          else launchNext();
        });
      }
      if (list.length === 0) finish();
    };

    let _finished = false;
    const finish = () => {
      if (_finished) return;
      _finished = true;
      onEvent({ type: 'complete', completed, failed, total: list.length });
      resolve({ results, completed, failed });
    };

    launchNext();
  });
}

module.exports = { runPool, slugify, DEFAULT_MAX_PARALLEL };
