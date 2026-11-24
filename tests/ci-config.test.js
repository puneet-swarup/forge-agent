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
    // Spelled out rather than via `npm run test:coverage` so the log can be
    // teed to a file — a cancelled job publishes no logs, and a stall leaves
    // nothing to read.
    expect(ci).toMatch(/npx jest --coverage --runInBand/);
  });

  test('the test log survives cancellation', () => {
    expect(ci).toContain('tee jest-output.log');
    expect(ci).toMatch(/name: Upload test log \(always\)[\s\S]{0,120}if: always\(\)/);
  });

  test('the workflow is valid YAML', () => {
    // A duplicated key makes GitHub reject the whole file and every job fails
    // before it starts — "This run likely failed because of a workflow file
    // issue" — which looks like a CI failure and is a typo.
    const yaml = require('js-yaml');
    expect(() => yaml.load(ci)).not.toThrow();
  });

  test('the suite that hangs in CI is isolated, not deleted', () => {
    // It passes locally and hangs in CI; until the cause is known it runs in its
    // own job, so 164 suites are not blocked by one and the failure stays red
    // rather than being quietly dropped.
    expect(ci).toContain('--testPathIgnorePatterns=process-manager.test.js');
    expect(ci).toMatch(/name: Process manager \(known hang, quarantined\)/);
    expect(ci).toMatch(/process-manager:[\s\S]{0,600}continue-on-error: true/);
    expect(ci).toMatch(/timeout 240 npx jest[\s\S]{0,120}tests\/process-manager\.test\.js/);
  });

  test('a killed test run fails the step, not passes it', () => {
    // `timeout … | tee` returns tee's status, so a hang killed at the limit
    // reported success. pipefail is the difference between CI telling the truth
    // and CI hiding a hang.
    expect(ci).toContain('set -o pipefail');
  });

  test('the workflow keeps its name', () => {
    expect(ci).toMatch(/^name: CI$/m);
  });

  test('a new push cancels the previous run', () => {
    expect(ci).toMatch(/cancel-in-progress:\s*true/);
  });

  test('workflows get read-only permissions by default', () => {
    expect(ci).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  test('every job has a timeout, so a stall fails instead of blocking merges', () => {
    // A hung test job sat "in progress" for 20+ minutes on a 4-minute suite and
    // held every merge behind it. A cap turns that into a fast, visible failure.
    // Count jobs by their `runs-on` line, and require a timeout near each one.
    const blocks = ci.split('runs-on:').slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      expect(block.slice(0, 300)).toMatch(/timeout-minutes:\s*\d+/);
    }
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
