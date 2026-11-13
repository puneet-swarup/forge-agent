// @ts-check
// src/heartbeat.js — Periodic self-heartbeat for a running agent.
//
// Implements docs/SPAWN_PROTOCOL.md §5.1. Any agent (parent or child) can start
// a heartbeat loop that refreshes its registry record on a fixed interval, so a
// supervisor can tell whether it is running / unresponsive / dead.
//
// The loop is unref'd so it never keeps the process alive on its own.
'use strict';

const registry = require('./session-registry');

let _timer = null;
let _lastStatus = null;
let _extra = {};

/**
 * Start (or restart) the heartbeat loop for THIS process.
 *
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs]  override interval (default from registry)
 * @param {string} [opts.status]      initial status (default 'running')
 * @param {Object} [opts.extra]       extra fields merged into the record
 * @returns {{ stop: Function, beat: Function, setStatus: Function }}
 */
function start(opts = {}) {
  stop();
  const intervalMs = opts.intervalMs || registry.heartbeatIntervalMs();
  _lastStatus = opts.status || 'running';
  _extra = opts.extra || {};

  const beat = () => {
    try {
      registry.writeHeartbeat({ ..._extra, status: _lastStatus });
    } catch (_) { /* best-effort; never fatal */ }
  };

  // Immediate beat, then periodic.
  beat();
  _timer = setInterval(beat, intervalMs);
  if (_timer && typeof _timer.unref === 'function') _timer.unref();

  return { stop, beat, setStatus };
}

/** Update the status written on subsequent beats. */
function setStatus(status) {
  if (status) _lastStatus = status;
}

/** Stop the heartbeat loop. */
function stop() {
  if (_timer) {
    try { clearInterval(_timer); } catch (_) {}
    _timer = null;
  }
}

function isRunning() {
  return _timer != null;
}

module.exports = { start, stop, setStatus, isRunning };
