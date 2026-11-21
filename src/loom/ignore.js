'use strict';
// src/loom/ignore.js — what Loom refuses to index.
//
// Spec: src/loom_specs.md §4.1. Three layers, evaluated in order:
//   1. hard deny  — build output, dependencies, binaries (no value in an index);
//   2. secret deny — credentials, keys, `.env` (never indexed, never summarised,
//      regardless of any setting);
//   3. the project's own `.gitignore`, with a minimal matcher so no dependency
//      is added for it.
//
// A path is indexable only if it survives all three.

// Directory names that are never descended into.
const HARD_DENY_DIRS = Object.freeze([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.forge',
]);

// File globs (matched against the basename) that are never indexed.
const HARD_DENY_FILES = Object.freeze([
  '*.min.js', '*.map', '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.pdf', '*.zip', '*.gz', '*.tar',
  '*.woff', '*.woff2', '*.ttf', '*.eot', '*.mp4', '*.mp3', '*.wav', '*.so', '*.dll',
  '*.dylib', '*.exe', '*.bin', '*.pyc',
]);

// Credentials. These are never indexed, never summarised, and never exported —
// not even as a "skipped" row with a purpose line.
const SECRET_PATTERNS = Object.freeze([
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*',
  '*credentials*', '*secret*', '*.keystore',
]);

const _globCache = new Map();

/**
 * Compile a gitignore-style glob to a RegExp.
 *
 * Supports `*` (within a segment), `**` (across segments), `?`, a leading `/`
 * (anchor to the project root), a trailing `/` (directories only) and `!`
 * negation (handled by the rule parser, not here).
 *
 * A pattern containing no `/` matches a basename at any depth, which is what
 * gitignore does.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  const cached = _globCache.get(glob);
  if (cached) return cached;

  let pattern = glob;
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  const anchored = pattern.startsWith('/') || pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — any number of segments.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }

  const prefix = anchored ? '^' : '(?:^|/)';
  const suffix = dirOnly ? '(?:/.*)?$' : '$';
  const compiled = new RegExp(prefix + re + suffix);
  _globCache.set(glob, compiled);
  return compiled;
}

/** Does a single glob match a relative path? */
function matchGlob(glob, relPath) {
  try {
    return globToRegExp(glob).test(relPath);
  } catch (_) {
    return false;
  }
}

/**
 * Parse `.gitignore` text into ordered rules.
 * Comments and blank lines are dropped; a trailing space is stripped.
 *
 * @param {string} text
 * @returns {Array<{ pattern: string, negate: boolean, regex: RegExp }>}
 */
function parseGitignore(text) {
  const rules = [];
  if (typeof text !== 'string') return rules;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;

    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!')) {
      line = line.slice(1);
    }
    if (!line) continue;

    let regex;
    try {
      regex = globToRegExp(line);
    } catch (_) {
      continue;
    }
    rules.push({ pattern: line, negate, regex });
  }

  return rules;
}

function segments(relPath) {
  return relPath.split('/').filter(Boolean);
}

/** Is this path (or one of its parents) a hard-denied directory? */
function isHardDeniedDir(relPath) {
  const parts = segments(relPath);
  // The last segment is the file itself; a file is not a directory.
  for (let i = 0; i < parts.length - 1; i++) {
    if (HARD_DENY_DIRS.includes(parts[i])) return true;
  }
  return false;
}

/** Is the basename a hard-denied file type? */
function isHardDeniedFile(relPath) {
  const parts = segments(relPath);
  const base = parts[parts.length - 1] || '';
  return HARD_DENY_FILES.some((glob) => matchGlob(glob, base));
}

/**
 * Is this path a credential? Checked against the basename and against every
 * path segment, so `config/secrets/api.js` is refused as well as `api-secret.js`.
 */
function isSecret(relPath) {
  const parts = segments(relPath);
  const base = parts[parts.length - 1] || '';
  if (SECRET_PATTERNS.some((glob) => matchGlob(glob, base))) return true;
  return parts.some((part) => SECRET_PATTERNS.some((glob) => matchGlob(glob, part)));
}

/**
 * Apply `.gitignore` rules. Last matching rule wins, so `!keep.log` after
 * `*.log` re-includes that file (gitignore semantics).
 */
function matchesGitignore(relPath, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return false;
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relPath)) ignored = !rule.negate;
  }
  return ignored;
}

/**
 * The single question the indexer asks.
 *
 * @param {string} relPath project-relative, forward slashes
 * @param {Array<{negate: boolean, regex: RegExp}>} [rules] parsed `.gitignore`
 * @returns {{ ignored: boolean, reason: 'hard-deny'|'secret'|'gitignore'|null }}
 */
function shouldIgnore(relPath, rules = []) {
  if (typeof relPath !== 'string' || !relPath) return { ignored: true, reason: 'hard-deny' };
  if (isSecret(relPath)) return { ignored: true, reason: 'secret' };
  if (isHardDeniedDir(relPath) || isHardDeniedFile(relPath)) return { ignored: true, reason: 'hard-deny' };
  if (matchesGitignore(relPath, rules)) return { ignored: true, reason: 'gitignore' };
  return { ignored: false, reason: null };
}

/** Filter a list of relative paths down to the indexable ones. */
function filterPaths(paths, rules = []) {
  return paths.filter((p) => !shouldIgnore(p, rules).ignored);
}

module.exports = {
  HARD_DENY_DIRS,
  HARD_DENY_FILES,
  SECRET_PATTERNS,
  globToRegExp,
  matchGlob,
  parseGitignore,
  matchesGitignore,
  isHardDeniedDir,
  isHardDeniedFile,
  isSecret,
  shouldIgnore,
  filterPaths,
};
