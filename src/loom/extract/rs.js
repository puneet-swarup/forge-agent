'use strict';
// src/loom/extract/rs.js — Rust structure.
//
// Spec: src/loom_specs.md §4.5. Same deal as go.js: braces come from the shared
// scanner in js.js (§4.4), so `fn` bodies full of string literals and match arms
// cannot throw the ranges off.
//
// A digest needs the items a Rust file names — `fn`, `struct`, `enum`, `trait` —
// plus `use` and `mod` edges, because in Rust the module tree *is* the file
// structure. `impl` blocks are deliberately not symbols: they name no new thing,
// and their methods are already covered by the `fn` pattern.

const { findBlockEnd, buildContext } = require('./js');

const EXTENSIONS = Object.freeze({ '.rs': 'rs' });

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;

const FN_RE = /^[ \t]*(pub(?:\([^)]*\))?[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?fn[ \t]+(\w+)/;
const TYPE_RE = /^[ \t]*(pub(?:\([^)]*\))?[ \t]+)?(?:struct|enum|trait)[ \t]+(\w+)/;
const USE_RE = /^[ \t]*use[ \t]+([\w:]+)/;
const MOD_RE = /^[ \t]*mod[ \t]+(\w+)/;
const IMPL_RE = /^[ \t]*impl(?:<[^>]*>)?[ \t]+(?:[\w:<>]+\s+for\s+)?([\w]+)/;

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
 * Does this item open a brace within its own signature? Rust signatures wrap,
 * but a blank line or a new `fn`/`struct`/`impl` ends the item — which is how a
 * unit struct (`pub struct Marker;`) or a trait method declaration looks.
 */
function opensBlock(lines, lineStart) {
  for (let n = lineStart; n <= Math.min(lines.length, lineStart + 8); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (n > lineStart && text === '') return false;
    if (text.includes('{')) return true;
    if (n > lineStart && /^(pub|fn|struct|enum|trait|impl|use|mod)\b/.test(text)) return false;
  }
  return false;
}

/** `///` doc comments above the item, falling back to `//`. */
function docBefore(lines, lineStart) {
  const collected = [];
  for (let n = lineStart - 1; n >= 1 && collected.length < 4; n -= 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') break;
    if (/^(#\[|#!\[)/.test(text)) continue; // attribute: the doc sits above it
    if (text.startsWith('///') || text.startsWith('//!') || text.startsWith('//')) {
      collected.unshift(text.replace(/^\/\/[/!]?\s?/, ''));
      continue;
    }
    break;
  }
  return collected.length > 0 ? firstSentence(collected.join(' ')) : '';
}

function buildSummary(symbols, doc) {
  if (doc) return clip(doc, MAX_SUMMARY);
  const names = symbols.filter((s) => s.exported).slice(0, 6).map((s) => s.name);
  if (names.length > 0) return clip(`Defines: ${names.join(', ')}.`, MAX_SUMMARY);
  if (symbols.length > 0) return clip(`Defines: ${symbols.slice(0, 6).map((s) => s.name).join(', ')}.`, MAX_SUMMARY);
  return '';
}

/** `//! Crate docs` at the top of the file. */
function crateDoc(lines) {
  for (let n = 1; n <= Math.min(lines.length, 10); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') continue;
    if (text.startsWith('//!') || text.startsWith('///')) {
      return firstSentence(text.replace(/^\/\/[/!]?\s?/, ''));
    }
    return '';
  }
  return '';
}

/**
 * Extract structure from a Rust file. Never throws.
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

  // `impl` blocks are ranges, not symbols: they name nothing new, but they are
  // what makes `fn` items read as methods of a type. Measured once, up front.
  const impls = [];
  for (let n = 1; n <= lines.length; n += 1) {
    const match = (lines[n - 1] || '').match(IMPL_RE);
    if (!match) continue;
    impls.push({ name: match[1], start: n, end: findBlockEnd(source, n, ctx).line_end });
  }

  const parentOf = (line) => {
    let best = null;
    for (const impl of impls) {
      if (line > impl.start && line <= impl.end) {
        if (!best || impl.end - impl.start < best.end - best.start) best = impl;
      }
    }
    return best ? best.name : '';
  };

  const push = (name, kind, lineStart, visible, parent) => {
    if (!name) return;
    const range = opensBlock(lines, lineStart)
      ? findBlockEnd(source, lineStart, ctx)
      : { line_end: lineStart, closed: true };
    symbols.push({
      name,
      kind,
      line_start: lineStart,
      line_end: Math.max(lineStart, range.line_end),
      signature: clip(lines[lineStart - 1] || '', MAX_SIGNATURE),
      // Rust exports explicitly: `pub`, or `pub(crate)`/`pub(super)`.
      exported: visible ? 1 : 0,
      parent,
      doc: docBefore(lines, lineStart),
      confidence: range.closed ? (kind === 'type' ? 0.9 : 0.95) : 0.4,
    });
  };

  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';

    const fn = line.match(FN_RE);
    if (fn) {
      push(fn[2], 'function', n, Boolean(fn[1]), parentOf(n));
      continue;
    }
    const type = line.match(TYPE_RE);
    if (type) {
      push(type[2], 'type', n, Boolean(type[1]), '');
      continue;
    }

    const use = line.match(USE_RE);
    // `use crate::store::{A, B};` names one path; drop the trailing `::` the
    // pattern leaves behind so resolve.js sees a module, not a fragment.
    const used = use ? use[1].replace(/:+$/, '') : '';
    if (used && !seenImports.has(`use:${used}`)) {
      seenImports.add(`use:${used}`);
      imports.push({ specifier: used, kind: 'use' });
    }
    const mod = line.match(MOD_RE);
    if (mod && !seenImports.has(`mod:${mod[1]}`)) {
      seenImports.add(`mod:${mod[1]}`);
      imports.push({ specifier: mod[1], kind: 'mod' });
    }
  }

  return {
    symbols,
    imports,
    summary: buildSummary(symbols, crateDoc(lines)),
    partial: symbols.some((s) => s.confidence === 0.4),
  };
}

module.exports = { id: 'rs', EXTENSIONS, extract };
