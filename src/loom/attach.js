// src/loom/attach.js — the one place the agent asks Loom for context.
//
// Why a separate module
// ---------------------
// Loom's first invariant (spec I1) is that nothing it does may throw into the
// agent. The cheapest way to guarantee that is one boundary that catches
// everything — a missing module, a locked index, a corrupt database — and
// returns a string either way.
//
// The agent calls buildContextDigest(). It returns:
//   - '' when Loom is disabled or anything fails;
//   - a bounded digest when it works.
// Nothing else in the loop knows Loom exists.
//
// Slice 4 replaced the walk-every-run approach with the stored index: refresh()
// sweeps the tree incrementally (mtime/size as a fast negative, hash as the
// decider) and readGraph() rebuilds the dependency graph from the rows. That is
// what makes the digest rank by real access instead of alphabetical ties, and it
// is why the walk lives in refresh.js rather than here.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');

/**
 * Name and stack from the project's own package.json.
 *
 * The indexer reports counts, not identity, so the two facts the digest header
 * needs are read here — cheaply, and with no failure path that matters.
 *
 * @param {string} root
 * @returns {{name: string, stack: string[]|undefined}}
 */
function projectMeta(root) {
  const meta = { name: path.basename(root), stack: undefined };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name) meta.name = pkg.name;

    const bits = [];
    if (pkg.engines && pkg.engines.node) bits.push('Node.js');
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (deps.playwright) bits.push('Playwright');
    if (deps.react) bits.push('React');
    if (deps.express) bits.push('Express');
    if (deps.jest) bits.push('Jest');
    if (pkg.type === 'commonjs') bits.push('CommonJS');
    else if (pkg.type === 'module') bits.push('ESM');
    if (bits.length) meta.stack = bits;
  } catch (_) {
    // No package.json, or unreadable: the digest falls back to detection.
  }

  return meta;
}

/**
 * Build the project-context digest for the first message of a run.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]        project root (defaults to WORKING_DIR)
 * @param {number} [opts.maxTokens]  digest budget (defaults to LOOM_DIGEST_TOKENS)
 * @returns {string} '' when unavailable; never throws
 */
function buildContextDigest(opts = {}) {
  if (config.LOOM_ENABLED !== true) return '';

  const root = path.resolve(opts.cwd || config.WORKING_DIR || process.cwd());
  const maxTokens = opts.maxTokens || config.LOOM_DIGEST_TOKENS || 1200;

  let loom = null;

  try {
    // Required lazily so a partially installed or disabled Loom degrades to
    // "no digest" rather than a crash at startup.
    // eslint-disable-next-line global-require
    loom = require('./index');

    const opened = loom.open({ root });
    if (!opened || opened.skipped) return '';

    // eslint-disable-next-line global-require
    const refresh = require('./refresh');
    // eslint-disable-next-line global-require
    const digest = require('./digest');

    const db = loom.db();
    if (!db) return '';

    // Incremental: unchanged files are skipped on the mtime/size fast negative.
    const refreshed = refresh.refresh({ db, root });
    const graph = refresh.readGraph(db);

    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return '';

    const meta = projectMeta(root);
    const rendered = digest.renderDigest(graph, {
      maxTokens,
      root: meta.name,
      stack: meta.stack,
    });

    return typeof rendered === 'string' ? rendered : '';
  } catch (_) {
    // Missing module, corrupt index, locked database — all the same here: the
    // run continues without Loom.
    return '';
  } finally {
    try { if (loom) loom.close(); } catch (_) { /* closing must never fail a run */ }
  }
}

/**
 * Record that the agent touched a file, so the next digest can rank by use.
 *
 * Best effort by design: an access row is a hint, not a fact the run depends on.
 *
 * @param {string} relPath project-relative path
 * @param {'read'|'edit'|'create'|'delete'} op
 * @param {object} [opts]
 * @returns {boolean} true when the row was written
 */
function recordAccess(relPath, op, opts = {}) {
  if (config.LOOM_ENABLED !== true) return false;

  const root = path.resolve(opts.cwd || config.WORKING_DIR || process.cwd());
  let loom = null;

  try {
    // eslint-disable-next-line global-require
    loom = require('./index');
    const opened = loom.open({ root });
    if (!opened || opened.skipped) return false;

    const db = loom.db();
    if (!db) return false;

    // eslint-disable-next-line global-require
    const refresh = require('./refresh');
    refresh.recordAccess(db, relPath, op, opts);
    return true;
  } catch (_) {
    return false;
  } finally {
    try { if (loom) loom.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { buildContextDigest, recordAccess, projectMeta };
