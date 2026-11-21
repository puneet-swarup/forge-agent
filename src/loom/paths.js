'use strict';
// src/loom/paths.js — project-relative path normalisation and index location.
//
// Spec: src/loom_specs.md §3.1 and invariant I6. Everything Loom stores is a
// project-relative path with forward slashes, on every platform, so an
// index.db copied between machines still resolves. That is why this module is
// the only place that knows about `path.sep`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sha256Text } = require('./hash');

// The JSON store is the path most users run (no `node:sqlite` on Node 20), so
// it belongs here too: a `.forge/loom` directory that leaves `index.json`
// untracked would show up as a dirty tree in every project that uses Loom.
const GITIGNORE_CONTENT = 'index.db\nindex.db-wal\nindex.db-shm\nindex.json\nindex.json.tmp\n*.bad\n';

/**
 * Normalise a path to the form Loom stores: project-relative, forward slashes,
 * no leading `./`, no `..` segments.
 *
 * Returns `null` for anything that would escape the project or cannot be
 * expressed as a relative path — the caller treats that as "not indexable".
 *
 * @param {string} input
 * @returns {string|null}
 */
function normalizeRel(input) {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (!p) return null;

  p = p.replace(/\\/g, '/');
  // Windows drive letters and UNC paths are absolute.
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('//')) return null;
  if (p.startsWith('/')) return null;

  p = path.posix.normalize(p);
  if (p === '.' || p === './' || p === '') return null;
  if (p.startsWith('../') || p === '..') return null;
  if (p.endsWith('/')) p = p.replace(/\/+$/, '');
  if (!p || p === '.') return null;

  return p;
}

/** Convert an absolute path to a project-relative one, or null if outside. */
function toRel(root, absPath) {
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return normalizeRel(rel);
}

/** Directory part of a relative path, '' at the root. */
function relDir(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** Stable project id: sha256(absolute root), first 16 hex chars. */
function projectId(root) {
  return sha256Text(path.resolve(root)).slice(0, 16);
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the index directory.
 *
 * Order: explicit `LOOM_DIR` → `<root>/.forge/loom` → global fallback
 * `~/.forge-agent/loom/<project-id>` when the project is not writable.
 *
 * @param {{ root: string, dir?: string|null, home?: string }} opts
 * @returns {{ dir: string, fallback: boolean, projectId: string }}
 */
function loomDir(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const id = projectId(root);

  if (opts.dir) {
    return { dir: path.resolve(root, opts.dir), fallback: false, projectId: id };
  }

  const projectDir = path.join(root, '.forge', 'loom');
  if (isWritable(root)) return { dir: projectDir, fallback: false, projectId: id };

  const home = opts.home || os.homedir();
  return { dir: path.join(home, '.forge-agent', 'loom', id), fallback: true, projectId: id };
}

/** `<dir>/index.db`. The JSON fallback lives beside it as `index.json`. */
function dbFile(dir) {
  return path.join(dir, 'index.db');
}

/** Path of the JSON fallback store for a given `.db` path. */
function jsonFileFor(file) {
  return file.replace(/\.db$/, '.json');
}

/**
 * Create `<dir>/.gitignore` if absent, with the generated artifacts listed.
 * An existing file is never modified (a user may have added their own lines),
 * and the project root `.gitignore` is never touched.
 *
 * @returns {{ created: boolean, path: string }}
 */
function ensureGitignore(dir) {
  const file = path.join(dir, '.gitignore');
  if (fs.existsSync(file)) return { created: false, path: file };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, GITIGNORE_CONTENT, 'utf8');
  return { created: true, path: file };
}

module.exports = {
  GITIGNORE_CONTENT,
  normalizeRel,
  toRel,
  relDir,
  projectId,
  isWritable,
  loomDir,
  dbFile,
  jsonFileFor,
  ensureGitignore,
};
