// src/failure-capture.js — capture a diagnostic bundle on a hard failure.
//
// ARCHITECTURE.md s.13.2: on an unrecoverable browser/send failure, write a
// timestamped folder containing everything needed to debug selector drift:
//   <ts>-<label>/
//     screenshot.png
//     dom.html
//     url.txt
//     adapter.txt
//
// Pure diagnostics, ZERO risk: every write is best-effort and the whole
// function NEVER throws (a failure to capture must not mask the real error).
'use strict';

const fs    = require('fs');
const path  = require('path');
const paths = require('./paths');

/**
 * Sanitise a label for safe use as a directory name component.
 * Strips path separators and traversal so a label can never escape the root.
 */
function sanitizeLabel(label) {
  const raw = String(label == null ? 'failure' : label);
  const cleaned = raw
    .replace(/[\/\\]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 60);
  return cleaned || 'failure';
}

/**
 * Capture a failure bundle. Never throws.
 *
 * @param {Object} page  - Playwright page (may be null)
 * @param {string} label - short tag, e.g. 'send' or 'empty-streak'
 * @param {Object} [opts] - { root, adapterName }
 * @returns {Promise<string|null>} created directory, or null on failure
 */
async function captureFailure(page, label, opts = {}) {
  try {
    const root  = opts.root || paths.forgePath('logs', 'failures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir   = path.join(root, stamp + '-' + sanitizeLabel(label));
    fs.mkdirSync(dir, { recursive: true });

    try {
      let url = '';
      if (page && typeof page.url === 'function') url = page.url() || '';
      fs.writeFileSync(path.join(dir, 'url.txt'), String(url), 'utf8');
    } catch (_) { /* best effort */ }

    try {
      fs.writeFileSync(path.join(dir, 'adapter.txt'), String(opts.adapterName || 'unknown'), 'utf8');
    } catch (_) { /* best effort */ }

    try {
      if (page && typeof page.screenshot === 'function') {
        await page.screenshot({ path: path.join(dir, 'screenshot.png') });
      }
    } catch (_) { /* best effort */ }

    try {
      if (page && typeof page.content === 'function') {
        const html = await page.content();
        fs.writeFileSync(path.join(dir, 'dom.html'), String(html), 'utf8');
      }
    } catch (_) { /* best effort */ }

    return dir;
  } catch (_) {
    return null;
  }
}

module.exports = { captureFailure, sanitizeLabel };
