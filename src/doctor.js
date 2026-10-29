// src/doctor.js — One-command health check for Forge Agent.
//
// Runs a set of read-only checks (Node version, config validity, Chromium /
// Playwright availability, session dirs, login state hints) and renders a
// friendly PASS/WARN/FAIL report. Designed to answer "why isn't this working?"
// in one command.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const OK   = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

function _check(name, status, detail, hint) {
  return { name, status, detail: detail || '', hint: hint || '' };
}

/** Node version >= 20. */
function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) return _check('Node.js version', OK, `v${process.versions.node}`);
  return _check('Node.js version', FAIL, `v${process.versions.node}`, 'Forge Agent requires Node >= 20. Upgrade Node.js.');
}

/** Playwright package + Chromium binary presence. */
function checkPlaywright() {
  let pw;
  try { pw = require('playwright'); } catch (_) {
    return _check('Playwright', FAIL, 'not installed', 'Run: npm install (playwright is a devDependency for browser control).');
  }
  if (!pw || !pw.chromium) {
    return _check('Playwright', FAIL, 'chromium API missing', 'Reinstall: npm install playwright');
  }
  // Best-effort: does a chromium executable exist on disk?
  let exePath = null;
  try { exePath = pw.chromium.executablePath(); } catch (_) {}
  if (exePath && fs.existsSync(exePath)) {
    return _check('Chromium browser', OK, 'installed');
  }
  return _check('Chromium browser', WARN, 'not found on disk', 'Install it: npx playwright install chromium');
}

/** Config object validity. */
function checkConfig() {
  try {
    const config = require('./config');
    const model = config.MODEL;
    if (!model) return _check('Configuration', WARN, 'MODEL not set', 'Run: forge-agent --setup');
    const issues = [];
    if (typeof config.RESPONSE_TIMEOUT !== 'number') issues.push('RESPONSE_TIMEOUT');
    if (issues.length) return _check('Configuration', WARN, 'odd values: ' + issues.join(', '), 'Run: forge-agent --setup to reset.');
    return _check('Configuration', OK, `model=${model}, profile=${config.ACTIVE_PROFILE}`);
  } catch (e) {
    return _check('Configuration', FAIL, e.message, 'Check forge-agent.config.json is valid JSON.');
  }
}

/** Session/data directories exist and are writable. */
function checkDirs() {
  try {
    const config = require('./config');
    const dir = path.dirname(config.SESSION_DIR || require('./paths').forgePath('session'));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const probe = path.join(dir, '.doctor-write-test');
    try {
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return _check('Data directory', OK, dir);
    } catch (e) {
      return _check('Data directory', FAIL, 'not writable: ' + dir, 'Check filesystem permissions.');
    }
  } catch (e) {
    return _check('Data directory', WARN, e.message);
  }
}

/** Reported browser login state (heuristic from session profile existence). */
function checkLogin() {
  try {
    const config = require('./config');
    const sessionDir = config.SESSION_DIR;
    if (sessionDir && fs.existsSync(sessionDir)) {
      return _check('Browser profile', OK, 'session profile present', 'If login is required, run once interactively and log in.');
    }
    return _check('Browser profile', WARN, 'no profile yet', 'Run forge-agent once to create the browser profile and log in.');
  } catch (e) {
    return _check('Browser profile', WARN, e.message);
  }
}

/** Run every check; returns { results, worst }. */
function runDoctor() {
  const results = [];
  const checks = [checkNode, checkPlaywright, checkConfig, checkDirs, checkLogin];
  for (const fn of checks) {
    try { results.push(fn()); }
    catch (e) { results.push(_check(fn.name, WARN, e.message)); }
  }
  const order = { fail: 2, warn: 1, pass: 0 };
  let worst = OK;
  for (const r of results) if (order[r.status] > order[worst]) worst = r.status;
  return { results, worst };
}

/** Render the report as plain text. */
function formatDoctor(report) {
  const icon = { pass: '✓', warn: '!', fail: '✗' };
  const lines = [];
  lines.push('');
  lines.push('Forge Agent — Doctor');
  lines.push('='.repeat(40));
  for (const r of report.results) {
    lines.push(`  ${icon[r.status] || '?'} ${r.name.padEnd(22)} ${r.detail}`);
    if (r.hint && r.status !== OK) lines.push(`      ↳ ${r.hint}`);
  }
  lines.push('='.repeat(40));
  const verdict = report.worst === FAIL ? 'FAILURES found — see hints above.'
    : report.worst === WARN ? 'Mostly OK — some warnings.'
    : 'All checks passed.';
  lines.push('  ' + verdict);
  lines.push('');
  return lines.join('\
');
}

module.exports = { runDoctor, formatDoctor, checkNode, checkPlaywright, checkConfig, checkDirs, checkLogin };
