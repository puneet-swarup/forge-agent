'use strict';
// src/loom/extract/sql.js — SQL tables and views.
//
// Spec: src/loom_specs.md §4.5. SQL has no braces worth scanning, so the range
// runs from the CREATE line to the line that closes the statement (`;`), capped
// at 40 lines. A CREATE without a terminator before the cap gets the cap, and
// the symbol's confidence is lowered rather than claiming a measured range.

const {
  countLines,
  buildLineStarts,
  lineOfIndex,
  lineText,
  precedingDoc,
} = require('./blocks');

const CREATE_RE = /^[ \t]*CREATE[ \t]+(?:OR[ \t]+REPLACE[ \t]+)?(?:TEMP(?:ORARY)?[ \t]+)?(?:TABLE|VIEW|MATERIALIZED[ \t]+VIEW)[ \t]+(?:IF[ \t]+NOT[ \t]+EXISTS[ \t]+)?([\w."]+)/gim;
const MAX_STATEMENT_LINES = 40;

function extract(text, relPath = '') { // eslint-disable-line no-unused-vars
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const lineStarts = buildLineStarts(src);
  const lines = src.split(/\r?\n/);
  const symbols = [];
  const seen = new Set();
  let partial = false;

  CREATE_RE.lastIndex = 0;
  let match;
  while ((match = CREATE_RE.exec(src))) {
    const name = match[1].replace(/"/g, '');
    const lineStart = lineOfIndex(lineStarts, match.index);
    const key = `table:${name}:${lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let lineEnd = lineStart;
    let terminated = false;
    for (let i = lineStart - 1; i < lines.length && i < lineStart - 1 + MAX_STATEMENT_LINES; i++) {
      lineEnd = i + 1;
      if (lines[i].includes(';')) {
        terminated = true;
        break;
      }
    }
    if (!terminated) partial = true;

    symbols.push({
      name,
      kind: 'table',
      line_start: lineStart,
      line_end: Math.max(lineStart, Math.min(lineEnd, loc || lineStart)),
      signature: lineText(src, lineStarts, lineStart).trim().slice(0, 200),
      exported: 0,
      parent: '',
      doc: precedingDoc(src, lineStarts, lineStart),
      confidence: terminated ? 0.9 : 0.4,
    });
  }

  symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));
  return { symbols, imports: [], loc, partial };
}

module.exports = { extract };
