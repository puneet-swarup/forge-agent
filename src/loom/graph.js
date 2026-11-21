'use strict';
// src/loom/graph.js — the dependency graph over the `imports` table.
//
// Spec: src/loom_specs.md §5.6. Three jobs, in this order:
//
//   1. write edges — an extractor's `{specifier}` list plus `resolve.js` becomes
//      rows in `imports` (`specifier`, `resolved`, `kind`). A specifier that does
//      not resolve keeps `resolved = NULL`: the edge is recorded as *not
//      followed*, never guessed (see resolve.js for why).
//   2. read edges back — `importers()` (who points at me) and `dependencies()`
//      (what I point at), both sorted and de-duplicated, both live-files-only.
//   3. role drift — `importers_sig` per file, and `summaries.role_stale` when
//      that signature moved while the file's own bytes did not.
//
// Role drift is the point of the whole file. A file's *purpose* is a function of
// its content and of who uses it; when three modules start importing a helper,
// its one-line summary is out of date even though its `content_sha` never
// changed. Re-reading the file would not tell you that. The signature is
// computed from the `imports` table alone (§5.6), so the check costs one query
// per rebuild rather than a re-parse per file.
//
// Deliberate decisions recorded here, also in docs/LOOM.md:
//
//   * First computation is not drift. A row whose `importers_sig` is still `''`
//     has never been compared, so `rebuildGraph()` records the signature and
//     leaves `role_stale` alone. Without that, the first index of any project
//     would mark every summary stale and halve its prose confidence for nothing.
//   * Drift is one-way. `rebuildGraph()` sets `role_stale = 1`; only a fresh
//     summary clears it (§5.7 recomputes confidence from a new `sha`). A
//     signature that drifts back is still a summary written against an older
//     import set.
//   * `importers_sig` of a file with no importers is `sha256('')` truncated to
//     16 hex characters, exactly as §5.6 writes it — not `''`, which is the
//     sentinel for "never computed".
//
// Invariant I1: every export catches and returns a neutral value.

const crypto = require('crypto');

const log = require('./log');
const resolveMod = require('./resolve');

/** §5.6 truncates the digest to 16 hex characters. */
const SIG_LENGTH = 16;

/** The signature of a file nobody imports (§5.6, applied to an empty list). */
const EMPTY_SIG = crypto.createHash('sha256').update('', 'utf8').digest('hex').slice(0, SIG_LENGTH);

/**
 * `importers_sig` of one importer list (§5.6).
 *
 * The list is de-duplicated and sorted first, so a re-ordered `imports` table —
 * two import statements swapping lines, a re-index writing rows in a different
 * order — produces the same signature. Only a *different set* of importers moves
 * it, which is what "the file's role changed" means.
 *
 * @param {string[]} importerPaths project-relative importer paths
 * @returns {string} 16 hex characters
 */
function signatureOf(importerPaths) {
  const unique = [...new Set((importerPaths || []).filter((p) => typeof p === 'string' && p !== ''))];
  unique.sort();
  if (unique.length === 0) return EMPTY_SIG;
  return crypto
    .createHash('sha256')
    .update(unique.join('\n'), 'utf8')
    .digest('hex')
    .slice(0, SIG_LENGTH);
}

/** Live files (not tombstoned), as `[{ id, rel_path, content_sha, importers_sig }]`. */
function liveFiles(db) {
  return db.all('files').filter((row) => Number(row.deleted) !== 1);
}

/**
 * Write one file's edges. Existing rows for the file are replaced, so a removed
 * import disappears from the graph on the next write instead of lingering.
 *
 * @param {object} db store handle
 * @param {{ fileId?: number, relPath?: string,
 *           imports: Array<{specifier: string, kind?: string}>,
 *           root?: string, exists?: (rel: string) => boolean }} opts
 * @returns {{ fileId: number|null, written: number, resolved: number }}
 */
function writeEdges(db, opts = {}) {
  const empty = { fileId: null, written: 0, resolved: 0 };
  try {
    if (!db) return empty;
    const relPath = opts.relPath ? String(opts.relPath) : '';
    let fileId = Number.isFinite(opts.fileId) ? opts.fileId : null;
    if (fileId === null) {
      if (relPath === '') return empty;
      const row = db.where('files', { rel_path: relPath })[0];
      if (!row) return empty;
      fileId = row.id;
    }

    const fromRel = relPath || (db.get('files', fileId) || {}).rel_path || '';
    const rows = resolveMod.resolveImports(opts.imports || [], fromRel, {
      root: opts.root,
      exists: opts.exists,
    });
    db.replaceWhere('imports', { file_id: fileId }, rows.map((row) => ({ ...row, file_id: fileId })));

    return {
      fileId,
      written: rows.length,
      resolved: rows.filter((row) => row.resolved).length,
    };
  } catch (err) {
    log.debug(`writeEdges failed: ${err.message}`);
    return empty;
  }
}

/**
 * Live files that import `relPath`, sorted by path.
 * @returns {string[]}
 */
function importers(db, relPath) {
  try {
    if (!db) return [];
    const target = String(relPath || '');
    if (target === '') return [];
    const live = new Map(liveFiles(db).map((row) => [row.id, row.rel_path]));
    const found = new Set();
    for (const edge of db.all('imports')) {
      if (edge.resolved !== target) continue;
      const importer = live.get(edge.file_id);
      if (importer && importer !== target) found.add(importer);
    }
    return [...found].sort();
  } catch (err) {
    log.debug(`importers failed: ${err.message}`);
    return [];
  }
}

/**
 * Paths `relPath` imports, resolved and de-duplicated, sorted.
 * Unresolved and external specifiers are absent — they are not edges.
 * @returns {string[]}
 */
function dependencies(db, relPath) {
  try {
    if (!db) return [];
    const target = String(relPath || '');
    if (target === '') return [];
    const row = db.where('files', { rel_path: target })[0];
    if (!row) return [];
    const live = new Set(liveFiles(db).map((r) => r.rel_path));
    const found = new Set();
    for (const edge of db.all('imports')) {
      if (edge.file_id !== row.id || !edge.resolved) continue;
      if (edge.resolved === target) continue;
      if (live.has(edge.resolved)) found.add(edge.resolved);
    }
    return [...found].sort();
  } catch (err) {
    log.debug(`dependencies failed: ${err.message}`);
    return [];
  }
}

/** The `imports` rows of one file, for diagnostics and tests. */
function edgesOf(db, relPath) {
  try {
    if (!db) return [];
    const row = db.where('files', { rel_path: String(relPath || '') })[0];
    if (!row) return [];
    return db.where('imports', { file_id: row.id });
  } catch (err) {
    log.debug(`edgesOf failed: ${err.message}`);
    return [];
  }
}

/**
 * Recompute `importers_sig` for every live file and flag role drift (§5.6).
 *
 * One pass over `files` and one over `imports`, joined in memory: the store
 * interface has no GROUP BY, and 2,000 files must not become 2,000 queries.
 *
 * @param {object} db store handle
 * @returns {{ files: number, edges: number, unfollowed: number,
 *             signaturesChanged: number, roleStale: number, firstRun: number }}
 */
function rebuildGraph(db) {
  const stats = { files: 0, edges: 0, unfollowed: 0, signaturesChanged: 0, roleStale: 0, firstRun: 0 };
  try {
    if (!db) return stats;

    const live = liveFiles(db);
    const liveIds = new Map(live.map((row) => [row.id, row.rel_path]));
    stats.files = live.length;

    const livePaths = new Set(live.map((row) => row.rel_path));

    /** resolved path → set of live importer paths */
    const importersByTarget = new Map();
    for (const edge of db.all('imports')) {
      if (!liveIds.has(edge.file_id)) continue;
      if (!edge.resolved) {
        stats.unfollowed += 1;
        continue;
      }
      // An edge into a tombstoned file is not a dependency any more; the next
      // write of the importer's edges replaces it, and counting it here would
      // keep a deleted file looking alive.
      if (!livePaths.has(edge.resolved)) continue;
      stats.edges += 1;
      const importer = liveIds.get(edge.file_id);
      if (importer === edge.resolved) continue;
      let set = importersByTarget.get(edge.resolved);
      if (!set) {
        set = new Set();
        importersByTarget.set(edge.resolved, set);
      }
      set.add(importer);
    }

    for (const row of live) {
      const next = signatureOf([...(importersByTarget.get(row.rel_path) || [])]);
      const prev = row.importers_sig == null ? '' : String(row.importers_sig);
      if (next === prev) continue;

      db.update('files', row.id, { importers_sig: next });
      stats.signaturesChanged += 1;

      if (prev === '') {
        // Never compared before: record the baseline, do not call it drift.
        stats.firstRun += 1;
        continue;
      }

      const summary = db.get('summaries', row.id);
      if (!summary) continue;
      if (Number(summary.role_stale) === 1) continue;
      db.update('summaries', row.id, { role_stale: 1 });
      stats.roleStale += 1;
    }

    return stats;
  } catch (err) {
    log.debug(`rebuildGraph failed: ${err.message}`);
    return stats;
  }
}

module.exports = {
  SIG_LENGTH,
  EMPTY_SIG,
  signatureOf,
  liveFiles,
  writeEdges,
  importers,
  dependencies,
  edgesOf,
  rebuildGraph,
};
