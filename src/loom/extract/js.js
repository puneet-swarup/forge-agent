'use strict';
// src/loom/extract/js.js — JavaScript / TypeScript structure.
//
// Spec: src/loom_specs.md §4.3 (patterns) and §4.4 (findBlockEnd). A digest has
// to answer three questions about a file it will not show the model: what lives
// here (symbols), what does it depend on (imports), and roughly what is it for
// (one line). That is everything this module produces — no AST, no type
// inference, no formatting opinions.
//
// Line scanning beats a parser here. A parser is a dependency Loom does not
// take (spec §0.2), and a parser that throws on one odd file costs the whole
// index (invariant I1), while a wrong line range costs one re-read — which the
// digest footer already asks for. Ranges are therefore *approximate by design*
// and every symbol carries a confidence so the digest can drop weak guesses.
//
// findBlockEnd lives in this file because it is the shared brace scanner: go.js
// and rs.js call it unchanged, and it is exported so tests can drive it with the
// cases a naive counter gets wrong — braces inside strings, template literals
// and comments (see the selector arrays in qwen-adapter.js).

const EXTENSIONS = Object.freeze({
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'ts',
});

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;
const MAX_SCAN_LINES = 400;
const FALLBACK_SPAN = 40;
const ESTIMATED_CONFIDENCE = 0.4;
const DECLARATION_LOOKAHEAD = 10;

/** Method-shaped matches that are control flow, not declarations. */
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor',
]);

/**
 * Declaration patterns, in the order spec §4.3 lists them.
 *
 * `body` says how to find the end of the declaration: `block` opens a brace
 * immediately or within a few lines, `declaration` may be a one-liner.
 */
const PATTERNS = Object.freeze([
  {
    kind: 'class',
    body: 'block',
    confidence: 0.95,
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  },
  {
    kind: 'function',
    body: 'block',
    confidence: 0.95,
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  },
  {
    kind: 'method',
    body: 'block',
    confidence: 0.80,
    re: /^[ \t]{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  },
  {
    kind: 'const',
    body: 'declaration',
    confidence: 0.90,
    re: /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
  },
  {
    kind: 'const',
    body: 'declaration',
    confidence: 0.85,
    re: /^[ \t]*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=/gm,
  },
  {
    kind: 'type',
    body: 'declaration',
    confidence: 0.90,
    re: /^[ \t]*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm,
  },
]);

/**
 * Import patterns. The fourth entry (dynamic `import('x')`) is not in §4.3 but
 * is a real dependency edge; it is recorded as `import` so the graph sees it.
 */
const IMPORT_PATTERNS = Object.freeze([
  { kind: 'require', re: /require\(\s*['"]([^'"]+)['"]\s*\)/g },
  { kind: 'import', re: /^[ \t]*import\s+(?:[^'"]*\sfrom\s+)?['"]([^'"]+)['"]/gm },
  { kind: 'import', re: /^[ \t]*export\s+[^'"]*\sfrom\s+['"]([^'"]+)['"]/gm },
  { kind: 'import', re: /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g },
]);

/* ------------------------------------------------------------------ helpers */

/** Lines plus their character offsets, so a match index maps to a line cheaply. */
function buildContext(text) {
  const lines = text.split('\n');
  const offsets = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i] = at;
    at += lines[i].length + 1;
  }
  const loc = text === '' ? 0 : lines.length - (text.endsWith('\n') ? 1 : 0);
  return { lines, offsets, loc };
}

/** 1-indexed line number containing character `index`. */
function lineAt(ctx, index) {
  const { offsets } = ctx;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Collapse whitespace and hard-truncate at a word boundary. */
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
 * Naive `//` strip, used only by the declaration-end heuristic. It can be
 * fooled by `//` inside a string, which at worst costs one line of range.
 */
function stripLineComment(line) {
  const at = line.indexOf('//');
  if (at < 0) return line;
  const before = line.slice(0, at);
  const quotes = (before.match(/['"`]/g) || []).length;
  return quotes % 2 === 0 ? before : line;
}

/* -------------------------------------------------------------- findBlockEnd */

/**
 * Find the closing line of the block that starts at `lineStart`.
 *
 * Spec §4.4. A character scanner, not a brace counter: `{` and `}` inside
 * strings, template literals and comments must not move the depth. `${` inside
 * a template pushes a nested code frame with its own depth, so
 * `` `a ${ b ? { x: 1 } : c } d` `` balances.
 *
 * @param {string} text
 * @param {number} lineStart 1-indexed
 * @param {{ lines?: string[], offsets?: number[], loc?: number }} [ctx]
 * @returns {{ line_end: number, closed: boolean }}
 *   `closed: false` means the scan gave up (EOF or 400 lines) and the caller
 *   must mark the symbol partial with confidence 0.4.
 */
function findBlockEnd(text, lineStart, ctx) {
  const source = typeof text === 'string' ? text : '';
  const context = ctx && ctx.offsets && ctx.lines ? ctx : buildContext(source);
  const start = context.offsets[Math.max(0, lineStart - 1)];
  const fallback = () => ({
    line_end: Math.min(lineStart + FALLBACK_SPAN, context.loc || lineStart),
    closed: false,
  });
  if (start === undefined) return fallback();

  /** Stack of frames: `code` carries a brace depth, `template` a literal body. */
  const frames = [{ kind: 'code', depth: 0 }];
  let seenBrace = false;
  let line = lineStart;
  // Start at the *last* brace of the declaration's first line: that is the body
  // brace. `function open(opts = {}) {` has three braces before the body and
  // `const COLUMNS = Object.freeze({` has its value brace inside a call — the
  // last one on the line is the block either way.
  const from = lastBraceOnLine(source, start, context.offsets[lineStart] === undefined
    ? source.length
    : context.offsets[lineStart] - 1);
  let i = from >= 0 ? from : start;
  const maxLine = lineStart + MAX_SCAN_LINES;

  while (i < source.length) {
    const ch = source[i];
    const top = frames[frames.length - 1];

    if (ch === '\n') {
      line += 1;
      if (line > maxLine) return fallback();
      if (top.kind === 'line_comment') frames.pop();
      i += 1;
      continue;
    }

    if (top.kind === 'line_comment') {
      i += 1;
      continue;
    }

    if (top.kind === 'block_comment') {
      if (ch === '*' && source[i + 1] === '/') {
        frames.pop();
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (top.kind === 'single' || top.kind === 'double') {
      if (ch === '\\') {
        i += 2;
      } else if ((top.kind === 'single' && ch === "'") || (top.kind === 'double' && ch === '"')) {
        frames.pop();
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    if (top.kind === 'template') {
      if (ch === '\\') {
        i += 2;
      } else if (ch === '`') {
        frames.pop();
        i += 1;
      } else if (ch === '$' && source[i + 1] === '{') {
        frames.push({ kind: 'code', depth: 0 });
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // kind === 'code'
    if (ch === '/' && source[i + 1] === '/') {
      frames.push({ kind: 'line_comment' });
      i += 2;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      frames.push({ kind: 'block_comment' });
      i += 2;
      continue;
    }
    if (ch === "'") {
      frames.push({ kind: 'single' });
      i += 1;
      continue;
    }
    if (ch === '"') {
      frames.push({ kind: 'double' });
      i += 1;
      continue;
    }
    if (ch === '`') {
      frames.push({ kind: 'template' });
      i += 1;
      continue;
    }
    if (ch === '{') {
      top.depth += 1;
      if (frames.length === 1) seenBrace = true;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (top.depth > 0) {
        top.depth -= 1;
        if (frames.length === 1 && top.depth === 0 && seenBrace) {
          return { line_end: line, closed: true };
        }
      } else if (frames.length > 1) {
        // Closing a `${ … }` expression: back to the template body.
        frames.pop();
      }
      i += 1;
      continue;
    }
    i += 1;
  }

  return fallback();
}

/**
 * Offset of the last `{` in code state between `start` and `stop` (the end of
 * that line), or -1. A `//` comment ends the search; strings are skipped.
 */
function lastBraceOnLine(source, start, stop) {
  let found = -1;
  let state = 'code';
  for (let i = start; i < stop && i < source.length; i += 1) {
    const ch = source[i];
    if (state === 'code') {
      if (ch === '/' && source[i + 1] === '/') break;
      if (ch === '/' && source[i + 1] === '*') {
        state = 'block_comment';
        i += 1;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (ch === '{') found = i;
      continue;
    }
    if (state === 'block_comment') {
      if (ch === '*' && source[i + 1] === '/') {
        state = 'code';
        i += 1;
      }
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
      state = 'code';
    }
  }
  return found;
}

/**
 * End of a declaration that may or may not open a block: `type A = string;`
 * ends on its own line, `const f = () => {` ends at its brace.
 */
function endOfDeclaration(text, lineStart, ctx) {
  const { lines } = ctx;
  const limit = Math.min(lines.length, lineStart + DECLARATION_LOOKAHEAD);
  for (let n = lineStart; n <= limit; n += 1) {
    const trimmed = stripLineComment(lines[n - 1] || '').trim();
    if (trimmed === '') {
      if (n === lineStart) continue;
      break;
    }
    if (/\{\s*$/.test(trimmed) || /\{[^}]*\}/.test(trimmed)) {
      return findBlockEnd(text, lineStart, ctx);
    }
    if (/[;}]$/.test(trimmed)) return { line_end: n, closed: true };
    if (!/[=,({[|&>:]$/.test(trimmed)) break;
  }
  return { line_end: lineStart, closed: true };
}

/* ---------------------------------------------------------------- doc string */

/** Doc comment immediately above a declaration: `/** … *\/` first, else `//`. */
function docBefore(lines, lineStart) {
  let n = lineStart - 1;
  while (n >= 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '' || /^@\w+/.test(text)) {
      n -= 1;
      continue;
    }
    if (text.endsWith('*/')) {
      const block = [];
      let m = n;
      while (m >= 1) {
        const line = (lines[m - 1] || '').trim();
        block.unshift(line);
        if (line.startsWith('/*')) break;
        m -= 1;
        if (n - m > 20) break;
      }
      const body = block
        .join(' ')
        .replace(/\/\*+/g, ' ')
        .replace(/\*+\//g, ' ')
        .replace(/(^|\s)\*+\s?/g, ' ');
      return firstSentence(body);
    }
    if (text.startsWith('*')) {
      n -= 1;
      continue;
    }
    if (text.startsWith('//')) return clip(text.replace(/^\/\/+\s?/, ''), MAX_DOC);
    return '';
  }
  return '';
}

/** Leading comment block of the file, used for the one-line summary. */
function leadingDoc(lines) {
  for (let n = 1; n <= Math.min(lines.length, 12); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '' || text.startsWith('#!') || /^['"]use strict['"];?$/.test(text)) continue;
    if (text.startsWith('/*')) {
      const block = [];
      for (let m = n; m <= Math.min(lines.length, n + 20); m += 1) {
        const line = (lines[m - 1] || '').trim();
        block.push(line);
        if (line.endsWith('*/')) break;
      }
      const body = block
        .join(' ')
        .replace(/\/\*+/g, ' ')
        .replace(/\*+\//g, ' ')
        .replace(/(^|\s)\*+\s?/g, ' ');
      return firstSentence(body);
    }
    if (text.startsWith('//')) return clip(text.replace(/^\/\/+\s?/, ''), MAX_DOC);
    return '';
  }
  return '';
}

/* ------------------------------------------------------------------- exports */

/** Names the module exports via CommonJS or a named `export { … }` list. */
function exportedNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const id = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
    }
  }
  for (const match of text.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^[ \t]*export\s*(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      // `export { local as published }` publishes `local`, which is the name a
      // declaration in this file actually has.
      const id = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
    }
  }
  return names;
}

/* ------------------------------------------------------------------ scanning */

function collectSymbols(text, ctx, exported) {
  const { lines } = ctx;
  const found = [];
  const seen = new Set();

  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      const name = match[1];
      if (!name) continue;
      if (pattern.kind === 'method' && NOT_A_METHOD.has(name)) continue;

      const lineStart = lineAt(ctx, match.index);
      const source = lines[lineStart - 1] || '';
      const key = `${lineStart}:${name}:${pattern.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const range = pattern.body === 'block'
        ? findBlockEnd(text, lineStart, ctx)
        : endOfDeclaration(text, lineStart, ctx);

      found.push({
        name,
        kind: pattern.kind,
        line_start: lineStart,
        line_end: Math.max(lineStart, range.line_end),
        signature: clip(source, MAX_SIGNATURE),
        exported: /^[ \t]*export\b/.test(source) || exported.has(name) ? 1 : 0,
        parent: '',
        doc: docBefore(lines, lineStart),
        confidence: range.closed ? pattern.confidence : ESTIMATED_CONFIDENCE,
        partial: !range.closed,
      });
    }
  }

  found.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));
  return found;
}

/** Nearest enclosing class, by line range, becomes the method's parent. */
function assignParents(symbols) {
  const classes = symbols.filter((s) => s.kind === 'class');
  if (classes.length === 0) return;
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
    if (!best) continue;
    symbol.parent = best.name;
    if (best.exported) symbol.exported = 1;
  }
}

function collectImports(text) {
  const imports = [];
  const seen = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      const specifier = match[1];
      if (!specifier) continue;
      const key = `${pattern.kind}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push({ specifier, kind: pattern.kind });
    }
  }
  return imports;
}

/** One line: the leading doc comment, else the exported surface. */
function buildSummary(symbols, doc) {
  if (doc) return clip(doc, MAX_SUMMARY);
  const exported = symbols
    .filter((s) => s.exported && s.confidence >= 0.7)
    .slice(0, 6)
    .map((s) => s.name);
  if (exported.length > 0) return clip(`Exports: ${exported.join(', ')}.`, MAX_SUMMARY);
  const declared = symbols.slice(0, 6).map((s) => s.name);
  if (declared.length > 0) return clip(`Declares: ${declared.join(', ')}.`, MAX_SUMMARY);
  return '';
}

/* --------------------------------------------------------------------- entry */

/**
 * Extract structure from a JavaScript or TypeScript file. Never throws.
 *
 * @param {string} text
 * @param {string} [relPath]
 * @returns {{ symbols: object[], imports: object[], summary: string, partial: boolean }}
 */
function extract(text, relPath) {
  const source = typeof text === 'string' ? text : '';
  const ctx = buildContext(source);
  const exported = exportedNames(source);
  const symbols = collectSymbols(source, ctx, exported);
  assignParents(symbols);

  const partial = symbols.some((s) => s.partial === true);
  for (const symbol of symbols) delete symbol.partial;

  return {
    symbols,
    imports: collectImports(source),
    summary: buildSummary(symbols, leadingDoc(ctx.lines)),
    partial,
  };
}

module.exports = {
  id: 'js',
  EXTENSIONS,
  extract,
  findBlockEnd,
  // Exposed for tests and for the other language modules that need the same
  // brace-aware scanner.
  buildContext,
  clip,
  firstSentence,
  MAX_DOC,
  MAX_SUMMARY,
};
