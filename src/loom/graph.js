'use strict';
// src/loom/graph.js — the dependency graph.
//
// Spec: src/loom_specs.md §4.6 (import resolution), §5.6 (role drift reads the
// import table this graph describes), §7 (entry-point detection) and §8 (the
// digest is rendered from it).
//
// The graph is *derived*, never stored: it is rebuilt from extract output plus
// the resolve module, so there is exactly one place that decides what an edge
// is. Two rules carry the whole design:
//
//   * an edge exists only when a local specifier resolves to a file that is in
//     the node set. A specifier that does not resolve is counted in
//     `unresolved`, never guessed into an edge — a wrong edge invents a
//     dependency the code does not have, and every consumer downstream
//     (heat, the digest, role drift) inherits the lie.
//   * existence is answered by the node set, not the disk (`opts.exists`
//     overrides). That keeps this module pure and synchronous, so it can be
//     rebuilt against a file list in a test without fixtures, and so invariant
//     I1 has nothing to catch from `fs`.
//
// Invariants held here:
//   I1 — every public function is wrapped; an internal error returns an empty
//        graph. Nothing throws into a caller.
//   I2 — `LOOM_ENABLED=0` returns an empty graph before any work, no I/O.
//   I6 — paths are normalised through paths.normalizeRel: project-relative,
//        forward slashes only, `..` refused.
//
// Everything iterated is sorted, so the same input yields a byte-identical
// graph: nodes by path, edges by (from, to, specifier, kind), unresolved by
// (from, specifier), cycles by their first member.

const log = require('./log');
const paths = require('./paths');
const resolveMod = require('./resolve');

/** §7: `^(src/)?(cli|index|main|app)\.[jt]sx?$`. */
const ENTRY_PATTERN = /^(?:src\/)?(?:cli|index|main|app)\.[jt]sx?$/;

/** Fields of a symbol the graph guarantees, mirroring extract/index.js. */
const SYMBOL_DEFAULTS = Object.freeze({
  kind: 'const',
  signature: '',
  parent: '',
  doc: '',
  confidence: 0.6,
});

/** Lexicographic compare, locale-free so it is identical on every machine. */
function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareStringLists(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareStrings(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

/**
 * I2 kill switch. Read from the environment directly rather than through
 * config.js: the whole point of the switch is that it costs one string compare
 * and touches nothing, including the config parser's warn-once cache.
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
 * The neutral value: a graph with nothing in it. Callers can iterate it
 * without a null check, which is what makes I1 cheap to hold.
 *
 * @returns {{ nodes: object[], edges: object[], unresolved: object[],
 *             cycles: string[][], entries: string[], cyclic: boolean,
 *             stats: object }}
 */
function emptyGraph() {
  return {
    nodes: [],
    edges: [],
    unresolved: [],
    cycles: [],
    entries: [],
    declaredEntries: [],
    cyclic: false,
    stats: { files: 0, edges: 0, unresolved: 0, external: 0, partial: 0, cycles: 0 },
  };
}

/** One symbol with every field present and in range. */
function normalizeSymbol(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const lineStart = Number.isFinite(raw.line_start) ? Math.max(1, Math.trunc(raw.line_start)) : 1;
  const lineEnd = Number.isFinite(raw.line_end) ? Math.max(lineStart, Math.trunc(raw.line_end)) : lineStart;
  const confidence = Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : SYMBOL_DEFAULTS.confidence;

  return {
    name,
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : SYMBOL_DEFAULTS.kind,
    line_start: lineStart,
    line_end: lineEnd,
    signature: typeof raw.signature === 'string' ? raw.signature : SYMBOL_DEFAULTS.signature,
    exported: raw.exported ? 1 : 0,
    parent: typeof raw.parent === 'string' ? raw.parent : SYMBOL_DEFAULTS.parent,
    doc: typeof raw.doc === 'string' ? raw.doc : SYMBOL_DEFAULTS.doc,
    confidence,
  };
}

/** An import in either extract shape (`{specifier, kind}`) or bare string. */
function normalizeImportEntry(entry) {
  if (typeof entry === 'string') {
    const specifier = entry.trim();
    return specifier ? { specifier, kind: 'import', resolved: null } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const specifier = typeof entry.specifier === 'string' ? entry.specifier.trim() : '';
  if (!specifier) return null;
  return {
    specifier,
    kind: typeof entry.kind === 'string' && entry.kind ? entry.kind : 'import',
    resolved: typeof entry.resolved === 'string' && entry.resolved ? entry.resolved : null,
  };
}

/**
 * Files → nodes, keyed by normalised path. A path that cannot be expressed
 * project-relative is dropped (I6); a duplicate keeps the first, because the
 * first is the one the caller indexed.
 *
 * @param {Array<object>} files
 * @returns {Map<string, object>}
 */
function collectNodes(files) {
  const byPath = new Map();
  for (const raw of Array.isArray(files) ? files : []) {
    if (!raw || typeof raw !== 'object') continue;
    const rel = paths.normalizeRel(raw.path);
    if (!rel || byPath.has(rel)) continue;

    const symbols = (Array.isArray(raw.symbols) ? raw.symbols : [])
      .map(normalizeSymbol)
      .filter(Boolean)
      .sort((a, b) => a.line_start - b.line_start || compareStrings(a.name, b.name));

    byPath.set(rel, {
      path: rel,
      lang: typeof raw.lang === 'string' ? raw.lang : null,
      loc: Number.isFinite(raw.loc) ? Math.max(0, Math.trunc(raw.loc)) : 0,
      partial: raw.partial === true,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      symbols,
      // Sorted, because the node is part of the graph's JSON shape and the
      // graph must not depend on the order the caller happened to collect
      // imports in (determinism).
      imports: (Array.isArray(raw.imports) ? raw.imports : [])
        .map(normalizeImportEntry)
        .filter(Boolean)
        .sort((a, b) => compareStrings(a.specifier, b.specifier)
          || compareStrings(a.kind, b.kind)
          || compareStrings(a.resolved || '', b.resolved || '')),
      inDegree: 0,
      outDegree: 0,
      entry: false,
    });
  }
  return byPath;
}

/**
 * Resolve one import to a node path, or explain why it did not.
 *
 * `declared` (an already-resolved path, as the imports table stores it) wins
 * when it names a file we know about; otherwise the specifier goes through
 * resolve.js. A local specifier that reaches neither is unresolved — not
 * external, not invented.
 *
 * @returns {{ path: string|null, local: boolean }}
 */
function resolveOne(entry, fromPath, byPath, exists) {
  const declared = entry.resolved ? paths.normalizeRel(entry.resolved) : null;
  if (declared && byPath.has(declared)) return { path: declared, local: true };

  if (!resolveMod.isLocalSpecifier(entry.specifier)) return { path: null, local: false };

  let probe = null;
  try {
    probe = resolveMod.resolveSpecifier(entry.specifier, fromPath, { exists });
  } catch (_) {
    probe = null; // a resolver that throws resolved nothing.
  }
  const found = probe && probe.resolved ? paths.normalizeRel(probe.resolved) : null;
  if (found && byPath.has(found)) return { path: found, local: true };
  return { path: null, local: true };
}

/** Strings from a package.json `main` / `bin` / `exports`, in a stable order. */
function packageTargets(pkg) {
  const out = [];
  if (!pkg) return out;

  let obj = pkg;
  if (typeof pkg === 'string') {
    try {
      obj = JSON.parse(pkg);
    } catch (_) {
      return out;
    }
  }
  if (!obj || typeof obj !== 'object') return out;

  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  };
  const walk = (value) => {
    if (typeof value === 'string') push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) walk(value[key]);
    }
  };

  push(obj.main);
  if (typeof obj.bin === 'string') push(obj.bin);
  else if (obj.bin && typeof obj.bin === 'object') {
    for (const key of Object.keys(obj.bin).sort()) push(obj.bin[key]);
  }
  walk(obj.exports);
  return out;
}

/**
 * A package.json target (`./src/index.js`, `src/index`) as a node path, trying
 * the same extension order resolve.js uses.
 *
 * @returns {string|null}
 */
function targetToNodePath(target, byPath) {
  const stripped = String(target).trim().replace(/^\.\//, '').replace(/^\/+/, '');
  const direct = paths.normalizeRel(stripped);
  if (!direct) return null;
  if (byPath.has(direct)) return direct;
  for (const ext of resolveMod.EXTENSIONS) {
    const candidate = paths.normalizeRel(`${direct}${ext}`);
    if (candidate && byPath.has(candidate)) return candidate;
  }
  for (const ext of resolveMod.EXTENSIONS) {
    const candidate = paths.normalizeRel(`${direct}/index${ext}`);
    if (candidate && byPath.has(candidate)) return candidate;
  }
  return null;
}

/**
 * §7 entry points, all four rules:
 *   1. explicit `opts.entries`,
 *   2. package.json main / bin / exports targets,
 *   3. `^(src/)?(cli|index|main|app)\.[jt]sx?$`,
 *   4. zero importers with at least one local import.
 *
 * Rules 1-3 are *declared*: somebody said this file starts the program. Rule 4
 * is *inferred*, and on a repository full of leaf scripts and test files it
 * matches a lot of them — correctly, per the spec, but not usefully as a
 * headline. So both sets are returned: `entries` is the full §7 answer, and
 * `declared` is the subset the digest leads with.
 *
 * Rule 4 is applied after degrees are known, so it is the caller's job to have
 * computed them.
 *
 * @returns {{ declared: Set<string>, entries: Set<string> }}
 */
function detectEntries(nodes, byPath, opts) {
  const declared = new Set();

  for (const node of nodes) {
    if (ENTRY_PATTERN.test(node.path)) declared.add(node.path);
  }
  for (const raw of Array.isArray(opts.entries) ? opts.entries : []) {
    const rel = paths.normalizeRel(raw);
    if (rel && byPath.has(rel)) declared.add(rel);
  }
  for (const target of packageTargets(opts.packageJson)) {
    const rel = targetToNodePath(target, byPath);
    if (rel) declared.add(rel);
  }

  const entries = new Set(declared);
  for (const node of nodes) {
    if (node.inDegree === 0 && node.outDegree >= 1) entries.add(node.path);
  }

  return { declared, entries };
}

/**
 * Strongly connected components of size >= 2, by Tarjan's algorithm, written
 * iteratively so a deep import chain cannot overflow the stack.
 *
 * A component is reported as one sorted path list rather than as every simple
 * cycle: enumerating simple cycles is exponential, and the report is for a
 * human (or the digest), not for a solver.
 *
 * @param {string[]} nodePaths sorted
 * @param {Map<string, string[]>} adjacency sorted per node
 * @returns {string[][]}
 */
function findCycles(nodePaths, adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  for (const start of nodePaths) {
    if (index.has(start)) continue;

    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    const work = [{ v: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.v) || [];

      if (frame.i < neighbours.length) {
        const next = neighbours[frame.i];
        frame.i += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ v: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(next)));
        }
        continue;
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(frame.v)));
      }

      if (low.get(frame.v) === index.get(frame.v)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.v);
        if (component.length > 1) components.push(component.sort(compareStrings));
      }
    }
  }

  return components.sort(compareStringLists);
}

/**
 * The graph, built for real. Throws on a bug; the exported `buildGraph` is the
 * only caller and catches.
 *
 * @param {Array<object>} files
 * @param {object} opts
 * @returns {object}
 */
function buildGraphUnsafe(files, opts) {
  const byPath = collectNodes(files);
  const exists = typeof opts.exists === 'function' ? opts.exists : (rel) => byPath.has(rel);

  const edges = [];
  const unresolved = [];
  const edgeKeys = new Set();
  const outTargets = new Map();
  const inSources = new Map();
  let external = 0;

  for (const node of [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path))) {
    for (const entry of node.imports) {
      const resolved = resolveOne(entry, node.path, byPath, exists);
      if (resolved.path) {
        if (resolved.path === node.path) continue; // a self-import is not an edge.
        const key = `${node.path}\u0000${resolved.path}\u0000${entry.specifier}\u0000${entry.kind}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from: node.path, to: resolved.path, specifier: entry.specifier, kind: entry.kind });

        if (!outTargets.has(node.path)) outTargets.set(node.path, new Set());
        outTargets.get(node.path).add(resolved.path);
        if (!inSources.has(resolved.path)) inSources.set(resolved.path, new Set());
        inSources.get(resolved.path).add(node.path);
      } else if (resolved.local) {
        unresolved.push({ from: node.path, specifier: entry.specifier, kind: entry.kind });
      } else {
        external += 1;
      }
    }
  }

  edges.sort((a, b) => compareStrings(a.from, b.from)
    || compareStrings(a.to, b.to)
    || compareStrings(a.specifier, b.specifier)
    || compareStrings(a.kind, b.kind));
  unresolved.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.specifier, b.specifier));

  const nodes = [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path));
  for (const node of nodes) {
    node.outDegree = (outTargets.get(node.path) || new Set()).size;
    node.inDegree = (inSources.get(node.path) || new Set()).size;
  }

  const { declared, entries } = detectEntries(nodes, byPath, opts);
  for (const node of nodes) node.entry = entries.has(node.path);

  const adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node.path, [...(outTargets.get(node.path) || new Set())].sort(compareStrings));
  }
  const cycles = findCycles(nodes.map((n) => n.path), adjacency);

  return {
    nodes,
    edges,
    unresolved,
    cycles,
    entries: [...entries].sort(compareStrings),
    declaredEntries: [...declared].sort(compareStrings),
    cyclic: cycles.length > 0,
    stats: {
      files: nodes.length,
      edges: edges.length,
      unresolved: unresolved.length,
      external,
      partial: nodes.filter((n) => n.partial).length,
      cycles: cycles.length,
    },
  };
}

/**
 * Build the dependency graph from extract output.
 *
 * @param {Array<{ path: string, lang?: string, loc?: number, symbols?: object[],
 *                 imports?: Array<object|string>, summary?: string,
 *                 partial?: boolean }>} files
 * @param {{ env?: object, exists?: (rel: string) => boolean,
 *           entries?: string[], packageJson?: object|string }} [opts]
 *   `exists` replaces the node-set existence check (default: membership in
 *   `files`); `entries` and `packageJson` add entry points to the §7 rules.
 * @returns {{ nodes: object[], edges: object[], unresolved: object[],
 *             cycles: string[][], entries: string[], declaredEntries: string[],
 *             cyclic: boolean, stats: object }} an empty graph on any internal
 *   error (I1). `entries` is the full §7 set; `declaredEntries` is the subset
 *   that was declared rather than inferred (see detectEntries).
 */
function buildGraph(files, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (isDisabled(options.env)) return emptyGraph();
  try {
    return buildGraphUnsafe(files, options);
  } catch (err) {
    log.debug(`buildGraph failed: ${(err && err.message) || err}`);
    return emptyGraph();
  }
}

/** A node by path, or null. */
function nodeOf(graph, relPath) {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  const rel = paths.normalizeRel(relPath);
  if (!rel) return null;
  return graph.nodes.find((node) => node && node.path === rel) || null;
}

/**
 * Files this one imports, directly. Sorted, de-duplicated, project-relative.
 *
 * @param {object} graph
 * @param {string} relPath
 * @returns {string[]}
 */
function dependenciesOf(graph, relPath) {
  try {
    const rel = paths.normalizeRel(relPath);
    if (!rel || !graph || !Array.isArray(graph.edges)) return [];
    const targets = new Set();
    for (const edge of graph.edges) {
      if (edge && edge.from === rel && typeof edge.to === 'string') targets.add(edge.to);
    }
    return [...targets].sort(compareStrings);
  } catch (err) {
    log.debug(`dependenciesOf failed: ${(err && err.message) || err}`);
    return [];
  }
}

/**
 * Files that import this one, directly. Sorted, de-duplicated.
 *
 * @param {object} graph
 * @param {string} relPath
 * @returns {string[]}
 */
function dependentsOf(graph, relPath) {
  try {
    const rel = paths.normalizeRel(relPath);
    if (!rel || !graph || !Array.isArray(graph.edges)) return [];
    const sources = new Set();
    for (const edge of graph.edges) {
      if (edge && edge.to === rel && typeof edge.from === 'string') sources.add(edge.from);
    }
    return [...sources].sort(compareStrings);
  } catch (err) {
    log.debug(`dependentsOf failed: ${(err && err.message) || err}`);
    return [];
  }
}

/**
 * §7 entry points, as recorded when the graph was built. Sorted.
 *
 * @param {object} graph
 * @returns {string[]}
 */
function entryPoints(graph) {
  try {
    if (!graph || !Array.isArray(graph.entries)) return [];
    return graph.entries.filter((p) => typeof p === 'string').slice().sort(compareStrings);
  } catch (err) {
    log.debug(`entryPoints failed: ${(err && err.message) || err}`);
    return [];
  }
}

/**
 * Cyclic groups, one sorted path list per strongly connected component.
 * Reports; never throws. Recomputes from `edges` when the graph did not carry
 * a `cycles` list.
 *
 * @param {object} graph
 * @returns {string[][]}
 */
function cycles(graph) {
  try {
    if (!graph || typeof graph !== 'object') return [];
    if (Array.isArray(graph.cycles)) {
      return graph.cycles
        .filter((group) => Array.isArray(group))
        .map((group) => group.filter((p) => typeof p === 'string').slice().sort(compareStrings))
        .filter((group) => group.length > 1)
        .sort(compareStringLists);
    }
    if (!Array.isArray(graph.edges)) return [];

    const adjacency = new Map();
    const nodePaths = new Set();
    for (const edge of graph.edges) {
      if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
      nodePaths.add(edge.from);
      nodePaths.add(edge.to);
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
      adjacency.get(edge.from).add(edge.to);
    }
    const sorted = [...nodePaths].sort(compareStrings);
    const sortedAdjacency = new Map();
    for (const key of sorted) {
      sortedAdjacency.set(key, [...(adjacency.get(key) || new Set())].sort(compareStrings));
    }
    return findCycles(sorted, sortedAdjacency);
  } catch (err) {
    log.debug(`cycles failed: ${(err && err.message) || err}`);
    return [];
  }
}

module.exports = {
  ENTRY_PATTERN,
  isDisabled,
  emptyGraph,
  buildGraph,
  nodeOf,
  dependenciesOf,
  dependentsOf,
  entryPoints,
  cycles,
};
