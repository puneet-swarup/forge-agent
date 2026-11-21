// src/loom/attach.js — the one place the agent asks Loom for context.
//
// Why a separate module
// ---------------------
// Loom's first invariant (spec I1) is that nothing it does may throw into the
// agent. The cheapest way to guarantee that is to keep every Loom call behind
// one boundary that catches everything, including a missing module — which is
// exactly the state of this repository while the digest is still being built.
//
// The agent calls buildContextDigest(). It returns a string, always:
//   - '' when Loom is disabled, not built yet, or fails for any reason;
//   - a bounded digest when it works.
// Nothing else in the loop knows Loom exists.
'use strict';

const config = require('../config');

/**
 * Build the project-context digest for the first message of a run.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]        project root (defaults to WORKING_DIR)
 * @param {number} [opts.maxTokens]  digest budget (defaults to LOOM_DIGEST_TOKENS)
 * @returns {string} '' when unavailable; never throws
 */
function buildContextDigest(opts = {}) {
  if (config.LOOM_ENABLED === false) return '';

  const cwd = opts.cwd || config.WORKING_DIR;
  const maxTokens = opts.maxTokens || config.LOOM_DIGEST_TOKENS || 1200;

  try {
    // Required lazily: while Loom is still being built these modules may not
    // exist, and a missing file must degrade to "no digest", not a crash.
    // eslint-disable-next-line global-require
    const { open, close } = require('./index');
    // eslint-disable-next-line global-require
    const { renderDigest } = require('./digest');

    const handle = open({ cwd });
    try {
      const graph = typeof handle.graph === 'function'
        ? handle.graph()
        : (handle.graph || null);

      if (!graph) return '';

      const digest = renderDigest(graph, { maxTokens });
      return typeof digest === 'string' ? digest : '';
    } finally {
      try { close(handle); } catch (_) { /* closing must never fail a run */ }
    }
  } catch (_) {
    // A missing module, a corrupt index, a locked database — all the same here:
    // the run continues without Loom.
    return '';
  }
}

module.exports = { buildContextDigest };
