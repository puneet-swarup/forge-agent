// tests/ci-config.test.js — the pipeline is part of the product.
//
// These are cheap structural checks on the workflow files and the changelog
// extractor. They exist because CI configuration rots silently: a workflow that
// references a script nobody defines, or a release that publishes empty notes,
// only fails at the worst moment.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { parseSections, findSection } = require('../scripts/changelog-section');

describe('package.json gates', () => {
  const pkg = require('../package.json');

  test('coverage thresholds exist and are sane', () => {
    const g = pkg.jest.coverageThreshold.global;
    expect(g).toBeTruthy();
    for (const key of ['statements', 'branches', 'functions', 'lines']) {
      expect(typeof g[key]).toBe('number');
      expect(g[key]).toBeGreaterThan(0);
      expect(g[key]).toBeLessThanOrEqual(100);
    }
  });

  test('coverage emits a machine-readable summary for the CI step', () => {
    expect(pkg.jest.coverageReporters).toContain('json-summary');
  });

  test('every script referenced by CI exists', () => {
    const ci = read('.github/workflows/ci.yml');
    const referenced = [...ci.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]);
    for (const name of new Set(referenced)) {
      expect(pkg.scripts[name]).toBeTruthy();
    }
  });
});

describe('ci.yml', () => {
  const ci = read('.github/workflows/ci.yml');

  test('tests the supported LTS lines', () => {
    expect(ci).toMatch(/node-version:\s*\[20,\s*22,\s*24\]/);
  });

  test('runs the syntax check across every file, not a hardcoded list', () => {
    expect(ci).toContain('npm run check:syntax:all');
  });

  test('runs the suite with coverage, so the threshold is enforced', () => {
    expect(ci).toContain('npm run test:coverage');
  });

  test('a new push cancels the previous run', () => {
    expect(ci).toMatch(/cancel-in-progress:\s*true/);
  });

  test('workflows get read-only permissions by default', () => {
    expect(ci).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });
});

describe('release.yml', () => {
  const rel = read('.github/workflows/release.yml');

  test('refuses a tag that disagrees with package.json', () => {
    expect(rel).toContain('Verify tag matches package.json');
    expect(rel).toContain('exit 1');
  });

  test('notes come from the changelog, not generated merge commits', () => {
    expect(rel).toContain('scripts/changelog-section.js');
    expect(rel).toContain('body_path: release-notes.md');
    expect(rel).toMatch(/generate_release_notes:\s*false/);
  });

  test('publishing is guarded by the token, so a fork without it still releases', () => {
    expect(rel).toMatch(/if:\s*\$\{\{\s*env\.NPM_TOKEN != ''\s*\}\}/);
  });
});

describe('changelog-section', () => {
  const markdown = [
    '# Changelog',
    '',
    '## [2.2.0] - 2026-11-21',
    '',
    '### Added',
    '- a thing',
    '',
    '---',
    '',
    '## [2.1.0] - 2026-11-12',
    '',
    '- an older thing',
  ].join('\n');

  test('splits versions newest first', () => {
    const sections = parseSections(markdown);
    expect(sections.map((s) => s.version)).toEqual(['2.2.0', '2.1.0']);
  });

  test('finds a version and strips the horizontal rule', () => {
    const s = findSection(markdown, '2.2.0');
    expect(s.body).toContain('a thing');
    expect(s.body).not.toMatch(/^---$/m);
    expect(s.body).not.toContain('an older thing');
  });

  test('accepts a leading v, and defaults to the newest', () => {
    expect(findSection(markdown, 'v2.1.0').body).toContain('an older thing');
    expect(findSection(markdown).version).toBe('2.2.0');
  });

  test('returns null for a version that is not there', () => {
    expect(findSection(markdown, '9.9.9')).toBe(null);
  });

  test('the real changelog has a section for the current version', () => {
    const version = require('../package.json').version;
    const real = read('CHANGELOG.md');
    expect(findSection(real, version)).toBeTruthy();
  });
});

describe('dependabot', () => {
  const dep = read('.github/dependabot.yml');

  test('covers npm and actions', () => {
    expect(dep).toContain('package-ecosystem: npm');
    expect(dep).toContain('package-ecosystem: github-actions');
  });

  test('groups updates so they do not arrive one per package', () => {
    expect(dep).toMatch(/groups:/);
  });
});
