'use strict';
// src/loom/extract/js.js — JavaScript and TypeScript symbols and imports.
//
// Spec: src/loom_specs.md §4.3. The patterns, their order and their base
// confidences are the spec's. Two details are not obvious from the table:
//
//   * `^[ \t]*` rather than `^\s*`. `\s` matches a newline, so `^\s*` under the
//     `m` flag can start a match on the previous line and report the wrong line
//     number. Every pattern here is horizontal-whitespace only for that reason.
//   * A `const` arrow gets its range from `findBlockEnd` only when the
//     declaration line actually opens a brace. `const f = () => value` has no
//     block, and scanning forward would run into the next function's braces.

const {
  countLines,
  buildLineStarts,
  lineOfIndex,
  lineText,
  precedingDoc,
  findBlockEnd,
} = require('./blocks');

const CONTROL_NAMES = /^(if|for|while|switch|catch|return|function|constructor|do|else|try|with)$/;

// Applied in this order. `block` is true (always scan), 'auto' (scan when the
// declaration line opens a brace) or false (single line).
const PATTERNS = Object.freeze([
  {
    kind: 'class',
    confidence: 0.95,
    block: 'auto',
    re: /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)/gm,
  },
  {
    kind: 'function',
    confidence: 0.95,
    block: 'auto',
    re: /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)/gm,
  },
  {
    kind: 'method',
    confidence: 0.8,
    block: true,
    exclude: CONTROL_NAMES,
    re: /^[ \t]{2,}(?:static[ \t]+)?(?:async[ \t]+)?(?:get[ \t]+|set[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*\{/gm,
  },
  {
    kind: 'const',
    confidence: 0.9,
    block: 'auto',
    re: /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>/gm,
  },
  {
    kind: 'const',
    confidence: 0.85,
    block: false,
    re: /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]{2,})[ \t]*=/gm,
  },
  {
    kind: 'type',
    confidence: 0.9,
    block: 'auto',
    re: /^[ \t]*(?:export[ \t]+)?(?:interface|type)[ \t]+([A-Za-z_$][\w$]*)/gm,
  },
]);

const IMPORT_PATTERNS = Object.freeze([
  { kind: 'require', re: /require\([ \t]*['"]([^'"]+)['"][ \t]*\)/g },
  { kind: 'import', re: /^[ \t]*import[ \t]+(?:[^'"\n]*[ \t]from[ \t]+)?['"]([^'"]+)['"]/gm },
  { kind: 'import', re: /^[ \t]*export[ \t]+[^'"\n]*[ \t]from[ \t]+['"]([^'"]+)['"]/gm },
]);

/** Names the module exports: `export …`, `module.exports = { … }`, `exports.x =`. */
function exportedNames(text) {
  const names = new Set();
  let match;

  const objectForm = /module\.exports[ \t]*=[ \t]*\{([^}]*)\}/g;
  while ((match = objectForm.exec(text))) {
    for (const part of match[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  const propertyForm = /exports\.([A-Za-z_$][\w$]*)[ \t]*=/g;
  while ((match = propertyForm.exec(text))) names.add(match[1]);

  const declarationForm = /^[ \t]*export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?(?:function|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm;
  while ((match = declarationForm.exec(text))) names.add(match[1]);

  const listForm = /^[ \t]*export[ \t]*\{([^}]*)\}/gm;
  while ((match = listForm.exec(text))) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  return names;
}

function extractImports(text) {
  const imports = [];
  const seen = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text))) {
      const specifier = match[1];
      const key = `${pattern.kind}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push({ specifier, kind: pattern.kind });
    }
  }
  return imports;
}

/**
 * @param {string} text
 * @param {string} [relPath]
 * @returns {{ symbols: object[], imports: object[], loc: number, partial: boolean }}
 */
function extract(text, relPath = '') { // eslint-disable-line no-unused-vars
  const src = String(text == null ? '' : text);
  const loc = countLines(src);
  const lineStarts = buildLineStarts(src);
  const exported = exportedNames(src);
  const symbols = [];
  const seen = new Set();
  let partial = false;

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(src))) {
      const name = match[1];
      if (!name || (pattern.exclude && pattern.exclude.test(name))) continue;

      const lineStart = lineOfIndex(lineStarts, match.index);
      const key = `${pattern.kind}:${name}:${lineStart}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const signature = lineText(src, lineStarts, lineStart).trim().slice(0, 200);
      let lineEnd = lineStart;
      let confidence = pattern.confidence;

      const wantsBlock = pattern.block === true || (pattern.block === 'auto' && signature.includes('{'));
      if (wantsBlock) {
        const block = findBlockEnd(src, lineStart, loc);
        lineEnd = Math.max(lineStart, block.line_end);
        if (block.partial) {
          confidence = Math.min(confidence, block.confidence);
          partial = true;
        }
      }

      symbols.push({
        name,
        kind: pattern.kind,
        line_start: lineStart,
        line_end: lineEnd,
        signature,
        exported: exported.has(name) || /^[ \t]*export[ \t]/.test(signature) ? 1 : 0,
        parent: '',
        doc: precedingDoc(src, lineStarts, lineStart),
        confidence,
      });
    }
  }

  // `parent` is the nearest enclosing class by line range. Classes were
  // collected first, so their spans are already known.
  const classes = symbols.filter((s) => s.kind === 'class');
  for (const symbol of symbols) {
    if (symbol.kind !== 'method') continue;
    let best = null;
    for (const klass of classes) {
      if (klass.line_start < symbol.line_start && symbol.line_start <= klass.line_end) {
        if (!best || klass.line_start > best.line_start) best = klass;
      }
    }
    if (best) symbol.parent = best.name;
  }

  symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));

  return { symbols, imports: extractImports(src), loc, partial };
}

module.exports = { extract, PATTERNS, exportedNames };
