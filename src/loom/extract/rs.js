'use strict';
// src/loom/extract/rs.js — Rust symbols and imports.
//
// Spec: src/loom_specs.md §4.5. Two scanner options matter here and nowhere
// else: a backtick is not a template (raw strings), and `'a` is a lifetime, not
// an unterminated character literal — without that flag `&'a str` would open a
// string state and swallow the rest of the block.

const {
  countLines,
  buildLineStarts,
  lineOfIndex,
  lineText,
  precedingDoc,
  findBlockEnd,
} = require('./blocks');

const SCAN = Object.freeze({ interpolation: false, lifetimes: true });

const PATTERNS = Object.freeze([
  {
    kind: 'function',
    confidence: 0.95,
    re: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?(?:const[ \t]+)?(?:unsafe[ \t]+)?fn[ \t]+(\w+)/gm,
  },
  {
    kind: 'type',
    confidence: 0.9,
    re: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:struct|enum|trait)[ \t]+(\w+)/gm,
  },
]);

const USE_RE = /^[ \t]*(?:pub[ \t]+)?use[ \t]+([\w:]+)/gm;
const MOD_RE = /^[ \t]*(?:pub[ \t]+)?mod[ \t]+(\w+)[ \t]*[;{]/gm;

function extractImports(text) {
  const imports = [];
  const seen = new Set();
  const push = (specifier, kind) => {
    const key = `${kind}:${specifier}`;
    if (!specifier || seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, kind });
  };

  USE_RE.lastIndex = 0;
  let match;
  while ((match = USE_RE.exec(text))) push(match[1], 'use');

  MOD_RE.lastIndex = 0;
  while ((match = MOD_RE.exec(text))) push(match[1], 'mod');

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
      const block = findBlockEnd(src, lineStart, loc, SCAN);
      if (block.partial) partial = true;

      symbols.push({
        name,
        kind: pattern.kind,
        line_start: lineStart,
        line_end: Math.max(lineStart, block.line_end),
        signature,
        exported: /^[ \t]*(?:pub|export)[ \t]/.test(signature) ? 1 : 0,
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
