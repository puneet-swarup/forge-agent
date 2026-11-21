'use strict';
// src/loom/digest.js — the budget compiler.
//
// Spec: src/loom_specs.md §8 (budget, section order, line formats), §7 (heat),
// §6.4 (what a file with no purpose looks like) and invariants I1, I2, I3, I6.
//
// The digest is the only thing the model sees before it has read a single file,
// so it has one job: fit as much true orientation as possible into a hard
// character ceiling. Three rules make that predictable:
//
//   * the ceiling is `maxTokens * 4` characters, estimated as ceil(chars / 4)
//     — the convention config.js and the rest of the repo already use;
//   * sections are filled in priority order (entry, directories, hot files, key
//     symbols, notes, changed) and the fill *stops* at the first line that does
//     not fit. A line is either emitted whole or not at all: a half path or a
//     half symbol name is worse than no line, because the model will act on it;
//   * header, stack and footer are never dropped; everything else can be.
//
// Invariants held here:
//   I1 — `renderDigest` never throws; a failure yields ''.
//   I2 — `LOOM_ENABLED=0` returns '' before touching the graph.
//   I3 — a symbol from a file flagged `partial: true` is never presented as
//        authoritative: its export clause and symbol lines are omitted and its
//        hot-file line is labelled as an unverified structure.
//   I6 — every path printed is normalised project-relative, forward slashes.
//
// §7 heat is implemented here as `heatOf`, because this is the only module in
// this slice that ranks files. It follows the spec formula exactly so a later
// heat.js can take it over without changing a single number.

const log = require('./log');
const paths = require('./paths');

/** §7 op weights. */
const OP_WEIGHT = Object.freeze({ edit: 4, write: 3, read: 2, search_hit: 1 });

/** §7 half-life, in days. */
const HALF_LIFE_DAYS = 14;
const DAY_MS = 86400000;

const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_SYMBOLS = 24;
const MAX_ENTRY_PATHS = 6;
const MAX_DIRECTORIES = 5;
const MAX_NOTES = 6;
const MAX_CHANGED = 8;
const MAX_EXPORT_NAMES = 6;
const MAX_PURPOSE_CHARS = 140;

/** §5.7: the digest includes symbols at or above this confidence. */
const SYMBOL_CONFIDENCE = 0.70;

/** §8.3 footer, verbatim. */
const FOOTER = 'Line ranges are approximate. Always read_file a region before editing it.';

/** §6.4: the stand-in when a file has no purpose yet. */
const PURPOSE_PENDING = '(purpose pending re-index)';

/** Extension → language name, for the `Stack:` line when the caller has none. */
const LANGUAGE_NAMES = Object.freeze({
  js: 'JavaScript',
  ts: 'TypeScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  sql: 'SQL',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
});

/** Locale-free compare: identical output on every machine. */
function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * I2 kill switch. Deliberately a string compare and nothing else — a disabled
 * Loom must not parse config, build a section list, or allocate a budget.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isDisabled(env) {
  const source = env || process.env;
  if (!source) return false;
  const raw = source.LOOM_ENABLED;
  return raw === '0' || raw === 'false';
}

/**
 * §7 heat for one file.
 *
 * @param {object} node graph node (`path`, `entry`, `inDegree`)
 * @param {{ accessWeight?: number, noteCount?: number }} [signals]
 * @returns {number}
 */
function heatOf(node, signals) {
  const extra = signals || {};
  const accessWeight = Number.isFinite(extra.accessWeight) ? extra.accessWeight : 0;
  const noteCount = Number.isFinite(extra.noteCount) ? extra.noteCount : 0;
  const entry = node && node.entry === true ? 3 : 0;
  const importers = node && Number.isFinite(node.inDegree) ? node.inDegree : 0;
  const connected = importers >= 3 ? 2 : 0;
  const noted = noteCount > 0 ? 2 : 0;
  return accessWeight + entry + connected + noted;
}

/** §7: files the ranking must ignore entirely. */
function isRankable(node) {
  if (!node || typeof node.path !== 'string') return false;
  if (node.deleted) return false;
  if (typeof node.parse_state === 'string' && node.parse_state !== 'ok') return false;
  return true;
}

/** §7 access decay: Σ weight * exp(-ageDays / halfLife). */
function accessWeights(rows, now, halfLifeDays) {
  const byPath = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const rel = paths.normalizeRel(row.path || row.rel_path);
    const weight = OP_WEIGHT[row.op];
    if (!rel || !weight) continue;
    const ts = Number.isFinite(row.ts) ? row.ts : now;
    const ageDays = Math.max(0, (now - ts) / DAY_MS);
    byPath.set(rel, (byPath.get(rel) || 0) + weight * Math.exp(-ageDays / halfLifeDays));
  }
  return byPath;
}

/** Note count per scope path. */
function noteCounts(notes) {
  const byPath = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || typeof note !== 'object') continue;
    const rel = paths.normalizeRel(note.path || note.scope);
    if (!rel) continue;
    byPath.set(rel, (byPath.get(rel) || 0) + 1);
  }
  return byPath;
}

/** Collapse whitespace and clip at a word boundary; never mid-word. */
function clip(text, max) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${head.trim()}…`;
}

/** Characters in the rendered document; lines are joined by one newline. */
function measure(lines) {
  if (!lines.length) return 0;
  let total = lines.length - 1;
  for (const line of lines) total += line.length;
  return total;
}

/** The two-segment directory a path belongs to, or '' at the root. */
function dirKey(relPath) {
  const idx = relPath.lastIndexOf('/');
  if (idx <= 0) return '';
  const segments = relPath.slice(0, idx).split('/');
  return segments.length >= 2 ? segments.slice(0, 2).join('/') : segments[0];
}

/** §6.1 export clause: exported, confidence >= 0.70, at most six, one line. */
function exportClause(node) {
  if (node.partial) return ''; // I3
  const seen = new Set();
  const names = [];
  for (const symbol of Array.isArray(node.symbols) ? node.symbols : []) {
    if (!symbol || !symbol.exported) continue;
    if (!Number.isFinite(symbol.confidence) || symbol.confidence < SYMBOL_CONFIDENCE) continue;
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    names.push(symbol);
  }
  names.sort((a, b) => a.line_start - b.line_start || compareStrings(a.name, b.name));
  if (!names.length) return '';
  return ` Exports: ${names.slice(0, MAX_EXPORT_NAMES).map((s) => s.name).join(', ')}.`;
}

/** The `Stack:` value: what the caller says, else what the languages imply. */
function stackLine(nodes, opts) {
  const given = Array.isArray(opts.stack) ? opts.stack.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (given.length) return given.map((s) => s.trim()).join(', ');

  const counts = new Map();
  for (const node of nodes) {
    const lang = typeof node.lang === 'string' ? node.lang : null;
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  const ordered = [...counts.entries()]
    .map(([lang, count]) => ({ name: LANGUAGE_NAMES[lang] || lang, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.name, b.name))
    .slice(0, 3)
    .map((entry) => entry.name);
  return ordered.length ? ordered.join(', ') : 'unknown';
}

/**
 * Render the orientation digest.
 *
 * @param {object} graph output of `graph.buildGraph`
 * @param {{ maxTokens?: number, maxFiles?: number, maxSymbols?: number,
 *           stack?: string[], root?: string, notes?: object[], changed?: string[],
 *           access?: object[], now?: number, halfLifeDays?: number,
 *           env?: object, counters?: object }} [opts]
 *   `access` rows are `{ path|rel_path, op, ts }` (§7); `notes` are
 *   `{ text, verified, scope|path }`; `changed` are paths not re-indexed;
 *   `now` (ms epoch) pins heat decay for tests; `counters.digestTruncations` is
 *   incremented once per dropped section when a counters object is passed.
 * @returns {string} '' when disabled, on malformed input, or on internal error
 */
function renderDigest(graph, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (isDisabled(options.env)) return '';
  try {
    return render(graph, options);
  } catch (err) {
    log.debug(`renderDigest failed: ${(err && err.message) || err}`);
    return '';
  }
}

/**
 * The real renderer. Throws on a bug; `renderDigest` is the only caller and
 * catches.
 *
 * @param {object} graph
 * @param {object} opts
 * @returns {string}
 */
function render(graph, opts) {
  if (!graph || typeof graph !== 'object') return '';

  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .filter((node) => node && typeof node === 'object' && typeof node.path === 'string');
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  const maxTokens = Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
    ? Math.floor(opts.maxTokens)
    : DEFAULT_MAX_TOKENS;
  const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0
    ? Math.floor(opts.maxFiles)
    : DEFAULT_MAX_FILES;
  const maxSymbols = Number.isFinite(opts.maxSymbols) && opts.maxSymbols > 0
    ? Math.floor(opts.maxSymbols)
    : DEFAULT_MAX_SYMBOLS;
  const charBudget = maxTokens * 4;

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const halfLifeDays = Number.isFinite(opts.halfLifeDays) && opts.halfLifeDays > 0
    ? opts.halfLifeDays
    : HALF_LIFE_DAYS;

  // Importer counts: from the edges, which are authoritative, with the node's
  // recorded degree as the fallback for a graph built without edges.
  const importers = new Map();
  for (const edge of edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
    if (!importers.has(edge.to)) importers.set(edge.to, new Set());
    importers.get(edge.to).add(edge.from);
  }
  const importerCount = (node) => {
    const set = importers.get(node.path);
    if (set) return set.size;
    return Number.isFinite(node.inDegree) ? node.inDegree : 0;
  };

  const weights = accessWeights(opts.access, now, halfLifeDays);
  const noted = noteCounts(opts.notes);

  const ranked = nodes
    .filter(isRankable)
    .map((node) => ({
      node,
      score: heatOf(
        { entry: node.entry === true, inDegree: importerCount(node) },
        { accessWeight: weights.get(node.path) || 0, noteCount: noted.get(node.path) || 0 },
      ),
    }))
    .sort((a, b) => b.score - a.score || compareStrings(a.node.path, b.node.path));

  const rootName = typeof opts.root === 'string' && opts.root.trim()
    ? opts.root.trim()
    : (typeof graph.root === 'string' && graph.root.trim() ? graph.root.trim() : 'project');

  const head = [
    `# Project map (Loom, ${nodes.length} files indexed)`,
    `Stack: ${stackLine(nodes, opts)} · root: ${rootName}`,
  ];

  const foot = ['', FOOTER];

  // ── optional sections, in §8.2 priority order ────────────────────────────

  // Declared entry points first (package.json targets, `src/cli.js` and
  // friends, anything the caller named), then the inferred ones, so the line
  // leads with the file a reader should open rather than with the first leaf
  // script in alphabetical order.
  const orderedEntries = [];
  const seenEntries = new Set();
  // A hand-built graph may carry only the per-node flag; treat it as the
  // inferred set rather than losing the line entirely.
  const inferred = nodes.filter((node) => node.entry === true).map((node) => node.path);
  for (const group of [graph.declaredEntries, graph.entries, inferred]) {
    for (const raw of Array.isArray(group) ? group.slice().sort(compareStrings) : []) {
      const rel = paths.normalizeRel(raw);
      if (!rel || seenEntries.has(rel)) continue;
      seenEntries.add(rel);
      orderedEntries.push(rel);
    }
  }
  const entryLines = orderedEntries.length
    ? [`Entry: ${orderedEntries.slice(0, MAX_ENTRY_PATHS).join(', ')}`]
    : [];

  const dirCounts = new Map();
  for (const node of nodes) {
    const key = dirKey(node.path);
    if (!key) continue;
    dirCounts.set(key, (dirCounts.get(key) || 0) + 1);
  }
  const dirEntries = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .slice(0, MAX_DIRECTORIES);
  const dirLines = dirEntries.length
    ? [`Dirs: ${dirEntries.map(([dir, count]) => `${dir} (${count})`).join(', ')}`]
    : [];

  const hotNodes = ranked.slice(0, maxFiles).map((entry) => entry.node);
  const hotLines = [];
  if (hotNodes.length) {
    hotLines.push('', '## Hot files');
    for (const node of hotNodes) {
      const purpose = clip(node.summary, MAX_PURPOSE_CHARS) || PURPOSE_PENDING;
      const loc = Number.isFinite(node.loc) ? Math.max(0, Math.trunc(node.loc)) : 0;
      const partial = node.partial ? ' (partial index — structure unverified)' : '';
      hotLines.push(`- ${node.path} (${loc}L) — ${purpose}${exportClause(node)}${partial}`);
    }
  }

  const symbolLines = [];
  const seenSymbols = new Set();
  for (const node of hotNodes) {
    if (node.partial) continue; // I3: never authoritative
    const symbols = (Array.isArray(node.symbols) ? node.symbols : [])
      .filter((s) => s && typeof s.name === 'string' && s.name && s.exported)
      .filter((s) => Number.isFinite(s.confidence) && s.confidence >= SYMBOL_CONFIDENCE)
      .sort((a, b) => a.line_start - b.line_start || compareStrings(a.name, b.name));
    for (const symbol of symbols) {
      if (symbolLines.length >= maxSymbols) break;
      const key = `${node.path}\u0000${symbol.name}\u0000${symbol.line_start}`;
      if (seenSymbols.has(key)) continue;
      seenSymbols.add(key);
      symbolLines.push(`- ${symbol.name} [${symbol.kind || 'const'}] ${node.path}:${symbol.line_start}-${symbol.line_end}`);
    }
    if (symbolLines.length >= maxSymbols) break;
  }
  const symbolBlock = symbolLines.length ? ['', '## Key symbols', ...symbolLines] : [];

  const noteRows = (Array.isArray(opts.notes) ? opts.notes : [])
    .filter((note) => note && typeof note === 'object' && typeof note.text === 'string' && note.text.trim())
    .map((note) => ({
      scope: typeof note.scope === 'string' ? note.scope : '',
      text: clip(note.text, 200),
      verified: note.verified === undefined ? true : Boolean(note.verified),
    }))
    .sort((a, b) => compareStrings(a.scope, b.scope) || compareStrings(a.text, b.text))
    .slice(0, MAX_NOTES);
  const noteLines = noteRows.length
    ? ['', '## Notes', ...noteRows.map((note) => `- ${note.text}${note.verified ? '' : ' (unverified)'}`)]
    : [];

  const changedPaths = (Array.isArray(opts.changed) ? opts.changed : [])
    .map((p) => paths.normalizeRel(p))
    .filter(Boolean);
  const changedLines = changedPaths.length
    ? ['', `Changed, not re-indexed: ${[...new Set(changedPaths)].sort(compareStrings).slice(0, MAX_CHANGED).join(', ')}`]
    : [];

  const sections = [
    { lines: entryLines, headerLines: 0 },
    { lines: dirLines, headerLines: 0 },
    { lines: hotLines, headerLines: 2 },
    { lines: symbolBlock, headerLines: 2 },
    { lines: noteLines, headerLines: 2 },
    { lines: changedLines, headerLines: 1 },
  ];

  // ── fill ────────────────────────────────────────────────────────────────
  // Header, stack and footer are mandatory (§8.2). If even they do not fit the
  // ceiling, the honest answer is an empty digest rather than an over-budget
  // one — a truncated footer would be a lie about line ranges.
  if (measure([...head, ...foot]) > charBudget) {
    if (opts.counters && typeof opts.counters === 'object') {
      opts.counters.digestTruncations = (opts.counters.digestTruncations || 0) + 1;
    }
    return '';
  }

  const body = [...head];
  let truncations = 0;

  for (const section of sections) {
    if (!section.lines.length) continue;

    const accepted = [];
    let stopped = false;
    for (const line of section.lines) {
      if (measure([...body, ...accepted, line, ...foot]) > charBudget) {
        stopped = true;
        break;
      }
      accepted.push(line);
    }

    if (stopped) {
      // A header with no entries under it is noise; drop the whole section.
      if (accepted.length > section.headerLines) body.push(...accepted);
      truncations += 1;
      break; // §8.2: stop adding at the first line that does not fit.
    }

    body.push(...accepted);
  }

  if (truncations > 0 && opts.counters && typeof opts.counters === 'object') {
    opts.counters.digestTruncations = (opts.counters.digestTruncations || 0) + truncations;
  }

  const lines = [...body, ...foot];
  if (measure(lines) > charBudget) return ''; // belt and braces: never overspend.
  return lines.join('\n');
}

module.exports = {
  FOOTER,
  OP_WEIGHT,
  HALF_LIFE_DAYS,
  SYMBOL_CONFIDENCE,
  isDisabled,
  heatOf,
  renderDigest,
};
