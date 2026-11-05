// src/raw-log.js - persist the last raw (pre-parse) model response.
//
// The docs (README/CHANGELOG/PENDING_WORK) tell users to inspect
// ~/.forge-agent/logs/last-raw-response.txt under --debug, so this module is
// the single place that writes it. Best-effort: never throws into the agent.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write the raw response text to the standard debug log path.
 *
 * @param {string} rawText  the unparsed model response
 * @param {Object} [opts]
 * @param {Object} [opts.paths]  injectable paths module (for tests)
 * @returns {string|null}  the file path written, or null on any failure
 */
function writeRawResponse(rawText, opts = {}) {
  try {
    if (typeof rawText !== 'string') return null;
    const paths = opts.paths || require('./paths');
    const file = paths.forgePath('logs', 'last-raw-response.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rawText, 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

module.exports = { writeRawResponse };
