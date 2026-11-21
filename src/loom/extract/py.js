'use strict';
// src/loom/extract/py.js — Python structure.
//
// Spec: src/loom_specs.md §4.5. Produces what a digest needs and nothing more:
// the module's defs and classes with an approximate body range, its imports,
// and one line saying what the file is for.
//
// Python has no braces, so a block ends where the indentation drops back to the
// `def`'s own level. Two wrinkles the naive "next line at indent ≤ n" rule gets
// wrong, and which this module handles:
//
//   * blank lines inside a body do not end it;
//   * a triple-quoted string may contain lines at column 0, so the scan skips
//     anything that is still inside a docstring.
//
// Ranges stay approximate (spec §8.3 footer: always read before editing), and
// the module never throws — a file we cannot understand yields no symbols and
// the indexer keeps going.

const EXTENSIONS = Object.freeze({ '.py': 'py' });

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;
const DOCSTRING_LOOKAHEAD = 3;

const DEF_RE = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)/;
const CLASS_RE = /^([ \t]*)class[ \t]+(\w+)/;
const FROM_RE = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/;
const IMPORT_RE = /^[ \t]*import[ \t]+([\w.]+)/;
const TRIPLE_QUOTES = ['"""', "'''"];

/** Collapse whitespace and truncate at a word boundary. */
function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** First sentence of a comment or docstring body, ≤160 chars. */
function firstSentence(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const match = text.match(/^(.*?[.!?])(\s|$)/);
  return clip(match ? match[1] : text, MAX_DOC);
}

/** Visual indent, with tabs counted as four columns. */
function indentOf(line) {
  const lead = (line.match(/^[ \t]*/) || [''])[0];
  return lead.replace(/\t/g, '    ').length;
}

/**
 * Track whether a line leaves us inside a triple-quoted string.
 * @param {string} line
 * @param {string|null} state open delimiter, or null
 * @returns {string|null}
 */
function stringState(line, state) {
  if (state) return line.includes(state) ? null : state;
  for (const delim of TRIPLE_QUOTES) {
    const at = line.indexOf(delim);
    if (at < 0) continue;
    return line.slice(at + 3).includes(delim) ? null : delim;
  }
  return null;
}

/**
 * Last line of the block that starts at `startLine` with `indent`.
 * Spec §4.5: first subsequent non-blank line whose indent is ≤ the def's.
 * Trailing blank lines are not part of the block, so the range ends at the last
 * line that actually had content.
 */
function blockEnd(lines, startLine, indent) {
  let state = null;
  let last = startLine;
  for (let n = startLine + 1; n <= lines.length; n += 1) {
    const raw = lines[n - 1] || '';
    const wasInside = state !== null;
    state = stringState(raw, state);
    if (wasInside) continue;
    if (raw.trim() === '') continue;
    if (indentOf(raw) <= indent) return Math.max(startLine, last);
    last = n;
  }
  return Math.max(startLine, last);
}

/** Docstring from the body, else the `#` comment above the declaration. */
function docFor(lines, startLine, endLine) {
  const stop = Math.min(endLine, startLine + DOCSTRING_LOOKAHEAD);
  for (let n = startLine + 1; n <= stop; n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') continue;
    const match = text.match(/^("""|''')([\s\S]*)$/);
    if (!match) break;
    const delim = match[1];
    let body = match[2];
    if (body.includes(delim)) {
      body = body.slice(0, body.indexOf(delim));
    } else {
      for (let k = n + 1; k <= Math.min(endLine, n + 10); k += 1) {
        const line = lines[k - 1] || '';
        if (line.includes(delim)) {
          body += ` ${line.slice(0, line.indexOf(delim))}`;
          break;
        }
        body += ` ${line}`;
      }
    }
    return firstSentence(body);
  }

  const collected = [];
  for (let n = startLine - 1; n >= 1 && collected.length < 3; n -= 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') break;
    if (text.startsWith('@')) continue; // decorator: the comment is above it
    if (!text.startsWith('#')) break;
    collected.unshift(text.replace(/^#+\s?/, ''));
  }
  return collected.length > 0 ? firstSentence(collected.join(' ')) : '';
}

/** Module docstring, for the one-line summary. */
function moduleDoc(lines) {
  for (let n = 1; n <= Math.min(lines.length, 12); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '' || text.startsWith('#!') || text.startsWith('#')) continue;
    const match = text.match(/^("""|''')([\s\S]*)$/);
    if (!match) return '';
    const delim = match[1];
    let body = match[2];
    if (body.includes(delim)) return firstSentence(body.slice(0, body.indexOf(delim)));
    for (let k = n + 1; k <= Math.min(lines.length, n + 10); k += 1) {
      const line = lines[k - 1] || '';
      if (line.includes(delim)) {
        body += ` ${line.slice(0, line.indexOf(delim))}`;
        return firstSentence(body);
      }
      body += ` ${line}`;
    }
    return firstSentence(body);
  }
  return '';
}

/** One line: the module docstring, else the public surface. */
function buildSummary(symbols, doc) {
  if (doc) return clip(doc, MAX_SUMMARY);
  const names = symbols.filter((s) => s.exported).slice(0, 6).map((s) => s.name);
  if (names.length > 0) return clip(`Defines: ${names.join(', ')}.`, MAX_SUMMARY);
  if (symbols.length > 0) return clip(`Defines: ${symbols.slice(0, 6).map((s) => s.name).join(', ')}.`, MAX_SUMMARY);
  return '';
}

/**
 * Extract structure from a Python file. Never throws.
 *
 * @param {string} text
 * @param {string} [relPath]
 * @returns {{ symbols: object[], imports: object[], summary: string, partial: boolean }}
 */
function extract(text, relPath) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const symbols = [];
  const imports = [];
  const seenImports = new Set();

  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';

    const def = line.match(DEF_RE);
    const cls = def ? null : line.match(CLASS_RE);
    const match = def || cls;
    if (match) {
      const indent = indentOf(match[1] || '');
      const name = match[2];
      const end = blockEnd(lines, n, indent);
      symbols.push({
        name,
        kind: def ? 'function' : 'class',
        line_start: n,
        line_end: end,
        signature: clip(line.trim(), MAX_SIGNATURE),
        // Python has no export keyword: a public name is one without the
        // conventional leading underscore.
        exported: name.startsWith('_') ? 0 : 1,
        parent: '',
        doc: docFor(lines, n, end),
        confidence: 0.95,
      });
    }

    const from = line.match(FROM_RE);
    if (from && !seenImports.has(`from:${from[1]}`)) {
      seenImports.add(`from:${from[1]}`);
      imports.push({ specifier: from[1], kind: 'from' });
    }
    const plain = line.match(IMPORT_RE);
    if (plain && !seenImports.has(`import:${plain[1]}`)) {
      seenImports.add(`import:${plain[1]}`);
      imports.push({ specifier: plain[1], kind: 'import' });
    }
  }

  // Classes own their methods: set the parent from the line ranges we just
  // measured, innermost class wins.
  const classes = symbols.filter((s) => s.kind === 'class');
  for (const symbol of symbols) {
    if (symbol.kind === 'class') continue;
    let best = null;
    for (const candidate of classes) {
      if (symbol.line_start > candidate.line_start && symbol.line_start <= candidate.line_end) {
        if (!best || candidate.line_end - candidate.line_start < best.line_end - best.line_start) {
          best = candidate;
        }
      }
    }
    if (best) symbol.parent = best.name;
  }

  return {
    symbols,
    imports,
    summary: buildSummary(symbols, moduleDoc(lines)),
    partial: false,
  };
}

module.exports = { id: 'py', EXTENSIONS, extract };
