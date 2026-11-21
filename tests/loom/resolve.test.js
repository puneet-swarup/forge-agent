// tests/loom/resolve.test.js — spec §4.6.
//
// Import resolution is where a dependency graph is either right or quietly
// wrong: a missed local import drops an edge, a guessed one invents an edge
// that does not exist. Every case here asserts one of the two, plus the
// candidate order, which is the part the spec pins down exactly.

'use strict';

const fs = require('fs');
const path = require('path');

const resolve = require('../../src/loom/resolve');

const TREE = path.join(__dirname, 'fixtures', 'resolve');

/** An existence check backed by a set of project-relative paths. */
const fromSet = (paths) => {
  const set = new Set(paths);
  return (rel) => set.has(rel);
};

describe('loom/resolve — what counts as local', () => {
  test('relative, root-marked and absolute specifiers are local', () => {
    for (const specifier of ['./x', '../x', '.', '..', '/x', '@/x', '~/x']) {
      expect(resolve.isLocalSpecifier(specifier)).toBe(true);
    }
  });

  test('bare package names and URLs are external', () => {
    for (const specifier of ['path', 'node:fs', 'playwright', '@scope/pkg', 'lodash/fp', '']) {
      expect(resolve.isLocalSpecifier(specifier)).toBe(false);
    }
  });

  test('a non-string is external rather than a crash', () => {
    expect(resolve.isLocalSpecifier(null)).toBe(false);
    expect(resolve.isLocalSpecifier(undefined)).toBe(false);
    expect(resolve.isLocalSpecifier(42)).toBe(false);
  });

  test('root markers are stripped, a leading slash included', () => {
    expect(resolve.stripRootMarker('@/src/a.js')).toBe('src/a.js');
    expect(resolve.stripRootMarker('~/src/a.js')).toBe('src/a.js');
    expect(resolve.stripRootMarker('/src/a.js')).toBe('src/a.js');
    expect(resolve.stripRootMarker('./a.js')).toBe('./a.js');
  });
});

describe('loom/resolve — candidate order', () => {
  test('the bare path, then six extensions, then index.<ext>', () => {
    const candidates = resolve.candidatePaths('./db', 'src/loom/index.js');
    expect(candidates).toEqual([
      'src/loom/db',
      'src/loom/db.js',
      'src/loom/db.mjs',
      'src/loom/db.cjs',
      'src/loom/db.jsx',
      'src/loom/db.ts',
      'src/loom/db.tsx',
      'src/loom/db/index.js',
      'src/loom/db/index.mjs',
      'src/loom/db/index.cjs',
      'src/loom/db/index.jsx',
      'src/loom/db/index.ts',
      'src/loom/db/index.tsx',
    ]);
  });

  test('../ is applied to the importer directory', () => {
    expect(resolve.candidatePaths('../db', 'src/loom/index.js')[0]).toBe('src/db');
    expect(resolve.candidatePaths('../../lib/x', 'src/loom/deep/a.js')[0]).toBe('src/lib/x');
  });

  test('@/, ~/ and / all resolve from the project root', () => {
    expect(resolve.candidatePaths('@/src/a', 'deep/nested/b.js')[0]).toBe('src/a');
    expect(resolve.candidatePaths('~/src/a', 'deep/nested/b.js')[0]).toBe('src/a');
    expect(resolve.candidatePaths('/src/a', 'deep/nested/b.js')[0]).toBe('src/a');
  });

  test('a path that escapes the project has no candidates', () => {
    expect(resolve.candidatePaths('../../../etc/passwd', 'src/a.js')).toEqual([]);
  });

  test('an external specifier has no candidates', () => {
    expect(resolve.candidatePaths('playwright', 'src/a.js')).toEqual([]);
  });
});

describe('loom/resolve — resolveSpecifier', () => {
  test('an external specifier is reported as external with no path', () => {
    const result = resolve.resolveSpecifier('playwright', 'src/a.js', { exists: () => true });
    expect(result).toEqual({ specifier: 'playwright', resolved: null, kind: 'external', candidates: [] });
  });

  test('the first existing candidate wins', () => {
    const exists = fromSet(['src/db.js', 'src/db.ts', 'src/db/index.js']);
    expect(resolve.resolveSpecifier('./db', 'src/a.js', { exists }).resolved).toBe('src/db.js');
  });

  test('a directory with an index file resolves to the index', () => {
    const exists = fromSet(['src/lib/index.ts']);
    expect(resolve.resolveSpecifier('./lib', 'src/a.js', { exists }).resolved).toBe('src/lib/index.ts');
  });

  test('a missing file stays unresolved but reports what was tried', () => {
    const result = resolve.resolveSpecifier('./nope', 'src/a.js', { exists: () => false });
    expect(result.resolved).toBeNull();
    expect(result.kind).toBe('local');
    expect(result.candidates).toHaveLength(13);
  });

  test('an existence check that throws means "not found", not a crash', () => {
    const exists = () => { throw new Error('EACCES'); };
    expect(resolve.resolveSpecifier('./db', 'src/a.js', { exists }).resolved).toBeNull();
  });

  test('a whitespace-padded specifier is trimmed', () => {
    const exists = fromSet(['src/db.js']);
    expect(resolve.resolveSpecifier('  ./db  ', 'src/a.js', { exists }).resolved).toBe('src/db.js');
  });

  test('an escaping specifier resolves to null, never to an outside path', () => {
    const exists = () => true;
    const result = resolve.resolveSpecifier('../../../etc/passwd', 'src/a.js', { exists });
    expect(result.resolved).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});

describe('loom/resolve — against a real tree', () => {
  const opts = { root: TREE };

  test('the default existence check reads the disk', () => {
    expect(resolve.fsExists(TREE)('src/lib/util.ts')).toBe(true);
    expect(resolve.fsExists(TREE)('src/lib')).toBe(false); // a directory is not a file
    expect(resolve.fsExists(TREE)('src/nope.js')).toBe(false);
  });

  test('a directory import resolves to its index', () => {
    const result = resolve.resolveSpecifier('./lib', 'src/app.js', opts);
    expect(result.resolved).toBe('src/lib/index.js');
  });

  test('a component import resolves to the .jsx file', () => {
    expect(resolve.resolveSpecifier('./views/home', 'src/app.js', opts).resolved).toBe('src/views/home.jsx');
  });

  test('a bare package name is external', () => {
    const result = resolve.resolveSpecifier('playwright', 'src/app.js', opts);
    expect(result.kind).toBe('external');
    expect(result.resolved).toBeNull();
  });

  test('a file that does not exist is unresolved', () => {
    expect(resolve.resolveSpecifier('./missing', 'src/app.js', opts).resolved).toBeNull();
  });

  test('the fixture files exist and are not empty', () => {
    for (const rel of ['src/app.js', 'src/lib/index.js', 'src/lib/util.ts', 'src/views/home.jsx']) {
      expect(fs.statSync(path.join(TREE, rel)).size).toBeGreaterThan(0);
    }
  });
});

describe('loom/resolve — resolveImports', () => {
  test('maps every import to the row shape the table stores', () => {
    const opts = { root: TREE };
    const rows = resolve.resolveImports(
      [
        { specifier: './lib', kind: 'require' },
        { specifier: './views/home', kind: 'require' },
        { specifier: 'playwright', kind: 'require' },
      ],
      'src/app.js',
      opts,
    );
    expect(rows).toEqual([
      { specifier: './lib', resolved: 'src/lib/index.js', kind: 'require' },
      { specifier: './views/home', resolved: 'src/views/home.jsx', kind: 'require' },
      { specifier: 'playwright', resolved: null, kind: 'require' },
    ]);
  });

  test('the import kind is preserved, and defaults to "import"', () => {
    const rows = resolve.resolveImports(
      [{ specifier: './a', kind: 'from' }, { specifier: './b' }],
      'src/x.js',
      { exists: () => false },
    );
    expect(rows.map((r) => r.kind)).toEqual(['from', 'import']);
  });

  test('a non-array is an empty list, not a throw', () => {
    expect(resolve.resolveImports(null, 'src/x.js')).toEqual([]);
    expect(resolve.resolveImports(undefined, 'src/x.js')).toEqual([]);
  });

  test('a malformed entry does not break the batch', () => {
    const rows = resolve.resolveImports([null, { specifier: 'playwright', kind: 'import' }], 'src/x.js');
    expect(rows).toEqual([
      { specifier: '', resolved: null, kind: 'import' },
      { specifier: 'playwright', resolved: null, kind: 'import' },
    ]);
  });
});
