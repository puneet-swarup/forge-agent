// tests/markdown-scope.test.js — docs/MARKDOWN_SCOPE.md must stay true.
//
// The inventory is only worth having if it cannot drift. This test is the
// enforcement behind governance rule 6: every tracked Markdown file needs a row,
// every row needs a file, and the count in the header has to match reality.
//
// It deliberately reads the document as text rather than importing a data
// structure: the inventory is meant to be read by humans, and a table is the
// form that stays readable.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'MARKDOWN_SCOPE.md');

// Directories that never hold project documentation.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', '.forge', 'dist', 'build', 'out',
  '.nyc_output', '.next', '.nuxt', 'vendor', 'target',
]);

// Runtime artifacts: gitignored, written by the agent, listed in their own table.
const GENERATED = new Set([
  'FORGE_PLAN.md', 'FORGE_TODO.md', 'SESSION_CONTEXT.md', 'SESSION_TASK.md', 'summary.md',
]);

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

function section(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  if (start === -1) return '';
  const from = start + startHeading.length;
  const end = endHeading ? text.indexOf(endHeading, from) : -1;
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

/** First backticked path on every table row of a section. */
function tablePaths(markdown) {
  const paths = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const match = line.match(/^\|\s*`([^`]+)`/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

const doc = fs.readFileSync(DOC_PATH, 'utf8');
const trackedSection = section(doc, '## Repository Markdown inventory', '## Generated artifacts');
const generatedSection = section(doc, '## Generated artifacts', '## Functional overlap');

const documented = tablePaths(trackedSection);
const generatedRows = tablePaths(generatedSection);
const onDisk = walkMarkdown(ROOT).filter((rel) => !GENERATED.has(path.posix.basename(rel)));

describe('docs/MARKDOWN_SCOPE.md inventory', () => {
  it('has the sections the checks depend on', () => {
    expect(trackedSection).not.toBe('');
    expect(generatedSection).not.toBe('');
  });

  it('documents every tracked Markdown file', () => {
    const missing = onDisk.filter((rel) => !documented.includes(rel));
    expect(missing).toEqual([]);
  });

  it('has a file for every documented path', () => {
    const gone = documented.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(gone).toEqual([]);
  });

  it('does not list the same file twice', () => {
    expect(documented.length).toBe(new Set(documented).size);
  });

  it('states the correct total', () => {
    const stated = doc.match(/\*\*(\d+) tracked Markdown files\*\*/);
    expect(stated).not.toBeNull();
    expect(Number(stated[1])).toBe(onDisk.length);
    expect(documented.length).toBe(onDisk.length);
  });

  it('names the generated artifacts it excludes, without claiming they exist', () => {
    expect(generatedRows).toEqual(expect.arrayContaining([...GENERATED]));
    // A generated artifact is gitignored, so it must not be in the tracked table.
    for (const name of GENERATED) {
      expect(documented).not.toContain(name);
    }
  });

  it('keeps every documented path relative and free of backslashes', () => {
    for (const rel of documented) {
      expect(rel.startsWith('/')).toBe(false);
      expect(rel).not.toContain('\\');
      expect(rel).not.toContain('..');
    }
  });
});

describe('Markdown governance rules', () => {
  it('states the six rules, including CI enforcement', () => {
    const rules = doc.match(/^## Documentation rules$/m);
    expect(rules).not.toBeNull();
    for (let n = 1; n <= 6; n++) {
      expect(doc).toMatch(new RegExp(`^${n}\\. `, 'm'));
    }
    expect(doc).toMatch(/checked in CI/);
  });

  it('points at the test that enforces it', () => {
    expect(doc).toContain('tests/markdown-scope.test.js');
  });
});
