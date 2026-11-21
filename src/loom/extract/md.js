'use strict';
// src/loom/extract/md.js — Markdown structure.
//
// Spec: src/loom_specs.md §4.5 (headings), plus the link scan this slice was
// asked for. A Markdown file's outline *is* its digest entry: the headings say
// what it covers, and the local links say which other documents it depends on,
// which is the only edge that matters when the model asks "where is this
// documented".
//
// Fenced code blocks are skipped, so a `# comment` inside a shell example is not
// mistaken for a heading and a `[link](./x.md)` inside a snippet is not an edge.

const EXTENSIONS = Object.freeze({ '.md': 'md', '.markdown': 'md' });

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;

const HEADING_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]*(?:```|~~~)/;
const LINK_RE = /\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

/** Link targets that are not project files. */
const EXTERNAL_LINK_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Collapse whitespace and truncate at a word boundary. */
function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

function buildSummary(symbols, title) {
  if (title) return clip(title, MAX_SUMMARY);
  const headings = symbols.slice(0, 6).map((s) => s.name);
  if (headings.length > 0) return clip(`Sections: ${headings.join(', ')}.`, MAX_SUMMARY);
  return '';
}

/**
 * Extract structure from a Markdown file. Never throws.
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
  const seenLinks = new Set();
  /** Open headings, so a `##` can name its `#` as a parent. */
  const stack = [];
  let title = '';
  /** Open fence marker (``` or ~~~) while inside a code block. */
  let fence = null;

  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1] || '';
    const trimmed = line.trim();

    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (FENCE_RE.test(line)) {
      fence = trimmed.slice(0, 3);
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      const name = clip(heading[2].replace(/\s+#+$/, ''), MAX_SIGNATURE);
      if (!name) continue;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1].name : '';
      stack.push({ level, name });
      if (!title && level === 1) title = name;
      symbols.push({
        name,
        kind: 'heading',
        line_start: n,
        line_end: n,
        signature: clip(line.trim(), MAX_SIGNATURE),
        // A heading is a document's public surface: it is what a reader links to.
        exported: 1,
        parent,
        doc: '',
        confidence: 0.95,
      });
      continue;
    }

    for (const match of line.matchAll(LINK_RE)) {
      // Recorded as written: resolve.js (§4.6) decides whether `./x.md` is
      // local, so rewriting the target here would only hide its intent.
      const specifier = match[2];
      if (!specifier || EXTERNAL_LINK_RE.test(specifier)) continue;
      if (seenLinks.has(specifier)) continue;
      seenLinks.add(specifier);
      imports.push({ specifier, kind: 'import' });
    }
  }

  return {
    symbols,
    imports,
    summary: buildSummary(symbols, title),
    partial: false,
  };
}

module.exports = { id: 'md', EXTENSIONS, extract };
