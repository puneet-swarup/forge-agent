'use strict';
// src/loom/hash.js — content hashing and the stat fast path.
//
// Spec: src/loom_specs.md §5.1–§5.2. mtime is a *fast negative only*: equal
// mtime and size means "assume unchanged", a mismatch means "candidate, go
// hash it". Never the other way round — git checkout, rsync and Docker copies
// rewrite mtime without changing bytes, and preserved mtime can hide a change.

const crypto = require('crypto');
const fs = require('fs');

/** sha256 of a UTF-8 string, lowercase hex. */
function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** sha256 of a buffer, lowercase hex. */
function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * sha256 of a file's bytes.
 * Throws on a read error — callers decide whether that tombstones the row.
 */
function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

/** sha256 of a file, or `null` when it cannot be read. */
function safeSha256File(file) {
  try {
    return sha256File(file);
  } catch (_) {
    return null;
  }
}

/**
 * Stat a file for indexing.
 * @returns {{ bytes: number, mtimeMs: number } | null} null when absent or not a file
 */
function statFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { bytes: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
  } catch (_) {
    return null;
  }
}

/**
 * The fast negative from §5.2.
 * @param {{ bytes: number, mtimeMs: number }} stat
 * @param {{ bytes: number, mtime_ms: number }} row
 */
function statMatches(stat, row) {
  if (!stat || !row) return false;
  return stat.bytes === row.bytes && Math.trunc(stat.mtimeMs) === Math.trunc(row.mtime_ms);
}

module.exports = { sha256Text, sha256Buffer, sha256File, safeSha256File, statFile, statMatches };
