// src/loom/query.js — asking the index questions.
//
// The digest orients the model at the start of a run. These are the questions it
// asks afterwards: "where is this defined", "what is in this file", "who uses
// it". They read the stored index, so they cost a table scan rather than a walk
// of the working tree.
//
// Both are pure over the rows they are given: no I/O, no globals, no throw. The
// boundary that opens the store lives in attach.js, so a broken index costs a
// tool call, not a run (invariant I1).
'use strict';

/** Maximum rows returned when a caller does not say. */
const DEFAULT_LIMIT = 20;

/** Normalise a query for matching: lowercase, collapse separators. */
function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * How well a symbol name matches a query.
 *
 * Deliberately simple and explainable: exact, then prefix, then substring, then
 * subsequence ("rtp" finds "renderToPage"). A score the model cannot predict is
 * worse than no score.
 *
 * @returns {number} 0 when it does not match
 */
function scoreName(name, query) {
  const a = normalise(name);
  const q = normalise(query);
  if (!a || !q) return 0;

  if (a === q) return 100;
  if (a.startsWith(q)) return 80;
  if (a.includes(q)) return 60;

  // Subsequence: every query character appears in order.
  let i = 0;
  for (const ch of a) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 30;
  }

  return 0;
}

/**
 * Find symbols, files and paths matching a query.
 *
 * @param {object} db      the store handle
 * @param {string} query
 * @param {object} [opts]  { limit, kind, exportedOnly, files }
 * @returns {{query: string, results: Array<object>, total: number}}
 */
function recall(db, query, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const results = [];

  if (!db || !query) return { query: String(query || ''), results, total: 0 };

  const files = new Map();
  for (const row of db.where('files', { deleted: 0 })) files.set(row.id, row);

  // ── symbols ────────────────────────────────────────────────────────────
  for (const sym of db.all('symbols')) {
    const file = files.get(sym.file_id);
    if (!file) continue; // deleted file: its symbols are already gone
    if (opts.kind && sym.kind !== opts.kind) continue;
    if (opts.exportedOnly && sym.exported !== 1 && sym.exported !== true) continue;

    const score = scoreName(sym.name, query);
    if (!score) continue;

    results.push({
      kind: 'symbol',
      score: score + (sym.exported ? 5 : 0),
      name: sym.name,
      symbolKind: sym.kind,
      path: file.rel_path,
      line: sym.line_start,
      signature: sym.signature || '',
      exported: sym.exported === 1 || sym.exported === true,
    });
  }

  // ── file paths and summaries ───────────────────────────────────────────
  for (const row of files.values()) {
    const score = scoreName(row.rel_path, query);
    if (score) {
      results.push({
        kind: 'file',
        score: score - 10, // a path match is weaker than a symbol match
        path: row.rel_path,
        lang: row.lang,
        loc: row.loc,
      });
    }
  }

  for (const summary of db.all('summaries')) {
    const file = files.get(summary.file_id);
    if (!file) continue;
    if (summary.role_stale === 1) continue;

    const score = scoreName(summary.purpose, query);
    if (score < 60) continue; // only strong prose matches

    results.push({
      kind: 'summary',
      score: score - 20,
      path: file.rel_path,
      purpose: summary.purpose,
    });
  }

  results.sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : 1));

  return {
    query: String(query),
    results: results.slice(0, limit),
    total: results.length,
  };
}

/**
 * Everything the index knows about one file.
 *
 * @param {object} db
 * @param {string} relPath
 * @param {object} [opts] { limit }
 * @returns {object|null} null when the file is not indexed
 */
function whatsHere(db, relPath, opts = {}) {
  if (!db || !relPath) return null;

  const target = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  const file = db.where('files', { rel_path: target, deleted: 0 })[0]
    || db.where('files', { rel_path: target })[0];

  if (!file) return null;

  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;

  const symbols = db.where('symbols', { file_id: file.id })
    .map((s) => ({
      name: s.name,
      kind: s.kind,
      line: s.line_start,
      signature: s.signature || '',
      exported: s.exported === 1 || s.exported === true,
    }))
    .sort((a, b) => a.line - b.line)
    .slice(0, limit);

  const imports = db.where('imports', { file_id: file.id })
    .map((i) => ({ specifier: i.specifier, resolved: i.resolved || null, kind: i.kind }));

  // Who imports this file: the resolved column is the reverse edge.
  const dependents = [...new Set(
    db.all('imports')
      .filter((i) => i.resolved === file.rel_path)
      .map((i) => (db.get('files', i.file_id) || {}).rel_path)
      .filter(Boolean)
  )].sort();

  const summary = db.where('summaries', { file_id: file.id })[0];
  const summaryUsable = summary
    && summary.sha === file.content_sha
    && summary.role_stale !== 1;

  return {
    path: file.rel_path,
    lang: file.lang,
    loc: file.loc,
    bytes: file.bytes,
    deleted: file.deleted === 1,
    purpose: summaryUsable ? summary.purpose : '',
    symbols,
    imports,
    dependents,
    exportedCount: symbols.filter((s) => s.exported).length,
  };
}

/**
 * Render a recall result as the text a model reads.
 *
 * @param {object} result from recall()
 * @returns {string}
 */
function formatRecall(result) {
  const r = result || {};
  const rows = Array.isArray(r.results) ? r.results : [];

  if (rows.length === 0) {
    return `No match for ${JSON.stringify(r.query || '')}.`;
  }

  const lines = [`${rows.length} of ${r.total} match${r.total === 1 ? '' : 'es'} for ${JSON.stringify(r.query)}:`];

  for (const row of rows) {
    if (row.kind === 'symbol') {
      const exp = row.exported ? ' (exported)' : '';
      const sig = row.signature ? ` — ${row.signature}` : '';
      lines.push(`  ${row.path}:${row.line}  ${row.symbolKind} ${row.name}${exp}${sig}`);
    } else if (row.kind === 'file') {
      lines.push(`  ${row.path}  (${row.lang}, ${row.loc} loc)`);
    } else if (row.kind === 'summary') {
      lines.push(`  ${row.path}  ${row.purpose}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render a whats_here result as text.
 *
 * @param {object|null} info from whatsHere()
 * @param {string} path
 * @returns {string}
 */
function formatWhatsHere(info, path) {
  if (!info) return `${path} is not in the index.`;

  const lines = [`${info.path} — ${info.lang}, ${info.loc} loc, ${info.bytes} bytes`];

  if (info.purpose) lines.push(`  purpose: ${info.purpose}`);

  if (info.symbols.length) {
    lines.push(`  symbols (${info.symbols.length}, ${info.exportedCount} exported):`);
    for (const s of info.symbols.slice(0, 25)) {
      lines.push(`    ${s.line}  ${s.kind} ${s.name}${s.exported ? ' (exported)' : ''}`);
    }
    if (info.symbols.length > 25) lines.push(`    … ${info.symbols.length - 25} more`);
  }

  if (info.imports.length) {
    lines.push(`  imports (${info.imports.length}):`);
    for (const i of info.imports.slice(0, 15)) {
      lines.push(`    ${i.specifier}${i.resolved ? ` → ${i.resolved}` : ''}`);
    }
  }

  if (info.dependents.length) {
    lines.push(`  imported by (${info.dependents.length}):`);
    for (const d of info.dependents.slice(0, 15)) lines.push(`    ${d}`);
  }

  return lines.join('\n');
}

module.exports = {
  recall,
  whatsHere,
  formatRecall,
  formatWhatsHere,
  scoreName,
  DEFAULT_LIMIT,
};
