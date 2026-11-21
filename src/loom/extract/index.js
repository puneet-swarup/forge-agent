'use strict';
// src/loom/extract/index.js — the extractor registry.
//
// Spec: src/loom_specs.md §4.2. One entry point for the indexer, one contract
// for every language module:
//
//   extract(text, relPath) → { symbols, imports, summary, loc, partial }
//
// The modules are pure: text in, structure out. No fs, no network, no child
// process, no module state. That is what keeps them unit-testable and what makes
// invariant I1 cheap to hold — a Loom failure can only ever cost an index entry,
// never a tool call. This file is the second half of that promise: everything
// here is wrapped, and a module that throws yields an empty result rather than
// an exception.
//
// `detect` answers "which language is this?" from the extension alone. The text
// argument exists for the one case an extension cannot cover — an executable
// with a shebang and no suffix — and nothing else: guessing a language from
// content would make indexing depend on content we have already decided not to
// parse twice.
//
// `summary` is additive to §4.2: it is a one-line heuristic purpose
// (summarize.js §6.1 consumes it as the `primaryClause`), so the digest can say
// something useful about a file before any model summarisation exists.

const js = require('./js');
const py = require('./py');
const go = require('./go');
const rs = require('./rs');
const sql = require('./sql');
const md = require('./md');
const data = require('./data');

/** The one line every module must produce; §4.2. */
const KINDS = Object.freeze(['function', 'class', 'method', 'const', 'type', 'export', 'heading', 'table', 'key']);
const IMPORT_KINDS = Object.freeze(['require', 'import', 'from', 'use', 'mod']);

const MODULES = Object.freeze([js, py, go, rs, sql, md, data]);

/** extension → language, and language → module, built once at load. */
const BY_EXTENSION = new Map();
const MODULE_FOR_LANGUAGE = new Map();
for (const module of MODULES) {
  MODULE_FOR_LANGUAGE.set(module.id, module);
  for (const [ext, language] of Object.entries(module.EXTENSIONS)) {
    BY_EXTENSION.set(ext, language);
    MODULE_FOR_LANGUAGE.set(language, module);
  }
}

const SUPPORTED_EXTENSIONS = Object.freeze([...BY_EXTENSION.keys()].sort());

/** Lower-case extension including the dot, or `''` when there is none. */
function extensionOf(relPath) {
  const base = String(relPath || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  // A leading dot is a hidden file (`.gitignore`), not an extension.
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** `#!` line of a suffix-less executable. */
function sniff(text) {
  const first = String(text || '').split('\n', 1)[0] || '';
  if (!first.startsWith('#!')) return null;
  if (/\bnode\b/.test(first)) return 'js';
  if (/\bpython[0-9.]*\b/.test(first)) return 'py';
  return null;
}

/** Line count, counting a trailing newline as a terminator rather than a line. */
function countLoc(text) {
  const source = typeof text === 'string' ? text : '';
  if (source === '') return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

/**
 * Which language is this file?
 *
 * @param {string} text
 * @param {string} relPath
 * @returns {string|null} one of `js ts py go rs sql md json yaml toml`, or null
 */
function detect(text, relPath) {
  try {
    const ext = extensionOf(relPath);
    if (ext !== '') return BY_EXTENSION.get(ext) || null;
    return sniff(text);
  } catch (_) {
    return null;
  }
}

/** A symbol with every field of §4.2 present and in range. */
function normalizeSymbol(raw) {
  const lineStart = Number.isFinite(raw.line_start) ? Math.max(1, Math.trunc(raw.line_start)) : 1;
  const lineEnd = Number.isFinite(raw.line_end) ? Math.max(lineStart, Math.trunc(raw.line_end)) : lineStart;
  const confidence = Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.6;
  return {
    name: String(raw.name),
    kind: KINDS.includes(raw.kind) ? raw.kind : 'const',
    line_start: lineStart,
    line_end: lineEnd,
    signature: String(raw.signature || ''),
    exported: raw.exported ? 1 : 0,
    parent: String(raw.parent || ''),
    doc: String(raw.doc || ''),
    confidence,
  };
}

function normalizeImport(raw) {
  const specifier = String(raw.specifier || '');
  if (specifier === '') return null;
  return {
    specifier,
    kind: IMPORT_KINDS.includes(raw.kind) ? raw.kind : 'import',
  };
}

function normalizeResult(out, lang, loc) {
  const symbols = Array.isArray(out.symbols)
    ? out.symbols.filter((s) => s && s.name).map(normalizeSymbol)
    : [];
  const imports = Array.isArray(out.imports)
    ? out.imports.map(normalizeImport).filter(Boolean)
    : [];
  return {
    lang,
    symbols,
    imports,
    summary: String(out.summary || ''),
    loc,
    partial: out.partial === true,
  };
}

/** The neutral answer: no language, no structure, and the line count we can still trust. */
function emptyResult(lang, loc, partial) {
  return { lang, symbols: [], imports: [], summary: '', loc, partial: partial === true };
}

/**
 * Extract structure from a file's text. Never throws.
 *
 * @param {string} text
 * @param {string} relPath project-relative, forward slashes (spec I6)
 * @returns {{ lang: string|null, symbols: object[], imports: object[],
 *             summary: string, loc: number, partial: boolean }}
 */
function extract(text, relPath) {
  const source = typeof text === 'string' ? text : '';
  const loc = countLoc(source);
  let lang = null;
  try {
    lang = detect(source, relPath);
    if (!lang) return emptyResult(null, loc, false);
    const module = MODULE_FOR_LANGUAGE.get(lang);
    if (!module) return emptyResult(lang, loc, false);
    return normalizeResult(module.extract(source, relPath) || {}, lang, loc);
  } catch (_) {
    // A module that throws is a bug, not a user-facing failure: degrade to "no
    // structure", flag the result partial, and let the indexer carry on.
    return emptyResult(lang, loc, true);
  }
}

module.exports = {
  detect,
  extract,
  countLoc,
  SUPPORTED_EXTENSIONS,
  KINDS,
  IMPORT_KINDS,
};
