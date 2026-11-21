'use strict';
// src/loom/resolve.js — import specifier → project-relative path.
//
// Spec: src/loom_specs.md §4.6. The dependency graph is only as good as this
// step: an unresolved local import silently drops an edge, and a *wrongly*
// resolved one invents an edge that does not exist. So the rules are narrow and
// the failure mode is `resolved: null`, never a guess.
//
//   * `./x`, `../x`, `/x`, `@/x`, `~/x` are local; everything else is external.
//   * `@/` and `~/` and a leading `/` all mean "from the project root".
//   * candidates are tried in the spec's order — the bare path, then the six
//     source extensions, then `index.<ext>` — and the first that exists wins.
//   * `tsconfig.json` `paths` are deliberately not read in v1.
//
// Existence is injectable (`opts.exists`) so the graph can be rebuilt against a
// file list without touching the disk, and so tests do not need fixtures on
// disk to prove the order.

const fs = require('fs');
const path = require('path');

const paths = require('./paths');

/** Extensions tried in order, before and after `index`. */
const EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

const ROOT_PREFIXES = Object.freeze(['@/', '~/']);

/** Is this specifier one the index can follow? */
function isLocalSpecifier(specifier) {
  if (typeof specifier !== 'string') return false;
  const spec = specifier.trim();
  if (!spec) return false;
  if (spec === '.' || spec === '..') return true;
  if (spec.startsWith('./') || spec.startsWith('../')) return true;
  if (spec.startsWith('/')) return true;
  return ROOT_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

/** Strip a root marker (`@/`, `~/`, `/`) so the rest is project-relative. */
function stripRootMarker(spec) {
  for (const prefix of ROOT_PREFIXES) {
    if (spec.startsWith(prefix)) return spec.slice(prefix.length);
  }
  if (spec.startsWith('/')) return spec.replace(/^\/+/, '');
  return spec;
}

/**
 * The paths tried for one specifier, in order, normalised and de-duplicated.
 * Empty when the specifier would escape the project.
 */
function candidatePaths(specifier, fromRel) {
  if (!isLocalSpecifier(specifier)) return [];
  const spec = specifier.trim();

  let base;
  if (spec.startsWith('.') || spec.startsWith('..')) {
    base = path.posix.join(paths.relDir(String(fromRel || '')), spec);
  } else {
    base = stripRootMarker(spec);
  }

  const normalized = paths.normalizeRel(base);
  if (!normalized) return [];

  const candidates = [normalized];
  for (const ext of EXTENSIONS) candidates.push(`${normalized}${ext}`);
  for (const ext of EXTENSIONS) candidates.push(`${normalized}/index${ext}`);
  return candidates;
}

/** Default existence check: a regular file under `root`. */
function fsExists(root) {
  const base = path.resolve(root || process.cwd());
  return (relPath) => {
    try {
      return fs.statSync(path.join(base, relPath)).isFile();
    } catch (_) {
      return false;
    }
  };
}

/**
 * Resolve one import.
 *
 * @param {string} specifier
 * @param {string} fromRel project-relative path of the importing file
 * @param {{ root?: string, exists?: (rel: string) => boolean }} [opts]
 * @returns {{ specifier: string, resolved: string|null,
 *             kind: 'local'|'external', candidates: string[] }}
 */
function resolveSpecifier(specifier, fromRel, opts = {}) {
  const spec = typeof specifier === 'string' ? specifier.trim() : '';
  const result = { specifier: spec, resolved: null, kind: 'external', candidates: [] };

  const candidates = candidatePaths(spec, fromRel);
  if (!candidates.length) return result;

  result.kind = 'local';
  result.candidates = candidates;

  const exists = typeof opts.exists === 'function' ? opts.exists : fsExists(opts.root);
  for (const candidate of candidates) {
    let found = false;
    try {
      found = exists(candidate) === true;
    } catch (_) {
      found = false; // an existence check that throws means "not there".
    }
    if (found) {
      result.resolved = candidate;
      break;
    }
  }

  return result;
}

/**
 * Resolve a list of `{specifier, kind}` imports into the row shape the
 * `imports` table stores: `{specifier, resolved, kind}`.
 *
 * @param {Array<{specifier: string, kind: string}>} imports
 * @param {string} fromRel
 * @param {{ root?: string, exists?: (rel: string) => boolean }} [opts]
 */
function resolveImports(imports, fromRel, opts = {}) {
  if (!Array.isArray(imports)) return [];
  return imports.map((entry) => {
    const resolved = resolveSpecifier(entry && entry.specifier, fromRel, opts);
    return {
      specifier: resolved.specifier,
      resolved: resolved.resolved,
      kind: (entry && entry.kind) || 'import',
    };
  });
}

module.exports = {
  EXTENSIONS,
  ROOT_PREFIXES,
  isLocalSpecifier,
  stripRootMarker,
  candidatePaths,
  fsExists,
  resolveSpecifier,
  resolveImports,
};
