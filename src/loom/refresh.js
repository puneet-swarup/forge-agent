'use strict';
// src/loom/refresh.js — the incremental indexer.
//
// Spec: src/loom_specs.md §5 (freshness), §5.5 (dirty flag), §5.6 (role drift),
// §4.2 (extract contract) and invariants I1, I2, I6.
//
// Slice 3 rendered the digest by walking the project on every run, which meant
// the hot-file order was alphabetical among ties: nothing recorded what the
// agent actually read or edited. This module is the stored index that fixes
// that — a sweep over the working tree that writes `files`, `symbols`,
// `imports` and `summaries`, tombstones what disappeared, and keeps an `access`
// trail the digest ranks by.
//
// Four rules carry the design:
//
//   * **mtime is a fast negative only** (§5.1). Equal mtime and size means
//     "assume unchanged"; a mismatch is a candidate, never proof. The hash
//     decides. `git checkout`, rsync and Docker copies all rewrite mtime without
//     changing bytes.
//   * **the index is derived, never authoritative.** Anything unexpected
//     rebuilds it. A rebuild re-indexes every candidate and reuses the existing
//     row (matched on `rel_path`), so file ids — and the access rows pointing at
//     them — survive.
//   * **the graph is rebuilt, not stored.** `imports.resolved` is written here so
//     §5.6 role drift can be computed from the table without re-reading a file,
//     but edges are always derived by graph.js.
//   * **nothing throws into a caller.** Every exported function is wrapped; a
//     failed refresh costs one run's freshness, never a tool call (I1).
//
// Deliberate deviation: §5.3's git short-circuit (three `git` calls to narrow
// the candidate set) is not implemented. The sweep stats every candidate
// instead, which is the same answer without a subprocess, a 3 s timeout or a
// dependency on git being installed. The cost is a stat per file; the fast
// negative above is what keeps that cheap.

const fs = require('fs');
const path = require('path');

const log = require('./log');
const configMod = require('./config');
const paths = require('./paths');
const hash = require('./hash');
const ignore = require('./ignore');
const extract = require('./extract');
const resolveMod = require('./resolve');
const graphMod = require('./graph');
const migrate = require('./migrate');

/** Directories never worth indexing. Shared with attach.js. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'assets', 'docs', 'dist', 'build',
  '.next', '.cache', 'vendor', '.venv', 'venv', '__pycache__', '.forge',
]);

/** Extensions the extractors understand. */
const EXTRACTABLE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|sql|md|json|ya?ml|toml)$/;

/** Files that are generated or too large to be worth indexing. */
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

const DEFAULT_MAX_FILES = 2000;

/** §7 ops, the only access kinds the heat formula weights. */
const ACCESS_OPS = Object.freeze(['edit', 'write', 'read', 'search_hit']);

const META_BUILT_AT = 'built_at';
const META_DIRTY = 'dirty';
const META_REHASH = 'full_rehash_at';

// ── candidate collection ────────────────────────────────────────────────────

/**
 * Walk the project and return the indexable files, bounded and deterministic.
 *
 * @param {string} root absolute project root
 * @param {{ maxFiles?: number, rules?: Array<object>, extensions?: RegExp }} [opts]
 *   `rules` are parsed `.gitignore` rules; `extensions` overrides the built-in
 *   extractable set (tests use it to index a fixture the extractors skip).
 * @returns {string[]} project-relative paths, forward slashes, sorted
 */
function collectCandidates(root, opts = {}) {
  const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0
    ? Math.floor(opts.maxFiles)
    : DEFAULT_MAX_FILES;
  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  const extensions = opts.extensions instanceof RegExp ? opts.extensions : EXTRACTABLE;

  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      if (!extensions.test(entry.name)) continue;

      const rel = path.relative(root, full).split(path.sep).join('/');
      const verdict = ignore.shouldIgnore(rel, rules);
      if (verdict.ignored) continue;
      out.push(rel);
    }
  };

  walk(root);
  return out.sort();
}

/** Read the project's `.gitignore` rules, or [] when there is none. */
function readGitignore(root) {
  try {
    return ignore.parseGitignore(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  } catch (_) {
    return [];
  }
}

// ── rows ────────────────────────────────────────────────────────────────────

/** The file row for a path, or null. `rel_path` is UNIQUE in both backends. */
function fileRow(db, relPath) {
  try {
    return db.where('files', { rel_path: relPath })[0] || null;
  } catch (_) {
    return null;
  }
}

/**
 * Write one file's structure: the `files` row, then its `symbols` and
 * `imports`, replaced wholesale (structure is regenerated, never patched), plus
 * the §6.1 heuristic summary.
 *
 * @param {object} db store handle
 * @param {string} root project root
 * @param {string} relPath project-relative, forward slashes
 * @param {{ stat: object, sha: string, now: number, maxFileBytes?: number }} info
 * @returns {{ id: number|null, state: string, symbols: number, imports: number }|null}
 */
function indexFile(db, root, relPath, info) {
  const stat = info.stat;
  const now = info.now;
  const maxBytes = Number.isFinite(info.maxFileBytes) ? info.maxFileBytes : Infinity;

  let text = '';
  let parseState = 'ok';
  let parsed = { lang: null, symbols: [], imports: [], summary: '', loc: 0, partial: false };

  if (stat.bytes > maxBytes) {
    // Too large to parse, but the row still exists: the digest must not
    // present a file it has never read as if it had.
    parseState = 'skipped';
  } else {
    try {
      text = fs.readFileSync(path.join(root, relPath), 'utf8');
    } catch (err) {
      log.debug(`read failed for ${relPath}: ${err.message}`);
      parseState = 'error';
    }
    if (parseState === 'ok') {
      parsed = extract.extract(text, relPath);
      if (parsed.partial) parseState = 'partial';
    }
  }

  const row = {
    rel_path: relPath,
    lang: parsed.lang || 'text',
    bytes: stat.bytes,
    mtime_ms: stat.mtimeMs,
    content_sha: info.sha,
    loc: parsed.loc || 0,
    indexed_at: now,
    parse_state: parseState,
    deleted: 0,
  };

  const existing = fileRow(db, relPath);
  let id;
  if (existing) {
    db.update('files', existing.id, row);
    id = existing.id;
  } else {
    id = db.insert('files', row);
  }
  if (!Number.isFinite(id)) return null;

  // Structure is regenerated on every content change, so replace it rather
  // than diff it: a stale symbol range is exactly the failure I3 forbids.
  db.removeWhere('symbols', { file_id: id });
  db.removeWhere('imports', { file_id: id });

  const symbols = (parsed.symbols || []).map((symbol) => ({
    file_id: id,
    name: symbol.name,
    kind: symbol.kind,
    line_start: symbol.line_start,
    line_end: symbol.line_end,
    signature: symbol.signature || '',
    exported: symbol.exported ? 1 : 0,
    parent: symbol.parent || '',
    doc: symbol.doc || '',
    confidence: Number.isFinite(symbol.confidence) ? symbol.confidence : 0.6,
  }));
  db.insertMany('symbols', symbols);

  const imports = resolveMod.resolveImports(parsed.imports || [], relPath, { root });
  db.insertMany('imports', imports.map((entry) => ({
    file_id: id,
    specifier: entry.specifier,
    resolved: entry.resolved,
    kind: entry.kind,
  })));

  if (parsed.summary) {
    db.insert('summaries', {
      file_id: id,
      purpose: String(parsed.summary).slice(0, 240),
      source: 'heuristic',
      sha: info.sha,
      base_conf: 0.7,
      made_at: now,
      role_stale: 0,
    });
  } else {
    db.removeWhere('summaries', { file_id: id });
  }

  return { id, state: parseState, symbols: symbols.length, imports: imports.length };
}

/**
 * Mark a file as gone. The row is kept (`deleted = 1`) so the id stays stable
 * and access rows keep pointing at something; its structure is dropped, because
 * structure from a file that no longer exists is a lie the digest could repeat.
 */
function tombstone(db, relPath, now) {
  const row = fileRow(db, relPath);
  if (!row) return false;
  db.update('files', row.id, { deleted: 1, indexed_at: now, loc: 0 });
  db.removeWhere('symbols', { file_id: row.id });
  db.removeWhere('imports', { file_id: row.id });
  db.removeWhere('summaries', { file_id: row.id });
  return true;
}

// ── the sweep ───────────────────────────────────────────────────────────────

/** Meta helpers that cannot throw. */
function metaGet(db, key) {
  return migrate.getMeta(db, key);
}

function metaSet(db, key, value) {
  return migrate.setMeta(db, key, value);
}

/**
 * §5.5: `run_command`, `git_diff`, `git_status` and `git_log` can mutate
 * arbitrary files, and no post-hook can enumerate them. The tool dispatcher
 * marks the index dirty after each of them; the next refresh then rehashes
 * every candidate instead of trusting mtime.
 */
function markDirty(db) {
  try {
    if (!db) return false;
    return metaSet(db, META_DIRTY, '1');
  } catch (_) {
    return false;
  }
}

/** Is the index known to be out of date? */
function isDirty(db) {
  try {
    return Boolean(db) && metaGet(db, META_DIRTY) === '1';
  } catch (_) {
    return false;
  }
}

function clearDirty(db) {
  try {
    if (!db) return false;
    return metaSet(db, META_DIRTY, '0');
  } catch (_) {
    return false;
  }
}

/**
 * Recompute `files.importers_sig` from the imports table and flag role drift
 * (§5.6): a file whose *importers* changed while its own bytes did not has a
 * changed role, so its summary is served with halved confidence — which the
 * digest's 0.50 prose threshold then drops.
 *
 * @returns {string[]} paths whose role changed
 */
function applyRoleDrift(db, changedPaths, now) {
  const changed = new Set(changedPaths || []);
  const files = db.where('files', { deleted: 0 });
  const byId = new Map(files.map((row) => [row.id, row]));
  const drifted = [];

  // resolved path → importer rows, built once instead of one query per file.
  const importers = new Map();
  for (const row of db.all('imports')) {
    if (!row || typeof row.resolved !== 'string' || !row.resolved) continue;
    if (!importers.has(row.resolved)) importers.set(row.resolved, new Set());
    importers.get(row.resolved).add(row.file_id);
  }

  for (const row of files) {
    const ids = [...(importers.get(row.rel_path) || new Set())]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((importer) => importer.rel_path)
      .sort();
    const sig = hash.sha256Text(ids.join('\n')).slice(0, 16);
    const previous = row.importers_sig || '';
    if (previous !== sig) {
      db.update('files', row.id, { importers_sig: sig });
      if (previous && !changed.has(row.rel_path)) {
        const summary = db.where('summaries', { file_id: row.id })[0];
        if (summary) db.update('summaries', row.id, { role_stale: 1 });
        drifted.push(row.rel_path);
      }
    }
  }

  if (drifted.length) log.debug(`role drift on ${drifted.length} file(s)`);
  return drifted.sort();
}

/**
 * The sweep. Never throws; returns a neutral result on any failure.
 *
 * @param {{ db?: object, root?: string, env?: object, now?: number,
 *           full?: boolean, maxFiles?: number, maxFileBytes?: number,
 *           extensions?: RegExp, entries?: string[] }} [opts]
 *   `db` is the store handle (defaults to the open Loom store); `full` forces a
 *   rehash of every candidate; `entries` are declared entry points passed to
 *   the graph.
 * @returns {{ skipped: boolean, changed?: number, gone?: number, added?: number,
 *             rebuilt?: boolean, indexed?: number, files?: number,
 *             elapsedMs?: number, graph?: object, roleDrift?: string[],
 *             error?: string }}
 */
function refresh(opts = {}) {
  const env = opts.env || process.env;
  let cfg;
  try {
    cfg = configMod.load(env, { silent: true });
  } catch (_) {
    cfg = { ...configMod.DEFAULTS };
  }
  if (!cfg.enabled) return { skipped: true, enabled: false };

  let db = opts.db;
  if (!db) {
    // Required lazily: index.js is the store owner, and refresh.js must not
    // become a second one.
    try {
      // eslint-disable-next-line global-require
      db = require('./index').db();
    } catch (_) {
      db = null;
    }
  }
  if (!db) return { skipped: true, enabled: true, error: 'no-store' };

  const root = path.resolve(opts.root || process.cwd());
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const started = Date.now();

  try {
    return refreshUnsafe(db, root, cfg, now, opts, started);
  } catch (err) {
    log.debug(`refresh failed: ${(err && err.message) || err}`);
    return { skipped: false, enabled: true, error: String((err && err.message) || err) };
  }
}

/** The real sweep; `refresh` is the only caller and catches. */
function refreshUnsafe(db, root, cfg, now, opts, started) {
  const dirty = isDirty(db);
  const forceHash = opts.full === true || dirty;

  const candidates = collectCandidates(root, {
    maxFiles: Number.isFinite(opts.maxFiles) ? opts.maxFiles : cfg.maxFiles,
    rules: readGitignore(root),
    extensions: opts.extensions,
  });
  const candidateSet = new Set(candidates);

  const rows = db.all('files');
  const byPath = new Map(rows.map((row) => [row.rel_path, row]));

  const changed = [];
  const added = [];
  const gone = [];
  const touched = [];

  for (const rel of candidates) {
    const row = byPath.get(rel);
    const stat = hash.statFile(path.join(root, rel));

    if (!stat) {
      // It was in the candidate list a moment ago and is gone now: a race with
      // the tool that is mutating the tree. Tombstone it, do not crash.
      if (row && !row.deleted) gone.push(rel);
      continue;
    }

    if (!row || row.deleted) {
      added.push(rel);
      continue;
    }

    // §5.1 fast negative: equal size and mtime means "assume unchanged".
    if (!forceHash && hash.statMatches(stat, row)) continue;

    const sha = hash.safeSha256File(path.join(root, rel));
    if (!sha) {
      if (!row.deleted) gone.push(rel);
      continue;
    }
    if (sha === row.content_sha) {
      // Same bytes, new mtime (checkout, rsync, copy): refresh the stat only.
      db.update('files', row.id, { bytes: stat.bytes, mtime_ms: stat.mtimeMs });
      touched.push(rel);
      continue;
    }
    changed.push(rel);
  }

  for (const row of rows) {
    if (row.deleted) continue;
    if (candidateSet.has(row.rel_path)) continue;
    gone.push(row.rel_path);
  }

  const total = candidates.length + gone.length;
  const churn = total > 0 ? (changed.length + added.length + gone.length) / total : 0;
  // §5.2 step 5: above the threshold the whole index is suspect, so rebuild.
  // The first run is always above it — which is exactly right: everything is new.
  const rebuilt = churn > cfg.rebuildThreshold;
  const reindex = rebuilt ? candidates : changed.concat(added);

  const indexNow = (rel) => {
    const stat = hash.statFile(path.join(root, rel));
    if (!stat) return null;
    const sha = hash.safeSha256File(path.join(root, rel));
    if (!sha) return null;
    return indexFile(db, root, rel, {
      stat,
      sha,
      now,
      maxFileBytes: Number.isFinite(opts.maxFileBytes) ? opts.maxFileBytes : cfg.maxFileBytes,
    });
  };

  let indexed = 0;
  for (const rel of reindex) {
    const result = indexNow(rel);
    if (result && result.state !== 'error') indexed += 1;
  }

  // A rebuild re-indexes every candidate; anything left over is gone.
  const toTombstone = rebuilt
    ? rows.filter((row) => !row.deleted && !candidateSet.has(row.rel_path)).map((row) => row.rel_path)
    : gone;
  for (const rel of toTombstone) tombstone(db, rel, now);

  // Role drift is about files whose *own bytes* did not change, so a rebuild
  // (which re-indexes everything) must not count as a content change.
  const roleDrift = applyRoleDrift(db, changed.concat(added), now);

  // The graph is derived, but rebuilding it here is what makes the digest and
  // `related` cheap on the next call.
  const graph = graphMod.buildGraph(filesForGraph(db), { root, entries: opts.entries });

  metaSet(db, META_BUILT_AT, String(now));
  if (forceHash) metaSet(db, META_REHASH, String(now));
  clearDirty(db);
  try { migrate.purgeOldAccess(db, now); } catch (_) { /* retention is best effort */ }

  return {
    skipped: false,
    enabled: true,
    changed: changed.length,
    added: added.length,
    gone: [...new Set(toTombstone)].length,
    touched: touched.length,
    rebuilt,
    indexed,
    dirty,
    files: db.count('files'),
    roleDrift,
    elapsedMs: Date.now() - started,
    graph: graph.stats,
  };
}

// ── reading back ────────────────────────────────────────────────────────────

/**
 * The stored rows, in the shape `graph.buildGraph` takes.
 *
 * A summary is included only when its `sha` matches the file's current content
 * and it is not role-stale — prose is never served stale (I3, §5.1).
 *
 * @param {object} db
 * @returns {Array<object>}
 */
function filesForGraph(db) {
  if (!db) return [];
  const files = db.where('files', { deleted: 0 })
    .slice()
    .sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));

  const symbols = new Map();
  for (const row of db.all('symbols')) {
    if (!symbols.has(row.file_id)) symbols.set(row.file_id, []);
    symbols.get(row.file_id).push({
      name: row.name,
      kind: row.kind,
      line_start: row.line_start,
      line_end: row.line_end,
      signature: row.signature,
      exported: row.exported === 1 || row.exported === true,
      parent: row.parent,
      doc: row.doc,
      confidence: row.confidence,
    });
  }

  const imports = new Map();
  for (const row of db.all('imports')) {
    if (!imports.has(row.file_id)) imports.set(row.file_id, []);
    imports.get(row.file_id).push({ specifier: row.specifier, resolved: row.resolved, kind: row.kind });
  }

  const summaries = new Map();
  for (const row of db.all('summaries')) summaries.set(row.file_id, row);

  return files.map((row) => {
    const summary = summaries.get(row.id);
    const usable = summary && summary.sha === row.content_sha && summary.role_stale !== 1;
    return {
      path: row.rel_path,
      lang: row.lang,
      loc: row.loc,
      partial: row.parse_state === 'partial',
      summary: usable ? summary.purpose : '',
      symbols: symbols.get(row.id) || [],
      imports: imports.get(row.id) || [],
    };
  });
}

/**
 * The dependency graph as it stands in the store.
 * @param {object} db
 * @param {{ root?: string, entries?: string[], env?: object }} [opts]
 */
function readGraph(db, opts = {}) {
  if (!db) return graphMod.emptyGraph();
  return graphMod.buildGraph(filesForGraph(db), opts);
}

// ── access ──────────────────────────────────────────────────────────────────

/**
 * Record that the agent touched a file (§7). The digest ranks by the decayed
 * sum of these, which is the whole point of storing an index.
 *
 * @param {object} db
 * @param {string} relPath project-relative, forward slashes
 * @param {'edit'|'write'|'read'|'search_hit'} op
 * @param {{ session?: string, lines?: number, ts?: number }} [opts]
 * @returns {boolean} whether a row was written
 */
function recordAccess(db, relPath, op, opts = {}) {
  try {
    if (!db || !ACCESS_OPS.includes(op)) return false;
    const rel = paths.normalizeRel(relPath);
    if (!rel) return false;
    const row = fileRow(db, rel);
    // No row means Loom has never indexed the file: an access row would point
    // at nothing, and the next refresh creates it with a fresh id anyway.
    if (!row || row.deleted) return false;

    db.insert('access', {
      file_id: row.id,
      ts: Number.isFinite(opts.ts) ? opts.ts : Date.now(),
      session: String(opts.session || ''),
      op,
      lines: Number.isFinite(opts.lines) ? Math.max(0, Math.trunc(opts.lines)) : 0,
    });
    return true;
  } catch (err) {
    log.debug(`recordAccess failed: ${(err && err.message) || err}`);
    return false;
  }
}

/**
 * Access rows in the shape `renderDigest` takes (`{ path, op, ts }`).
 *
 * @param {object} db
 * @param {{ limit?: number }} [opts] most recent `limit` rows (default: all)
 * @returns {Array<{ path: string, op: string, ts: number, lines: number, session: string }>}
 */
function accessRows(db, opts = {}) {
  try {
    if (!db) return [];
    const byId = new Map(db.all('files').map((row) => [row.id, row]));
    let rows = db.all('access')
      .filter((row) => byId.has(row.file_id))
      .sort((a, b) => a.ts - b.ts || a.id - b.id);
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 0;
    if (limit && rows.length > limit) rows = rows.slice(-limit);
    return rows.map((row) => ({
      path: byId.get(row.file_id).rel_path,
      op: row.op,
      ts: row.ts,
      lines: row.lines,
      session: row.session,
    }));
  } catch (err) {
    log.debug(`accessRows failed: ${(err && err.message) || err}`);
    return [];
  }
}

module.exports = {
  SKIP_DIRS,
  SKIP_FILES,
  EXTRACTABLE,
  ACCESS_OPS,
  DEFAULT_MAX_FILES,
  collectCandidates,
  readGitignore,
  indexFile,
  tombstone,
  refresh,
  filesForGraph,
  readGraph,
  recordAccess,
  accessRows,
  markDirty,
  clearDirty,
  isDirty,
  applyRoleDrift,
};
