'use strict';
// src/loom/extract/blocks.js — line helpers and the block-end scanner.
//
// Spec: src/loom_specs.md §4.4 ("findBlockEnd — required algorithm"). The
// scanner exists because a naive brace counter is wrong in this codebase: the
// adapter files carry selector strings containing `{` and `}`, and a counter
// that ignores strings and comments returns a line range that points at the
// wrong code. A wrong range is worse than a missing one — the digest would
// present a symbol's extent from content that is not there (invariant I3).
//
// Two outcomes are possible, and both are explicit in the return value:
//   * a balanced block — `{line_end, confidence: 0.95, partial: false}`;
//   * a block that did not close within 400 lines or before EOF —
//     `{line_end: min(start + 40, loc), confidence: 0.4, partial: true}`.
// The caller lowers the symbol's confidence and flags the file as partial, so a
// guessed range is never served as if it were measured.

/** Number of lines in `text`, ignoring a single trailing newline. */
function countLines(text) {
  const src = String(text == null ? '' : text);
  if (!src) return 0;
  let count = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') count += 1;
  }
  if (src.endsWith('\n')) count -= 1;
  return count;
}

/** Offsets at which each line starts. `lineStarts[0]` is line 1. */
function buildLineStarts(text) {
  const src = String(text == null ? '' : text);
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number of a character index. Binary search over `lineStarts`. */
function lineOfIndex(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Text of a 1-based line, without its terminator. '' when out of range. */
function lineText(text, lineStarts, line) {
  const src = String(text == null ? '' : text);
  if (!Number.isInteger(line) || line < 1 || line > lineStarts.length) return '';
  const start = lineStarts[line - 1];
  const next = line < lineStarts.length ? lineStarts[line] : src.length;
  return src.slice(start, next).replace(/\r?\n$/, '');
}

/** Leading whitespace width of a line (tabs count as one column). */
function indentOf(line) {
  const match = /^[ \t]*/.exec(String(line == null ? '' : line));
  return match ? match[0].length : 0;
}

/** Cut to `max` characters at a word boundary, adding an ellipsis. */
function truncate(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** First sentence of a prose blob, ≤160 chars. */
function firstSentence(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const stop = text.search(/\.(\s|$)/);
  const sentence = stop === -1 ? text : text.slice(0, stop + 1);
  return truncate(sentence, 160);
}

/**
 * Doc string for a declaration: the nearest preceding `/** … *\/` block or
 * `//` run, skipping blank lines. Returns '' when there is nothing within
 * `maxLines`.
 */
function precedingDoc(text, lineStarts, line, maxLines = 12) {
  const src = String(text == null ? '' : text);
  const lines = src.split(/\r?\n/);
  let i = line - 2;
  let guard = 0;
  while (i >= 0 && !lines[i].trim() && guard++ < maxLines) i -= 1;
  if (i < 0) return '';
  const trimmed = lines[i].trim();

  if (trimmed.endsWith('*/')) {
    let start = i;
    while (start >= 0 && start > i - maxLines) {
      if (lines[start].includes('/*')) break;
      start -= 1;
    }
    if (start < 0 || !lines[start].includes('/*')) return '';
    const body = lines
      .slice(start, i + 1)
      .map((row) => row.replace(/\/\*\*?/g, ' ').replace(/\*\//g, ' ').replace(/^[ \t]*\*[ \t]?/, ' '))
      .join(' ');
    return firstSentence(body);
  }

  if (trimmed.startsWith('//')) {
    const parts = [];
    let j = i;
    while (j >= 0 && parts.length < 4 && lines[j].trim().startsWith('//')) {
      parts.unshift(lines[j].trim().replace(/^\/\/+\s?/, ''));
      j -= 1;
    }
    return firstSentence(parts.join(' '));
  }

  return '';
}

/** Doc string for a language whose line comment is `#` (Python, YAML, TOML). */
function precedingHashComment(text, line, maxLines = 4) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const parts = [];
  let i = line - 2;
  while (i >= 0 && parts.length < maxLines) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (parts.length === 0) { i -= 1; continue; }
      break;
    }
    if (!trimmed.startsWith('#')) break;
    parts.unshift(trimmed.replace(/^#+\s?/, ''));
    i -= 1;
  }
  return firstSentence(parts.join(' '));
}

// Characters after which a `/` starts a regex rather than a division.
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

// Keywords after which a `/` starts a regex (`return /x/.test(s)`).
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Find the line on which the block that starts at `lineStart` closes.
 *
 * A character scanner in the states the spec names — code, single quote,
 * double quote, template, line comment, block comment — with `\` escapes in
 * every string state and `${ … }` inside a template pushing a nested code
 * state with its own depth.
 *
 * @param {string} text
 * @param {number} lineStart 1-based
 * @param {number} [loc] total lines, used to clamp the fallback
 * @param {{ interpolation?: boolean, lifetimes?: boolean, maxScanLines?: number }} [opts]
 *   `interpolation` off treats `` ` `` as a plain string (Go raw strings);
 *   `lifetimes` on keeps Rust `&'a` from opening a character literal.
 * @returns {{ line_end: number, confidence: number, partial: boolean }}
 */
function findBlockEnd(text, lineStart, loc, opts = {}) {
  const src = String(text == null ? '' : text);
  const total = Number.isFinite(loc) && loc > 0 ? loc : countLines(src);
  const start = Number.isFinite(lineStart) ? Math.max(1, Math.floor(lineStart)) : 1;
  const maxScanLines = Number.isFinite(opts.maxScanLines) ? opts.maxScanLines : 400;
  const interpolation = opts.interpolation !== false;
  const lifetimes = opts.lifetimes === true;

  const fallback = () => ({
    line_end: Math.max(start, Math.min(start + 40, total)),
    confidence: 0.4,
    partial: true,
  });

  if (!src || start > total) return fallback();

  const lineStarts = buildLineStarts(src);
  let i = lineStarts[Math.min(start, lineStarts.length) - 1] || 0;
  let line = start;
  let opened = false;
  // Each frame is one lexical context. `depth` only means something in a code
  // frame; an interpolation frame pops when its depth returns to zero.
  const frames = [{ state: 'code', depth: 0, interpolation: false, inClass: false }];

  // A `/` is a regex when what precedes it cannot end an expression, and a
  // division otherwise. Without this, `.replace(/"/g, '')` opens a string that
  // never closes, and the scan runs to EOF — the single most common way a
  // brace counter goes wrong in this repository.
  let lastChar = '';
  let lastWord = '';
  const note = (ch) => {
    if (/[A-Za-z0-9_$]/.test(ch)) {
      lastWord += ch;
      lastChar = ch;
    } else if (!/\s/.test(ch)) {
      lastWord = '';
      lastChar = ch;
    }
  };
  const regexAllowed = () => REGEX_PRECEDERS.has(lastChar) || REGEX_KEYWORDS.has(lastWord);

  while (i < src.length) {
    const frame = frames[frames.length - 1];
    const ch = src[i];

    if (ch === '\n') {
      // A line comment and a regex both end at the newline, and the newline is
      // consumed here, so the state has to be popped before the next character.
      while (frames.length > 1 && (frames[frames.length - 1].state === 'line_comment'
        || frames[frames.length - 1].state === 'regex')) frames.pop();
      line += 1;
      if (line - start > maxScanLines) return fallback();
      i += 1;
      continue;
    }

    if (frame.state === 'line_comment') {
      i += 1;
      continue;
    }

    if (frame.state === 'block_comment') {
      if (ch === '*' && src[i + 1] === '/') {
        frames.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (frame.state === 'regex') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') frame.inClass = true;
      else if (ch === ']') frame.inClass = false;
      else if (ch === '/' && !frame.inClass) {
        frames.pop();
        i += 1;
        while (i < src.length && /[a-z]/i.test(src[i])) i += 1; // flags
        note('/');
        continue;
      }
      i += 1;
      continue;
    }

    if (frame.state === 'single' || frame.state === 'double' || frame.state === 'template') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (frame.state === 'single' && ch === "'") {
        frames.pop();
        i += 1;
        note("'");
        continue;
      }
      if (frame.state === 'double' && ch === '"') {
        frames.pop();
        i += 1;
        note('"');
        continue;
      }
      if (frame.state === 'template') {
        if (ch === '`') {
          frames.pop();
          i += 1;
          note('`');
          continue;
        }
        if (interpolation && ch === '$' && src[i + 1] === '{') {
          frames.push({ state: 'code', depth: 0, interpolation: true, inClass: false });
          i += 2;
          continue;
        }
      }
      i += 1;
      continue;
    }

    // Code state.
    if (ch === '/' && src[i + 1] === '/') {
      frames.push({ state: 'line_comment', depth: 0, interpolation: false, inClass: false });
      i += 2;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      frames.push({ state: 'block_comment', depth: 0, interpolation: false, inClass: false });
      i += 2;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      frames.push({ state: 'regex', depth: 0, interpolation: false, inClass: false });
      i += 1;
      continue;
    }
    if (ch === "'") {
      // Rust lifetime: `'a`, `'_` — not a character literal.
      if (lifetimes && /[A-Za-z_]/.test(src[i + 1] || '') && src[i + 2] !== "'") {
        i += 2;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i += 1;
        note('_');
        continue;
      }
      frames.push({ state: 'single', depth: 0, interpolation: false, inClass: false });
      i += 1;
      continue;
    }
    if (ch === '"') {
      frames.push({ state: 'double', depth: 0, interpolation: false, inClass: false });
      i += 1;
      continue;
    }
    if (ch === '`') {
      frames.push({ state: 'template', depth: 0, interpolation: false, inClass: false });
      i += 1;
      continue;
    }
    if (ch === '{') {
      frame.depth += 1;
      opened = true;
      note(ch);
      i += 1;
      continue;
    }
    if (ch === '}') {
      frame.depth -= 1;
      note(ch);
      if (frame.interpolation) {
        if (frame.depth <= 0) frames.pop();
        i += 1;
        continue;
      }
      if (opened && frame.depth === 0) {
        return { line_end: line, confidence: 0.95, partial: false };
      }
      if (frame.depth < 0) frame.depth = 0;
      i += 1;
      continue;
    }
    note(ch);
    i += 1;
  }

  return fallback();
}

module.exports = {
  countLines,
  buildLineStarts,
  lineOfIndex,
  lineText,
  indentOf,
  truncate,
  firstSentence,
  precedingDoc,
  precedingHashComment,
  findBlockEnd,
};
