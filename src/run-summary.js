// src/run-summary.js - Durable, attributable per-run summaries.
// When several agents run, a human cannot remember which agent did what.
// Every terminal outcome writes a summary to the run's session dir:
//   <session>/summary.md   (human readable)
//   <session>/summary.json (machine readable)
// Best-effort; never throws into the agent.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96, 96, 96);

function resolveSummaryDir() {
  if (process.env.FORGE_SESSION_DIR) {
    try { return path.resolve(process.env.FORGE_SESSION_DIR); } catch (_) {}
  }
  const name = process.env.FORGE_SESSION_NAME || 'default';
  try { return require('./session-registry').sessionDirFor(name); } catch (_) {}
  return path.join(require('./paths').forgeHome(), 'sessions', name);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? (h + 'h' + (m % 60) + 'm') : (m + 'm' + (s % 60) + 's');
}

function listItems(items, limit) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return '_none_';
  const shown = arr.slice(0, limit);
  let out = shown.map(function (x) { return '- ' + (typeof x === 'string' ? x : JSON.stringify(x)); }).join(NL);
  if (arr.length > limit) out += NL + '- ...and ' + (arr.length - limit) + ' more';
  return out;
}

function buildSummary(info) {
  info = info || {};
  const session = info.session || process.env.FORGE_SESSION_NAME || 'default';
  const role = info.role || process.env.FORGE_ROLE || session;
  return {
    session: session,
    role: role,
    task: info.task || '(unknown)',
    status: info.status || 'unknown',
    model: info.model || null,
    profile: info.profile || null,
    workingDir: info.workingDir || process.cwd(),
    durationMs: info.durationMs || 0,
    duration: fmtDuration(info.durationMs || 0),
    steps: info.stepsCount || 0,
    filesWritten: Array.isArray(info.filesWritten) ? info.filesWritten : [],
    commandsRun: Array.isArray(info.commandsRun) ? info.commandsRun : [],
    errorCount: info.errorCount || 0,
    templateName: info.templateName || null,
    finalOutput: String(info.finalOutput || '').slice(0, 2000),
    finishedAt: new Date().toISOString(),
    pid: process.pid
  };
}

function renderMarkdown(s) {
  const lines = [];
  lines.push('# Run summary - ' + s.session);
  lines.push('');
  lines.push('- **Role:** ' + s.role);
  lines.push('- **Status:** ' + s.status);
  lines.push('- **Task:** ' + s.task);
  lines.push('- **Model / profile:** ' + (s.model || '?') + ' / ' + (s.profile || '?'));
  lines.push('- **Working dir:** ' + s.workingDir);
  lines.push('- **Duration:** ' + s.duration + ' (' + s.steps + ' steps, ' + s.errorCount + ' errors)');
  lines.push('- **Finished:** ' + s.finishedAt);
  if (s.templateName) lines.push('- **Template:** ' + s.templateName);
  lines.push('');
  lines.push('## Files written');
  lines.push(listItems(s.filesWritten, 50));
  lines.push('');
  lines.push('## Commands run');
  lines.push(listItems(s.commandsRun, 20));
  lines.push('');
  lines.push('## Final output');
  lines.push(FENCE);
  lines.push(s.finalOutput || '(empty)');
  lines.push(FENCE);
  lines.push('');
  return lines.join(NL);
}

function writeSummary(info) {
  try {
    const dir = resolveSummaryDir();
    fs.mkdirSync(dir, { recursive: true });
    const summary = buildSummary(info || {});
    const jsonPath = path.join(dir, 'summary.json');
    const mdPath = path.join(dir, 'summary.md');
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(summary), 'utf8');
    return { dir: dir, json: jsonPath, md: mdPath };
  } catch (_) {
    return null;
  }
}

/** Read the summary.json for a given session name, or null. */
function readSummary(sessionName) {
  try {
    const registry = require('./session-registry');
    const dir = registry.sessionDirFor(sessionName);
    const jsonPath = path.join(dir, 'summary.json');
    if (!fs.existsSync(jsonPath)) return null;
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** List summaries across all sessions (newest first). */
function listSummaries() {
  const out = [];
  try {
    const registry = require('./session-registry');
    const root = registry.sessionsRoot();
    const names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const name of names) {
      const s = readSummary(name);
      if (s) out.push(s);
    }
  } catch (_) { /* ignore */ }
  out.sort((a, b) => new Date(b.finishedAt || 0) - new Date(a.finishedAt || 0));
  return out;
}

module.exports = { writeSummary: writeSummary, buildSummary: buildSummary, renderMarkdown: renderMarkdown, resolveSummaryDir: resolveSummaryDir, readSummary: readSummary, listSummaries: listSummaries };

