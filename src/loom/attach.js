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
// Slice 3 note: this walks the project on each run. That is the "no stored
// index" path and is deliberately simple; slice 4 replaces the walk with the
// incremental refresh over the SQLite index, at which point this file should
// only call refresh() + renderDigest().
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');

/** Directories never worth indexing. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'assets', 'docs', 'dist', 'build',
  '.next', '.cache', 'vendor', '.venv', 'venv', '__pycache__',
]);

/** Extensions the extractors understand. */
const EXTRACTABLE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|sql|md|json|ya?ml|toml)$/;

/** Files that are generated or too large to be worth indexing. */
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

const MAX_FILES = 2000;

/**
 * Collect indexable files under `root`, bounded and deterministic.
 * @param {string} root
 * @returns {string[]} project-relative paths, forward slashes, sorted
 */
function collectFiles(root) {
  const out = [];

  const walk = (dir) => {
    if (out.length >= MAX_FILES) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      if (!EXTRACTABLE.test(entry.name)) continue;

      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };

  walk(root);
  return out.sort();
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

module.exports = { buildContextDigest, collectFiles, projectMeta, SKIP_DIRS, MAX_FILES };
