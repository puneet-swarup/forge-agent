'use strict';
// src/loom/extract/sql.js — SQL structure.
//
// Spec: src/loom_specs.md §4.5. A digest does not need a schema parser: it needs
// to know which tables and views a file defines, so that "where does `orders`
// come from" is answerable without opening every migration. So that is all this
// module records — `CREATE TABLE`, `CREATE VIEW` and `CREATE MATERIALIZED VIEW`,
// with the line range of the whole statement.
//
// Spec §4.5 says SQL has no imports, and this module honours that: `REFERENCES`
// targets are table names, not file paths, and putting them in the imports table
// would create edges resolve.js can never resolve (§4.6). The tables a file
// touches are visible from the definitions it declares.

const EXTENSIONS = Object.freeze({ '.sql': 'sql' });

const MAX_SIGNATURE = 200;
const MAX_DOC = 160;
const MAX_SUMMARY = 240;
const MAX_STATEMENT_LINES = 200;

/** Spec §4.5, widened for the forms real migrations actually use. */
const CREATE_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`[\]]+)/gi;

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

/** Strip identifier quoting: `"public"."orders"` → `public.orders`. */
function unquote(name) {
  return String(name || '').replace(/["`[\]]/g, '');
}

/** Statement ends at the first `;` on its own statement, or at the cap. */
function statementEnd(lines, startLine) {
  const limit = Math.min(lines.length, startLine + MAX_STATEMENT_LINES);
  for (let n = startLine; n <= limit; n += 1) {
    if ((lines[n - 1] || '').includes(';')) return n;
  }
  return startLine;
}

/** `-- comment` block directly above the statement. */
function docBefore(lines, lineStart) {
  const collected = [];
  for (let n = lineStart - 1; n >= 1 && collected.length < 4; n -= 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') break;
    if (!text.startsWith('--')) break;
    collected.unshift(text.replace(/^-{2,}\s?/, ''));
  }
  return collected.length > 0 ? firstSentence(collected.join(' ')) : '';
}

function buildSummary(symbols, doc) {
  if (doc) return clip(doc, MAX_SUMMARY);
  const names = symbols.slice(0, 6).map((s) => s.name);
  if (names.length > 0) return clip(`Defines: ${names.join(', ')}.`, MAX_SUMMARY);
  return '';
}

/** Leading `--` header comment, the usual place for a migration's purpose. */
function leadingDoc(lines) {
  const collected = [];
  for (let n = 1; n <= Math.min(lines.length, 12); n += 1) {
    const text = (lines[n - 1] || '').trim();
    if (text === '') {
      if (collected.length > 0) break;
      continue;
    }
    if (!text.startsWith('--')) break;
    collected.push(text.replace(/^-{2,}\s?/, ''));
  }
  return collected.length > 0 ? firstSentence(collected.join(' ')) : '';
}

/**
 * Extract structure from a SQL file. Never throws.
 *
 * @param {string} text
 * @param {string} [relPath]
 * @returns {{ symbols: object[], imports: object[], summary: string, partial: boolean }}
 */
function extract(text, relPath) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const symbols = [];
  const seen = new Set();

  // Work on a copy of the text with `--` comments blanked out, so a commented
  // out `CREATE TABLE` in a migration's history does not become a symbol. The
  // line structure is preserved, so line numbers still line up.
  const scannable = lines
    .map((line) => {
      const at = line.indexOf('--');
      return at >= 0 && (line.slice(0, at).match(/'/g) || []).length % 2 === 0 ? line.slice(0, at) : line;
    })
    .join('\n');

  for (const match of scannable.matchAll(CREATE_RE)) {
    const name = unquote(match[1]);
    if (!name) continue;
    const lineStart = scannable.slice(0, match.index).split('\n').length;
    const key = `${lineStart}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push({
      name,
      // Views and materialized views are the same navigational object as a
      // table for digest purposes; the kind enum in §4.2 has no `view`.
      kind: 'table',
      line_start: lineStart,
      line_end: statementEnd(lines, lineStart),
      signature: clip((lines[lineStart - 1] || '').trim(), MAX_SIGNATURE),
      exported: 1,
      parent: '',
      doc: docBefore(lines, lineStart),
      confidence: 0.9,
    });
  }

  symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name));

  return {
    symbols,
    imports: [],
    summary: buildSummary(symbols, leadingDoc(lines)),
    partial: false,
  };
}

module.exports = { id: 'sql', EXTENSIONS, extract };
