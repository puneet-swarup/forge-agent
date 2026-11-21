'use strict';
// src/loom/extract/md.js — Markdown headings.
//
// Spec: src/loom_specs.md §4.5. Levels 1-3 only: a document's outline is its
// chapter structure, and a level-4 heading is usually a list item in disguise.
// A heading has no body range, so `line_end` equals `line_start`.

const { countLines, buildLineStarts, lineOfIndex } = require('./blocks');

const HEADING_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

function extract(text, relPath = '') { // eslint-disable-line no-unused-vars
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const lineStarts = buildLineStarts(src);
  const symbols = [];

  HEADING_RE.lastIndex = 0;
  let match;
  while ((match = HEADING_RE.exec(src))) {
    const name = match[2].trim();
    if (!name) continue;
    const line = lineOfIndex(lineStarts, match.index);
    symbols.push({
      name: name.slice(0, 200),
      kind: 'heading',
      line_start: line,
      line_end: line,
      signature: `${match[1]} ${name}`.slice(0, 200),
      exported: 0,
      parent: '',
      doc: '',
      confidence: 0.95,
    });
  }

  return { symbols, imports: [], loc, partial: false };
}

module.exports = { extract };
