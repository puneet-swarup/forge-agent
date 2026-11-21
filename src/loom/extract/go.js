'use strict';
// src/loom/extract/go.js — Go structure.
//
// Spec: src/loom_specs.md §4.5. Go is brace-delimited, so ranges come from the
// shared scanner in js.js (§4.4) rather than a second state machine — that
// scanner already ignores braces inside strings, runes and comments, which is
// exactly the failure mode of a Go file full of regex literals and struct tags.
//
// What a digest needs from a Go file: the funcs and methods it declares (with
// the receiver as the parent, so `Server.handle` reads as one thing), the types
// it names, and what it imports. Nothing about packages, generics or interfaces
// beyond their names — a name and a line range is enough to decide whether to
// read the file.

const { findBlockEnd, buildContext } = require('./js');

const EXTENSIONS = Object.freeze({ '.go': 'go' });

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;

const FUNC_RE = /^func[ \t]+(?:\(([^)]*)\)[ \t]*)?(\w+)/;
const TYPE_RE = /^type[ \t]+(\w+)/;
const TYPE_GROUP_RE = /^type[ \t]*\([ \t]*$/;
const GROUP_ITEM_RE = /^[ \t]+(\w+)[ \t]+(struct|interface|map|\[|func|chan|\*|int|string|bool|float|complex|byte|rune|uint|error)/;
const IMPORT_LINE_RE = /^import[ \t]+(?:[\w.]+[ \t]+)?["`]([^"`]+)["`]/;
const IMPORT_BLOCK_RE = /^import[ \t]*\([ \t]*$/;
const IMPORT_SPEC_RE = /["`]([^"`]+)["`]/;

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

/**
 * Does this declaration open a brace within its own signature?
 * Go signatures may wrap over several lines, but a blank line or the next
 * top-level keyword always means the declaration ended without a body
 * (`func Foo()` assembly stubs, `type Foo int`).
 */
function opensBlock(lines, lineStart) {
  for (let n = lineStart; n <= Math.min(lines.length, lineStart + 6); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (n > lineStart && text === '') return false;
    if (text.includes('{')) return true;
    if (n > lineStart && /^(func|type|var|const|import)\b/.test(text)) return false;
  }
  return false;
}

/** Go doc comments sit directly above the declaration, as `//` lines. */
function docBefore(lines, lineStart) {
  const collected = [];
  for (let n = lineStart - 1; n >= 1 && collected.length < 4; n -= 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') break;
    if (text.startsWith('//')) {
      collected.unshift(text.replace(/^\/\/+\s?/, ''));
      continue;
    }
    if (text.startsWith('/*')) {
      collected.unshift(text.replace(/^\/\*+/, '').replace(/\*+\/$/, ''));
    }
    break;
  }
  return collected.length > 0 ? firstSentence(collected.join(' ')) : '';
}

/** `(s *Server)` → `Server`. */
function receiverType(receiver) {
  const names = String(receiver || '').match(/[A-Za-z_]\w*/g) || [];
  return names.length > 0 ? names[names.length - 1] : '';
}

function buildSummary(symbols, doc) {
  if (doc) return clip(doc, MAX_SUMMARY);
  const names = symbols.filter((s) => s.exported).slice(0, 6).map((s) => s.name);
  if (names.length > 0) return clip(`Defines: ${names.join(', ')}.`, MAX_SUMMARY);
  if (symbols.length > 0) return clip(`Defines: ${symbols.slice(0, 6).map((s) => s.name).join(', ')}.`, MAX_SUMMARY);
  return '';
}

/** `// Package loom does X.` at the top of the file. */
function packageDoc(lines) {
  for (let n = 1; n <= Math.min(lines.length, 10); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') continue;
    if (text.startsWith('//')) return firstSentence(text.replace(/^\/\/+\s?/, ''));
    return '';
  }
  return '';
}

/**
 * Extract structure from a Go file. Never throws.
 *
 * @param {string} text
 * @param {string} [relPath]
 * @returns {{ symbols: object[], imports: object[], summary: string, partial: boolean }}
 */
function extract(text, relPath) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const ctx = buildContext(source);
  const symbols = [];
  const imports = [];
  const seenImports = new Set();

  const push = (name, kind, lineStart, parent, singleLine) => {
    if (!name) return;
    // An entry inside a `type ( … )` group is one line by construction, so it
    // must not borrow the brace of the next entry in the group.
    const range = singleLine || !opensBlock(lines, lineStart)
      ? { line_end: lineStart, closed: true }
      : findBlockEnd(source, lineStart, ctx);
    symbols.push({
      name,
      kind,
      line_start: lineStart,
      line_end: Math.max(lineStart, range.line_end),
      signature: clip(lines[lineStart - 1] || '', MAX_SIGNATURE),
      // Go's export rule is spelling: an upper-case initial is exported.
      exported: /^[A-Z]/.test(name) ? 1 : 0,
      parent,
      doc: docBefore(lines, lineStart),
      confidence: range.closed ? (kind === 'type' ? 0.9 : 0.95) : 0.4,
    });
  };

  let inImportBlock = false;
  let inTypeGroup = false;

  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';
    const trimmed = line.trim();

    if (inImportBlock) {
      if (trimmed === ')') {
        inImportBlock = false;
      } else {
        const spec = line.match(IMPORT_SPEC_RE);
        if (spec && !seenImports.has(spec[1])) {
          seenImports.add(spec[1]);
          imports.push({ specifier: spec[1], kind: 'import' });
        }
      }
      continue;
    }
    if (inTypeGroup) {
      if (trimmed === ')') inTypeGroup = false;
      else {
        const item = line.match(GROUP_ITEM_RE);
        if (item) push(item[1], 'type', n, '', true);
      }
      continue;
    }

    const single = line.match(IMPORT_LINE_RE);
    if (single) {
      if (!seenImports.has(single[1])) {
        seenImports.add(single[1]);
        imports.push({ specifier: single[1], kind: 'import' });
      }
      continue;
    }
    if (IMPORT_BLOCK_RE.test(line)) {
      inImportBlock = true;
      continue;
    }
    if (TYPE_GROUP_RE.test(line)) {
      inTypeGroup = true;
      continue;
    }

    const fn = line.match(FUNC_RE);
    if (fn) {
      // A receiver makes it a method; the receiver type is its parent.
      push(fn[2], fn[1] ? 'method' : 'function', n, fn[1] ? receiverType(fn[1]) : '');
      continue;
    }
    const type = line.match(TYPE_RE);
    if (type) push(type[1], 'type', n, '');
  }

  return {
    symbols,
    imports,
    summary: buildSummary(symbols, packageDoc(lines)),
    partial: symbols.some((s) => s.confidence === 0.4),
  };
}

module.exports = { id: 'go', EXTENSIONS, extract };
