// src/lifecycle-gate.js — the plan gate: a plan before the work, no open steps at "done".
//
// Why this exists
// ---------------
// src/lifecycle.js declares the contract (FORGE_PLAN.md is created at task
// start, ticked per step, kept until sign-off) and scripts/lifecycle.js can
// check it — but nothing in the agent loop ever called those checks. A model
// could skip the plan entirely, or report TASK_COMPLETE with half its own steps
// still unchecked, and the loop accepted both.
//
// This module turns the contract into two decisions the loop can act on:
//
//   decideStart()  before the first mutating tool of a task
//   decideEnd()    when the model reports TASK_COMPLETE
//
// Design rules (the same ones the verification gate follows)
// ---------------------------------------------------------
//  - Refuse, feed back, bound. A refusal returns a message the model can act on
//    and the loop sends it back; after `maxAttempts` the gate steps aside
//    rather than blocking the task forever.
//  - Never deadlock. Writing FORGE_PLAN.md is always allowed, otherwise the
//    gate could never be satisfied. A missing plan at completion is reported,
//    not refused — the start gate already had its bounded chance.
//  - Quiet on small tasks. A single-step task ("create hello.js") is not asked
//    for a plan; `multistepOnly` can be turned off to gate every task.
//  - Pure decisions. No logging, no I/O beyond reading the artifact files, so
//    every branch is unit-testable.
'use strict';

const path = require('path');
const { checkStart, checkEnd, readArtifact, PLAN_FILE } = require('./lifecycle');

const DEFAULT_MAX_ATTEMPTS = 2;

/** Conjunctions and sequence markers that make a task "multi-step". */
const MULTI_STEP_MARKERS = [
  /\bthen\b/i,
  /\bafter that\b/i,
  /\bafterwards\b/i,
  /\bfinally\b/i,
  /\bfirst\b/i,
  /\bnext\b/i,
  /\band also\b/i,
  /\balso\b/i,
  /;\s/,
  /\n\s*[-*]\s+\S/,
  /\bstep\s*\d/i,
  /\d+[.)]\s+\S/,
];

/** Argument keys that carry a destination path. */
const PATH_KEYS = ['path', 'file', 'file_path', 'filename'];

/**
 * Does this task read like more than one step?
 *
 * Deliberately conservative: a short, single-clause instruction does not get a
 * plan gate, because one extra round trip on "create hello.js" is pure friction.
 * Length is the fallback signal, since a long instruction is almost never one
 * action.
 *
 * @param {string} task
 * @returns {boolean}
 */
function looksMultiStep(task) {
  const text = String(task || '').trim();
  if (!text) return false;
  if (text.length > 160) return true;
  return MULTI_STEP_MARKERS.some((re) => re.test(text));
}

/** Every path-looking argument of a tool call. */
function pathsOf(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string') out.push(args[key]);
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (f && typeof f.path === 'string') out.push(f.path);
    }
  }
  return out;
}

/**
 * Is this tool call a write to the plan file itself?
 *
 * Such a call must always be allowed: it is how the model satisfies the gate.
 *
 * @param {string} _toolName
 * @param {object} args
 * @returns {boolean}
 */
function isPlanWrite(_toolName, args) {
  return pathsOf(args).some((p) => {
    const normalised = String(p).replace(/\\/g, '/');
    return path.posix.basename(normalised) === PLAN_FILE;
  });
}

/** The message the model gets when it tried to work without a plan. */
function formatStartFeedback(errors) {
  const why = (errors && errors.length)
    ? errors.join('; ')
    : 'there is no FORGE_PLAN.md for this task';
  return [
    'Plan gate: ' + why + '.',
    '',
    'Before changing anything, write ' + PLAN_FILE + ' with the steps of this task as checkboxes:',
    '',
    '# FORGE_PLAN — <the task in one line>',
    '',
    '- [ ] first step',
    '- [ ] second step',
    '',
    'Then tick each step ("- [x]") as you finish it. That write to ' + PLAN_FILE +
      ' is the one action still allowed; every other mutating tool is refused until the plan exists.',
  ].join('\n');
}

/** The message the model gets when it claims "done" with steps still open. */
function formatEndFeedback(errors) {
  const open = (errors && errors.length) ? errors.join('; ') : 'the plan is incomplete';
  return [
    'You reported TASK_COMPLETE, but the plan is not finished: ' + open + '.',
    '',
    'Tick every step you actually completed ("- [x]"), drop steps that are no longer part of the task, ' +
      'or delete ' + PLAN_FILE + ' if it no longer describes this task. Then finish again.',
  ].join('\n');
}

/**
 * Task-start decision, made before the first mutating tool call.
 *
 * @param {object} opts
 * @param {string} opts.dir            project directory
 * @param {string} opts.task           the task text
 * @param {number} [opts.attempt]      refusals already issued this run
 * @param {number} [opts.maxAttempts]  bound (default 2)
 * @param {boolean} [opts.enabled]     PLAN_GATE
 * @param {boolean} [opts.multistepOnly] PLAN_GATE_MULTISTEP_ONLY
 * @returns {{allow: boolean, reason: string, errors: string[], feedback?: string}}
 */
function decideStart(opts = {}) {
  const dir = opts.dir || process.cwd();
  const attempt = Number.isFinite(opts.attempt) ? opts.attempt : 0;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const enabled = opts.enabled !== false;
  const multistepOnly = opts.multistepOnly !== false;

  if (!enabled) return { allow: true, reason: 'disabled', errors: [] };

  const errors = checkStart(dir);
  if (errors.length === 0) return { allow: true, reason: 'plan-present', errors: [] };

  if (multistepOnly && !looksMultiStep(opts.task)) {
    return { allow: true, reason: 'single-step', errors };
  }

  if (attempt >= maxAttempts) {
    return { allow: true, reason: 'exhausted', errors, exhausted: true };
  }

  return { allow: false, reason: 'refused', errors, feedback: formatStartFeedback(errors) };
}

/**
 * Completion decision, made when the model reports TASK_COMPLETE.
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {number} [opts.attempt]
 * @param {number} [opts.maxAttempts]
 * @param {boolean} [opts.enabled]
 * @returns {{allow: boolean, reason: string, errors: string[], feedback?: string}}
 */
function decideEnd(opts = {}) {
  const dir = opts.dir || process.cwd();
  const attempt = Number.isFinite(opts.attempt) ? opts.attempt : 0;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;

  if (opts.enabled === false) return { allow: true, reason: 'disabled', errors: [] };

  const errors = checkEnd(dir);
  if (errors.length === 0) return { allow: true, reason: 'complete', errors: [] };

  // No plan file at all: the start gate already had its bounded chance, so this
  // is reported rather than refused. Refusing here could trap a run whose plan
  // was never created and can no longer be created.
  if (readArtifact(dir, PLAN_FILE) === null) {
    return { allow: true, reason: 'no-plan-file', errors };
  }

  if (attempt >= maxAttempts) {
    return { allow: true, reason: 'exhausted', errors, exhausted: true };
  }

  return { allow: false, reason: 'open-steps', errors, feedback: formatEndFeedback(errors) };
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  MULTI_STEP_MARKERS,
  looksMultiStep,
  isPlanWrite,
  pathsOf,
  formatStartFeedback,
  formatEndFeedback,
  decideStart,
  decideEnd,
};
