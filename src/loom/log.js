'use strict';
// src/loom/log.js — the only logger Loom is allowed to touch.
//
// `src/logger.js` exposes info/success/warn/error/dim but no `debug`, and Loom's
// own diagnostics are debug-level: a failed JSON flush or a quarantined index is
// not something to print at a user in the middle of a task. This wrapper keeps
// Loom's logging (a) quiet by default, (b) never able to throw — a logger that
// is not initialised must not take the index down with it (invariant I1).

const logger = require('../logger');

function debug(message) {
  if (!process.env.DEBUG && !process.env.LOOM_DEBUG) return;
  try {
    logger.dim(`[Loom] ${message}`);
  } catch (_) {
    // Logging is best-effort.
  }
}

function warn(message) {
  try {
    logger.warn(`[Loom] ${message}`);
  } catch (_) {
    // Logging is best-effort.
  }
}

function info(message) {
  try {
    logger.info(`[Loom] ${message}`);
  } catch (_) {
    // Logging is best-effort.
  }
}

module.exports = { debug, warn, info };
