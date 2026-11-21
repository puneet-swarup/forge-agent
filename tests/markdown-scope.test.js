// tests/markdown-scope.test.js — the documentation inventory cannot drift.
//
// docs/MARKDOWN_SCOPE.md claims to list every Markdown file in the repository
// with an owner and a boundary. The previous version of that file was imported
// from another branch and was wrong in both directions at once: it listed nine
// files that do not exist and omitted one that does. Prose cannot police itself,
// so these tests do: a new Markdown file without a row fails, a row naming a
// missing file fails, and the count in the header must match the table.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'MARKDOWN_SCOPE.md');
const DOC = fs.readFileSync(DOC_PATH, 'utf8');

/** Directories that never hold project documentation. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'dist', 'build', 'out',
  '.forge-agent', '.audio-backup', 'playwright-report', 'test-results',
]);

/** Runtime artifacts: written by the agent, gitignored, never documentation. */
const GENERATED = [
  'FORGE_PLAN.md',
  'FORGE_TODO.md',
  'SESSION_CONTEXT.md',
  'SESSION_TASK.md',
  'summary.md',
];

/** Every .md file in the tree, as repository-relative forward-slash paths. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/** The section of the document between `heading` and the next `## ` heading. */
function section(heading) {
  const start = DOC.indexOf(heading);
  if (start === -1) return '';
  const next = DOC.indexOf('\n## ', start + heading.length);
  return next === -1 ? DOC.slice(start) : DOC.slice(start, next);
}

/** Backticked .md paths in the first column of a table, in order. */
function tableFiles(body) {
  const files = [];
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const first = line.split('|')[1] || '';
    const m = first.match(/`([^`]+\.md)`/);
    if (m) files.push(m[1]);
  }
  return files;
}

const trackedBody = section('## Tracked inventory');
const generatedBody = section('## Generated and ignored artifacts');
const tracked = tableFiles(trackedBody);
const generated = tableFiles(generatedBody);
const onDisk = walk(ROOT);
const documented = new Set([...tracked, ...generated]);

describe('docs/MARKDOWN_SCOPE.md — inventory', () => {
  test('the document exists and states its rules', () => {
    expect(DOC.length).toBeGreaterThan(2000);
    for (let n = 1; n <= 5; n++) {
      expect(DOC).toContain(`${n}. **`);
    }
  });

  test('every Markdown file in the tree is listed', () => {
    const missing = onDisk.filter((f) => !documented.has(f));
    expect(missing).toEqual([]);
  });

  test('every tracked file listed actually exists', () => {
    const absent = tracked.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(absent).toEqual([]);
  });

  test('the tracked table has no duplicates', () => {
    expect(new Set(tracked).size).toBe(tracked.length);
  });

  test('generated artifacts are never counted as documentation', () => {
    for (const name of GENERATED) {
      expect(generated).toContain(name);
      expect(tracked).not.toContain(name);
    }
  });

  test('the stated count matches the tracked table', () => {
    const stated = DOC.match(/Tracked Markdown files: \*\*(\d+)\*\*/);
    expect(stated).not.toBeNull();
    expect(Number(stated[1])).toBe(tracked.length);
  });

  test('the tracked count matches the files on disk, minus generated ones', () => {
    const real = onDisk.filter((f) => !GENERATED.includes(path.basename(f)));
    expect(real.length).toBe(tracked.length);
  });

  test('every row carries a purpose and a boundary', () => {
    const rows = trackedBody.split('\n').filter((l) => l.trim().startsWith('| `'));
    expect(rows.length).toBe(tracked.length);
    for (const row of rows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      expect(cells.length).toBe(3);
      expect(cells[1].length).toBeGreaterThan(20);   // purpose
      expect(cells[2].length).toBeGreaterThan(20);   // authority / boundary
    }
  });

  test('the generated table says why each artifact is not documentation', () => {
    const rows = generatedBody.split('\n').filter((l) => l.trim().startsWith('| `'));
    expect(rows.length).toBe(GENERATED.length);
    for (const row of rows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      expect(cells.length).toBe(3);
      expect(cells[2].length).toBeGreaterThan(20);
    }
  });
});

describe('docs/MARKDOWN_SCOPE.md — the canonical files it names', () => {
  test('the spawn protocol is still the single normative source', () => {
    expect(DOC).toContain('docs/SPAWN_PROTOCOL.md');
    expect(DOC.toLowerCase()).toContain('single canonical normative source');
  });

  test('reliability and the loom spec are named as canonical owners', () => {
    expect(DOC).toContain('docs/RELIABILITY.md');
    expect(DOC).toContain('src/loom_specs.md');
  });

  test('it points at the test that keeps it honest', () => {
    expect(DOC).toContain('tests/markdown-scope.test.js');
  });
});

describe('contributor test-count policy', () => {
  // The audit found three different minimums across CONTRIBUTING.md and the PR
  // template. There must be exactly one rule, and the template must defer to it.
  const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  const template = fs.readFileSync(
    path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8'
  );

  test('CONTRIBUTING states one minimum, in one place', () => {
    // Normalise wrapping: the rule is written across two lines.
    const flat = contributing.replace(/\s+/g, ' ');
    const matches = flat.match(/at least \d+ (?:focused )?tests?/gi) || [];
    expect(matches.length).toBe(1);
  });

  test('the PR template defers to CONTRIBUTING instead of inventing a number', () => {
    expect(template).toContain('CONTRIBUTING.md');
    expect(template).not.toMatch(/minimum \d+ tests/i);
  });
});
