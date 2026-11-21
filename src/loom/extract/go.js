'use strict';
// src/loom/extract/go.js — Go symbols and imports.
//
// Spec: src/loom_specs.md §4.5. Go is brace-delimited, so `findBlockEnd` runs
// with `interpolation: false`: a backtick opens a raw string with no `${ … }`
// inside it, and treating one as an interpolation would end the scan early.

const {
  countLines,
  buildLineStarts,
  lineOfIndex,
  lineText,
  precedingDoc,
  findBlockEnd,
} = require('./blocks');

const PATTERNS = Object.freeze([
  {
    kind: 'function',
    confidence: 0.95,
    re: /^func[ \t]+(?:\([^)]*\)[ \t]*)?(\w+)/gm,
  },
  {
    kind: 'type',
    confidence: 0.9,
    re: /^type[ \t]+(\w+)/gm,
  },
]);

const SINGLE_IMPORT = /^import[ \t]+"([^"]+)"/gm;
const BLOCK_IMPORT = /^import[ \t]*\(([\s\S]*?)\)/gm;
const QUOTED = /"([^"]+)"/g;

function extractImports(text) {
  const imports = [];
  const seen = new Set();
  const push = (specifier) => {
    if (!specifier || seen.has(specifier)) return;
    seen.add(specifier);
    imports.push({ specifier, kind: 'import' });
  };

  BLOCK_IMPORT.lastIndex = 0;
  let match;
  while ((match = BLOCK_IMPORT.exec(text))) {
    QUOTED.lastIndex = 0;
    let quoted;
    while ((quoted = QUOTED.exec(match[1]))) push(quoted[1]);
  }

  SINGLE_IMPORT.lastIndex = 0;
  while ((match = SINGLE_IMPORT.exec(text))) push(match[1]);

  return imports;
}

function extract(text, relPath = '') { // eslint-disable-line no-unused-vars
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const lineStarts = buildLineStarts(src);
  const symbols = [];
  const seen = new Set();
  let partial = false;

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(src))) {
      const name = match[1];
      const lineStart = lineOfIndex(lineStarts, match.index);
      const key = `${pattern.kind}:${name}:${lineStart}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const signature = lineText(src, lineStarts, lineStart).trim().slice(0, 200);
      const block = findBlockEnd(src, lineStart, loc, { interpolation: false });
      if (block.partial) partial = true;

      symbols.push({
        name,
        kind: pattern.kind,
        line_start: lineStart,
        line_end: Math.max(lineStart, block.line_end),
        signature,
        exported: /^[A-Z]/.test(name) ? 1 : 0,
        parent: '',
        doc: precedingDoc(src, lineStarts, lineStart),
        confidence: block.partial ? Math.min(pattern.confidence, block.confidence) : pattern.confidence,
      });
    }
  }

  symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));
  return { symbols, imports: extractImports(src), loc, partial };
}

module.exports = { extract };
