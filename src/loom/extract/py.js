'use strict';
// src/loom/extract/py.js — Python symbols and imports.
//
// Spec: src/loom_specs.md §4.5. Python has no braces, so a block ends at the
// first following non-blank line indented at or left of the declaration.
//
// Known limitation, recorded rather than hidden: the scan is line-based, so a
// triple-quoted string that contains a line starting at column 0 ends a block
// early, and a `#` comment at column 0 inside a function body does the same.
// The range is then short, never wrong in a way that points at another file's
// content — the digest only ever uses ranges from the same file.

const {
  countLines,
  indentOf,
  precedingHashComment,
} = require('./blocks');

const DEF_RE = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)/;
const CLASS_RE = /^([ \t]*)class[ \t]+(\w+)/;
const FROM_RE = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/;
const IMPORT_RE = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/;

/**
 * Line number of the last line of the block opened at 0-based index `index`.
 * A declaration with no body (a `def` line alone) still returns its own line.
 */
function indentationBlockEnd(lines, index, indent) {
  let last = index;
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) <= indent) return last + 1; // 1-based line of the last content line
    last = i;
  }
  return lines.length;
}

function extract(text, relPath = '') { // eslint-disable-line no-unused-vars
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const lines = src.split(/\r?\n/);
  const symbols = [];
  const imports = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;

    let match = CLASS_RE.exec(line);
    let kind = 'class';
    if (!match) {
      match = DEF_RE.exec(line);
      kind = 'function';
    }
    if (!match) continue;

    const indent = match[1].length;
    const lineStart = i + 1;
    const lineEnd = Math.max(lineStart, Math.min(indentationBlockEnd(lines, i, indent), loc || lineStart));

    symbols.push({
      name: match[2],
      kind,
      line_start: lineStart,
      line_end: lineEnd,
      signature: line.trim().slice(0, 200),
      exported: 0,
      parent: '',
      doc: precedingHashComment(src, lineStart),
      confidence: 0.95,
    });
  }

  // A `def` inside a class is a method of it.
  const classes = symbols.filter((s) => s.kind === 'class');
  for (const symbol of symbols) {
    if (symbol.kind !== 'function') continue;
    let best = null;
    for (const klass of classes) {
      if (klass.line_start < symbol.line_start && symbol.line_start <= klass.line_end) {
        if (!best || klass.line_start > best.line_start) best = klass;
      }
    }
    if (best) {
      symbol.kind = 'method';
      symbol.parent = best.name;
    }
  }

  for (const line of lines) {
    const from = FROM_RE.exec(line);
    if (from) {
      imports.push({ specifier: from[1], kind: 'from' });
      continue;
    }
    const plain = IMPORT_RE.exec(line);
    if (plain) {
      for (const part of plain[1].split(',')) {
        const specifier = part.trim();
        if (specifier) imports.push({ specifier, kind: 'import' });
      }
    }
  }

  symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));
  return { symbols, imports, loc, partial: false };
}

module.exports = { extract, indentationBlockEnd };
