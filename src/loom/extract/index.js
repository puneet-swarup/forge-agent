'use strict';
// src/loom/extract/index.js — the extractor registry.
//
// Spec: src/loom_specs.md §4.2 and §4.5. One entry point, `extract(text,
// relPath)`, dispatching on extension. Three properties are contractual:
//
//   * it never throws (invariant I1). A parser bug on one weird file must not
//     take down a tool handler; the file is returned as `partial` instead and
//     `parseErrors` counts it upstream.
//   * an unregistered extension is not an error — it returns `supported: false`
//     and the caller stores the row with `parse_state='skipped'`.
//   * lines are 1-indexed and inclusive, `loc` counts the file's lines.

const { countLines } = require('./blocks');

const js = require('./js');
const py = require('./py');
const go = require('./go');
const rs = require('./rs');
const sql = require('./sql');
const md = require('./md');
const data = require('./data');

/** extension → { lang, module } */
const REGISTRY = Object.freeze({
  '.js': { lang: 'javascript', module: js },
  '.mjs': { lang: 'javascript', module: js },
  '.cjs': { lang: 'javascript', module: js },
  '.jsx': { lang: 'javascript', module: js },
  '.ts': { lang: 'typescript', module: js },
  '.tsx': { lang: 'typescript', module: js },
  '.py': { lang: 'python', module: py },
  '.go': { lang: 'go', module: go },
  '.rs': { lang: 'rust', module: rs },
  '.sql': { lang: 'sql', module: sql },
  '.md': { lang: 'markdown', module: md },
  '.json': { lang: 'json', module: data },
  '.yaml': { lang: 'yaml', module: data },
  '.yml': { lang: 'yaml', module: data },
  '.toml': { lang: 'toml', module: data },
});

/** Lower-cased extension of a relative path, including the dot; '' if none. */
function extensionOf(relPath) {
  const base = String(relPath == null ? '' : relPath).split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

/** Registry entry for a path, or null when the extension is not indexed. */
function extractorFor(relPath) {
  return REGISTRY[extensionOf(relPath)] || null;
}

/** Language name stored in `files.lang`, or null when unsupported. */
function langFor(relPath) {
  const entry = extractorFor(relPath);
  return entry ? entry.lang : null;
}

/** Is this a file whose structure Loom knows how to read? */
function isSupported(relPath) {
  return Boolean(extractorFor(relPath));
}

/** Every extension the registry handles, sorted. */
function supportedExtensions() {
  return Object.keys(REGISTRY).sort();
}

function emptyResult(loc, lang, extra) {
  return { symbols: [], imports: [], loc, partial: false, lang, supported: Boolean(lang), ...extra };
}

/**
 * Extract symbols and imports from one file's text.
 *
 * @param {string} text
 * @param {string} relPath
 * @returns {{ symbols: object[], imports: object[], loc: number,
 *             partial: boolean, lang: string|null, supported: boolean,
 *             error?: string }}
 */
function extract(text, relPath) {
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const entry = extractorFor(relPath);

  if (!entry) return emptyResult(loc, null, { supported: false });

  try {
    const result = entry.module.extract(src, relPath) || {};
    return {
      symbols: Array.isArray(result.symbols) ? result.symbols : [],
      imports: Array.isArray(result.imports) ? result.imports : [],
      loc: Number.isFinite(result.loc) ? result.loc : loc,
      partial: result.partial === true,
      lang: entry.lang,
      supported: true,
    };
  } catch (err) {
    // I1: a parser failure is a property of the file, not of the run.
    return emptyResult(loc, entry.lang, { partial: true, error: err && err.message });
  }
}

module.exports = {
  REGISTRY,
  extensionOf,
  extractorFor,
  langFor,
  isSupported,
  supportedExtensions,
  extract,
};
