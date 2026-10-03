// src/event-log.js — Structured per-instance event log (feeds the control UI)
//
// Each agent process appends newline-delimited JSON events to
//   <SESSION_DIR>/events.jsonl
// The control server tails these files and streams them to the dashboard.
//
// Design goals:
//   - Never throw into the agent (logging must not break a task).
//   - Cheap: appendFileSync of a small JSON line.
//   - Disable-able via FORGE_NO_EVENTS=1 for headless/CI runs.
//
'use strict';

const fs = require('fs');
const path = require('path');

const EVENTS_FILE = 'events.jsonl';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // rotate at ~5MB to bound growth

function eventsDisabled() {
  const v = process.env.FORGE_NO_EVENTS;
  return v === '1' || v === 'true' || v === 'yes';
}

function eventsFile(sessionDir) {
  const dir = sessionDir || process.env.FORGE_SESSION_DIR;
  if (!dir) return null;
  return path.join(dir, EVENTS_FILE);
}

function _rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) {
      const prev = file + '.1';
      try { fs.rmSync(prev, { force: true }); } catch (_) {}
      fs.renameSync(file, prev);
    }
  } catch (_) { /* file may not exist yet */ }
}

/**
 * Append one event. Never throws.
 * @param {string} type  event type (task, step, tool_call, tool_result, error, output, final, ...)
 * @param {Object} data  arbitrary JSON-serialisable payload
 * @param {Object} opts  { sessionDir }
 */
function emit(type, data = {}, opts = {}) {
  if (eventsDisabled()) return;
  const file = eventsFile(opts.sessionDir);
  if (!file) return;

  const record = {
    ts: Date.now(),
    session: process.env.FORGE_SESSION_NAME || opts.session || 'agent',
    role: process.env.FORGE_ROLE || null,
    type: String(type || 'event'),
    data: data || {},
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {
    // Logging failures must never affect the agent.
  }
}

/**
 * Read the last N events for a session directory (for initial dashboard load).
 * @returns {Array<Object>} oldest-first
 */
function readEvents(sessionDir, limit = 500) {
  const file = eventsFile(sessionDir);
  if (!file) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

module.exports = { emit, readEvents, eventsFile, eventsDisabled, EVENTS_FILE };
