'use strict';
// src/loom/extract/data.js — JSON, YAML and TOML structure.
//
// Spec: src/loom_specs.md §4.5, last row: *top-level keys only, no deep walk*.
// That restriction is the whole design. A `package.json` or a CI config is
// navigated by its top-level keys (`scripts`, `dependencies`, `jobs`), and a deep
// walk would turn a 40-line config into two hundred symbols that crowd the
// digest's 24-entry budget while telling the model nothing it could not infer
// from one read.
//
// The JSON scanner tracks brace depth outside of strings rather than indenting,
// because real config files are re-indented by every formatter that touches them.

const EXTENSIONS = Object.freeze({
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
});

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;

const YAML_KEY_RE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]|$)/;
const TOML_SECTION_RE = /^\[\[?([^\]\n]+)\]\]?[ \t]*$/;
const TOML_KEY_RE = /^([A-Za-z0-9_-]+)[ \t]*=/;

/** Collapse whitespace and truncate at a word boundary. */
function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** First sentence of a comment body, ≤160 chars. */
function firstSentence(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const match = text.match(/^(.*?[.!?])(\s|$)/);
  return clip(match ? match[1] : text, MAX_DOC);
}

function makeSymbol(name, lineStart, signature) {
  return {
    name,
    kind: 'key',
    line_start: lineStart,
    line_end: lineStart,
    signature: clip(signature, MAX_SIGNATURE),
    // A config file's top-level keys are its interface; nothing else in the
    // file is addressable without a deep walk, which §4.5 forbids.
    exported: 1,
    parent: '',
    doc: '',
    confidence: 0.9,
  };
}

/**
 * Top-level keys of a JSON document: strings at depth 1 followed by a colon.
 * Braces and brackets inside strings are ignored.
 */
function jsonKeys(lines) {
  const symbols = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let capture = null;

  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        else if (capture) capture.text += ch;
        continue;
      }
      if (ch === '"') {
        inString = true;
        capture = { text: '', depth, line: n };
        continue;
      }
      if (capture) {
        if (ch === ':' && capture.depth === 1) symbols.push(makeSymbol(capture.text, capture.line, line));
        capture = null;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
    }
  }
  return symbols;
}

/** Top-level keys of a YAML document: a name at column 0 followed by `:`. */
function yamlKeys(lines) {
  const symbols = [];
  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';
    if (line.trim() === '' || line.trim().startsWith('#') || line.trim() === '---') continue;
    const match = line.match(YAML_KEY_RE);
    if (match) symbols.push(makeSymbol(match[1], n, line));
  }
  return symbols;
}

/** Top-level keys and `[section]` headers of a TOML document. */
function tomlKeys(lines) {
  const symbols = [];
  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const section = trimmed.match(TOML_SECTION_RE);
    if (section) {
      symbols.push(makeSymbol(clip(section[1].trim(), MAX_SIGNATURE), n, trimmed));
      continue;
    }
    const key = line.match(TOML_KEY_RE);
    if (key) symbols.push(makeSymbol(key[1], n, line));
  }
  return symbols;
}

/** Leading `#` comment, for YAML and TOML files that document themselves. */
function leadingDoc(lines) {
  const collected = [];
  for (let n = 1; n <= Math.min(lines.length, 12); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') {
      if (collected.length > 0) break;
      continue;
    }
    if (!text.startsWith('#')) break;
    collected.push(text.replace(/^#+\s?/, ''));
  }
  return collected.length > 0 ? firstSentence(collected.join(' ')) : '';
}

function buildSummary(symbols, doc) {
  if (doc) return clip(doc, MAX_SUMMARY);
  const names = symbols.slice(0, 6).map((s) => s.name);
  if (names.length > 0) return clip(`Keys: ${names.join(', ')}.`, MAX_SUMMARY);
  return '';
}

/**
 * Extract top-level keys from a JSON, YAML or TOML file. Never throws.
 *
 * @param {string} text
 * @param {string} [relPath] decides the dialect by extension; defaults to JSON
 * @returns {{ symbols: object[], imports: object[], summary: string, partial: boolean }}
 */
function extract(text, relPath) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const ext = String(relPath || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const language = (ext && EXTENSIONS[ext[0]]) || 'json';

  let symbols;
  if (language === 'yaml') symbols = yamlKeys(lines);
  else if (language === 'toml') symbols = tomlKeys(lines);
  else symbols = jsonKeys(lines);

  return {
    symbols,
    imports: [],
    summary: buildSummary(symbols, language === 'json' ? '' : leadingDoc(lines)),
    partial: false,
  };
}

module.exports = { id: 'data', EXTENSIONS, extract };
