'use strict';
// src/loom/extract/data.js — top-level keys of JSON, YAML and TOML.
//
// Spec: src/loom_specs.md §4.5 ("top-level keys only → key"). The point is a
// file's shape at a glance — `package.json` is `name, version, scripts, …` — not
// a full parse. So this is a line scan, not a parser: no dependency, no
// recovery problem on malformed input, and the same answer for a file that
// parses and one that does not.
//
// JSON: the keys at the smallest indentation that has any `"key":` lines.
// YAML: `key:` at column 0. TOML: `key =` at column 0, plus `[section]`
// headers, which are what a TOML file's top level usually is.

const { countLines, buildLineStarts, precedingHashComment } = require('./blocks');

const JSON_KEY = /^([ \t]*)"((?:[^"\\]|\\.)*)"[ \t]*:/;
const YAML_KEY = /^([A-Za-z0-9_$.-]+)[ \t]*:(?:[ \t]|$)/;
const TOML_KEY = /^([A-Za-z0-9_.-]+)[ \t]*=/;
const TOML_SECTION = /^[ \t]*\[([^\]]+)\][ \t]*$/;

function unquote(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch (_) {
    return raw;
  }
}

function pushKey(symbols, seen, name, line, src) {
  const key = `key:${name}:${line}`;
  if (!name || seen.has(key)) return;
  seen.add(key);
  symbols.push({
    name: String(name).slice(0, 200),
    kind: 'key',
    line_start: line,
    line_end: line,
    signature: name.slice(0, 200),
    exported: 0,
    parent: '',
    doc: precedingHashComment(src, line),
    confidence: 0.9,
  });
}

function extractJson(lines, src, symbols, seen) {
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const match = JSON_KEY.exec(lines[i]);
    if (!match) continue;
    candidates.push({ indent: match[1].length, name: unquote(match[2]), line: i + 1 });
  }
  if (!candidates.length) return;
  const minIndent = candidates.reduce((min, c) => Math.min(min, c.indent), Infinity);
  for (const candidate of candidates) {
    if (candidate.indent === minIndent) pushKey(symbols, seen, candidate.name, candidate.line, src);
  }
}

function extractYaml(lines, src, symbols, seen) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('#') || line.startsWith('-')) continue;
    const match = YAML_KEY.exec(line);
    if (!match) continue;
    pushKey(symbols, seen, match[1], i + 1, src);
  }
}

function extractToml(lines, src, symbols, seen) {
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    const section = TOML_SECTION.exec(line);
    if (section) {
      inSection = true;
      pushKey(symbols, seen, section[1].trim(), i + 1, src);
      continue;
    }
    // After the first `[section]`, a `key = value` belongs to that section and
    // is not top-level — TOML indentation does not nest, so this flag is the
    // only thing that separates the two.
    if (inSection) continue;
    const key = TOML_KEY.exec(line);
    if (key) pushKey(symbols, seen, key[1], i + 1, src);
  }
}

/**
 * @param {string} text
 * @param {string} relPath used only to pick the dialect
 * @returns {{ symbols: object[], imports: object[], loc: number, partial: boolean }}
 */
function extract(text, relPath = '') {
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const lines = src.split(/\r?\n/);
  const symbols = [];
  const seen = new Set();
  const ext = String(relPath).toLowerCase().slice(String(relPath).lastIndexOf('.'));

  if (ext === '.json') extractJson(lines, src, symbols, seen);
  else if (ext === '.yaml' || ext === '.yml') extractYaml(lines, src, symbols, seen);
  else if (ext === '.toml') extractToml(lines, src, symbols, seen);

  symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));
  return { symbols, imports: [], loc, partial: false };
}

module.exports = { extract };
