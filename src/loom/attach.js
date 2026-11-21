// src/loom/attach.js — the one place the agent asks Loom for context.
//
// Why a separate module
// ---------------------
// Loom's first invariant (spec I1) is that nothing it does may throw into the
// agent. The cheapest way to guarantee that is one boundary that catches
// everything — a missing module, a locked index, a malformed file — and returns
// a string either way.
//
// The agent calls buildContextDigest(). It returns:
//   - '' when Loom is disabled or anything fails;
//   - a bounded digest when it works.
// Nothing else in the loop knows Loom exists.
//
// Slice 4 note: the digest now comes from the stored index — `refresh()` sweeps
// the tree incrementally, and the digest ranks hot files by recorded access
// instead of alphabetically. The direct walk below is kept as the fallback for
// the one case the store cannot serve: a project where Loom could not open an
// index at all (read-only home, no writable directory). It is a fallback, not
// the main path.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');
// eslint-disable-next-line global-require
const refreshMod = require('./refresh');

/** Directories never worth indexing. One list, shared with the indexer. */
const SKIP_DIRS = refreshMod.SKIP_DIRS;

/** Extensions the extractors understand. */
const EXTRACTABLE = refreshMod.EXTRACTABLE;

/** Files that are generated or too large to be worth indexing. */
const SKIP_FILES = refreshMod.SKIP_FILES;

const MAX_FILES = refreshMod.DEFAULT_MAX_FILES;

/**
 * Collect indexable files under `root`, bounded and deterministic.
 * @param {string} root
 * @returns {string[]} project-relative paths, forward slashes, sorted
 */
function collectFiles(root) {
  return refreshMod.collectCandidates(root, { maxFiles: MAX_FILES });
}

/**
 * Read the project's own metadata so the digest can name the stack and the real
 * entry points instead of guessing from filenames.
 * @param {string} root
 */
function projectMeta(root) {
  const meta = { name: null, stack: null, entries: [] };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    meta.name = pkg.name || null;

    const bits = [];
    if (pkg.engines && pkg.engines.node) bits.push('Node.js');
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (deps.playwright) bits.push('Playwright');
    if (deps.react) bits.push('React');
    if (deps.express) bits.push('Express');
    if (deps.jest) bits.push('Jest');
    if (pkg.type === 'commonjs') bits.push('CommonJS');
    else if (pkg.type === 'module') bits.push('ESM');
    meta.stack = bits.length ? bits.join(', ') : null;

    if (typeof pkg.main === 'string') meta.entries.push(pkg.main.replace(/^\.\//, ''));
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const value of Object.values(pkg.bin)) {
        if (typeof value === 'string') meta.entries.push(value.replace(/^\.\//, ''));
      }
    }
  } catch (_) {
    // No package.json, or unreadable — the digest falls back to detection.
  }

  meta.entries = [...new Set(meta.entries)];
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

  const root = opts.cwd || config.WORKING_DIR;
  const maxTokens = opts.maxTokens || config.LOOM_DIGEST_TOKENS || 1200;

  // The stored index is the main path: it is what makes hot-file order real.
  try {
    const stored = digestFromStore(root, maxTokens, opts);
    if (stored) return stored;
  } catch (_) {
    // A store that cannot be opened is not a failed run — fall through.
  }

  return digestFromWalk(root, maxTokens, opts);
}

/**
 * The digest from the stored index: refresh, then render.
 *
 * @returns {string} '' when the store cannot serve a digest
 */
function digestFromStore(root, maxTokens, opts) {
  // eslint-disable-next-line global-require
  const loom = require('./index');
  // eslint-disable-next-line global-require
  const { renderDigest } = require('./digest');

  // I2: a disabled Loom does no I/O at all, including no directory walk.
  if (!loom.config().enabled) return '';

  const resolved = path.resolve(root);
  const current = loom.status();
  if (!loom.isEnabled() || current.root !== resolved) {
    loom.open({ root: resolved, env: opts.env, forceJson: opts.forceJson === true, silent: true });
  }
  const db = loom.db();
  if (!db) return '';

  const meta = projectMeta(resolved);
  const swept = refreshMod.refresh({
    db,
    root: resolved,
    env: opts.env,
    entries: meta.entries,
    now: opts.now,
  });
  if (!swept || swept.skipped === true || swept.error || !swept.files) return '';

  const graph = refreshMod.readGraph(db, { root: resolved, entries: meta.entries });
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return '';

  const digest = renderDigest(graph, {
    maxTokens,
    root: meta.name || path.basename(resolved),
    stack: meta.stack ? meta.stack.split(', ') : undefined,
    // §7 heat: the reason the index exists. Alphabetical ties are over.
    access: refreshMod.accessRows(db),
    notes: db.all('notes'),
    counters: loom.counters(),
  });
  return typeof digest === 'string' ? digest : '';
}

/**
 * The fallback digest: walk the tree and render without a store.
 * @returns {string} '' on any failure
 */
function digestFromWalk(root, maxTokens, opts) {
  try {
    // Required lazily so a partially built Loom degrades to "no digest".
    // eslint-disable-next-line global-require
    const { extract } = require('./extract');
    // eslint-disable-next-line global-require
    const { buildGraph } = require('./graph');
    // eslint-disable-next-line global-require
    const { renderDigest } = require('./digest');

    const rels = collectFiles(root);
    if (rels.length === 0) return '';

    const files = [];
    for (const rel of rels) {
      let text;
      try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { continue; }
      const parsed = extract(text, rel);
      files.push({ path: rel, ...parsed });
    }
    if (files.length === 0) return '';

    const meta = projectMeta(root);
    const graph = buildGraph(files, { root, entries: meta.entries });
    const digest = renderDigest(graph, {
      maxTokens,
      root: meta.name || path.basename(root),
      // renderDigest takes an array of labels, not a pre-joined string.
      stack: meta.stack ? meta.stack.split(', ') : undefined,
    });

    return typeof digest === 'string' ? digest : '';
  } catch (_) {
    // Missing module, corrupt file, permission error — all the same here: the
    // run continues without Loom.
    return '';
  }
}

module.exports = {
  buildContextDigest,
  digestFromStore,
  digestFromWalk,
  collectFiles,
  projectMeta,
  SKIP_DIRS,
  SKIP_FILES,
  EXTRACTABLE,
  MAX_FILES,
};
