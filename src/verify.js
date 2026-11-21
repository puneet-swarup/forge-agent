// src/verify.js — prove the work before accepting "done".
//
// Why this exists
// ---------------
// TASK_COMPLETE meant "the model said so". A coding agent that declares success
// without running anything is a demo, not a tool. This module detects the
// project's own checks and runs the cheapest one before completion is accepted.
//
// Design rules
// ------------
//  - Detect, never invent: only run a command the project already declares
//    (a package.json script, a Makefile target, a Cargo workspace).
//  - Cheapest first: typecheck, then lint, then tests. A type error is cheaper
//    to report than a failing suite.
//  - Bounded: one command, a hard timeout, capped output. Never a shell string
//    assembled from model input.
//  - Honest: when there is nothing to run, the run is reported as *unverified*
//    rather than as verified.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_OUTPUT = 4000;

/** Script names worth running, cheapest first. */
const SCRIPT_ORDER = ['typecheck', 'lint', 'test'];

/** The npm default that means "no tests configured". */
const NPM_DEFAULT_TEST = /no test specified/i;

/**
 * Work out which checks a project declares.
 *
 * @param {string} dir
 * @returns {Array<{name: string, command: string, args: string[], source: string}>}
 */
function detectChecks(dir = process.cwd()) {
  const checks = [];

  // ── Node ────────────────────────────────────────────────────────────────
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};

      for (const name of SCRIPT_ORDER) {
        const body = scripts[name];
        if (!body) continue;
        if (name === 'test' && NPM_DEFAULT_TEST.test(body)) continue;
        checks.push({
          name,
          command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
          args: ['run', name, '--silent'],
          source: 'package.json',
        });
      }
    } catch (_) {
      // A malformed package.json is not a reason to block completion.
    }
  }

  // ── Make ────────────────────────────────────────────────────────────────
  const makefile = path.join(dir, 'Makefile');
  if (fs.existsSync(makefile)) {
    try {
      const body = fs.readFileSync(makefile, 'utf8');
      for (const target of ['check', 'test']) {
        if (new RegExp(`^${target}:`, 'm').test(body)) {
          checks.push({ name: target, command: 'make', args: [target], source: 'Makefile' });
          break;
        }
      }
    } catch (_) { /* ignore */ }
  }

  // ── Python ──────────────────────────────────────────────────────────────
  for (const marker of ['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg']) {
    if (fs.existsSync(path.join(dir, marker))) {
      checks.push({ name: 'pytest', command: 'python', args: ['-m', 'pytest', '-q'], source: marker });
      break;
    }
  }

  // ── Rust / Go ───────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
    checks.push({ name: 'cargo test', command: 'cargo', args: ['test', '--quiet'], source: 'Cargo.toml' });
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) {
    checks.push({ name: 'go test', command: 'go', args: ['test', './...'], source: 'go.mod' });
  }

  return checks;
}

/**
 * Run one check.
 *
 * @param {{command: string, args: string[], name: string}} check
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{name: string, command: string, ok: boolean, exitCode: number|null, output: string, timedOut: boolean}>}
 */
function runCheck(check, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs || 120_000;

  // Windows cannot execFile('npm', …) — npm is a .cmd shim, and Node reports
  // EINVAL synchronously. A spawn that cannot even start used to reject the
  // promise, which surfaced as "Unexpected error: spawn EINVAL" at the end of
  // every Windows run: the verification gate crashed the run it was meant to
  // protect. Both are handled here.
  const needsShell = process.platform === 'win32';

  // On Windows a .cmd shim needs a shell, and Node warns (DEP0190) that args are
  // concatenated rather than escaped when shell:true. Quote them ourselves and
  // pass an empty args array so nothing is left for Node to concatenate.
  const quoteForCmd = (value) => {
    const text = String(value);
    if (!/[\s"&|<>^]/.test(text)) return text;
    return '"' + text.replace(/"/g, '""') + '"';
  };

  const command = needsShell && check.args.length
    ? [check.command, ...check.args.map(quoteForCmd)].join(' ')
    : check.command;
  const commandArgs = needsShell && check.args.length ? [] : check.args;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    const onResult = (err, stdout, stderr) => {
        const timedOut = Boolean(err && (err.killed || err.signal));
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;

        const raw = [String(stdout || ''), String(stderr || '')].filter(Boolean).join('\n');
        const output = raw.length > MAX_OUTPUT
          ? raw.slice(0, MAX_OUTPUT) + `\n… (${raw.length - MAX_OUTPUT} more characters)`
          : raw;

        done({
          name: check.name,
          command: [check.command, ...check.args].join(' '),
          ok: exitCode === 0 && !timedOut,
          exitCode: timedOut ? null : exitCode,
          timedOut,
          output: output.trim(),
        });
    };

    try {
      execFile(
        command,
        commandArgs,
        { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env, shell: needsShell },
        onResult
      );
    } catch (err) {
      // EINVAL, ENOENT, a bad cwd — report it as a check that could not run,
      // never as an exception the caller has to catch.
      done({
        name: check.name,
        command: [check.command, ...check.args].join(' '),
        ok: false,
        exitCode: null,
        timedOut: false,
        spawnFailed: true,
        output: `Could not start \`${check.command}\`: ${err.message}`,
      });
    }
  });
}

/**
 * Detect and run the first available check.
 *
 * @param {object} [opts] { cwd, timeoutMs, checks }
 * @returns {Promise<{ran: boolean, result: object|null, available: number}>}
 */
async function verifyProject(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const checks = opts.checks || detectChecks(cwd);

  if (checks.length === 0) {
    return { ran: false, result: null, available: 0 };
  }

  const result = await runCheck(checks[0], { cwd, timeoutMs: opts.timeoutMs });
  return { ran: true, result, available: checks.length };
}

/**
 * Human summary for logs and the run summary.
 * @param {{ran: boolean, result: object|null}} verification
 * @returns {string}
 */
function describeVerification(verification) {
  if (!verification || !verification.ran) {
    return 'no project checks found — completion is unverified';
  }
  const r = verification.result;
  if (r.spawnFailed) return `NOT verified: could not run \`${r.command}\``;
  if (r.ok) return `verified: \`${r.command}\` passed`;
  if (r.timedOut) return `NOT verified: \`${r.command}\` timed out`;
  return `NOT verified: \`${r.command}\` exited ${r.exitCode}`;
}

module.exports = {
  detectChecks,
  runCheck,
  verifyProject,
  describeVerification,
  SCRIPT_ORDER,
  MAX_OUTPUT,
};
