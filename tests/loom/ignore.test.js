// tests/loom/ignore.test.js — spec §4.1: hard deny, secret deny, .gitignore.

'use strict';

const ignore = require('../../src/loom/ignore');

describe('loom/ignore hard deny', () => {
  it.each([
    'node_modules/react/index.js',
    'src/node_modules/x.js',
    '.git/config',
    'dist/bundle.js',
    'build/out.js',
    'coverage/lcov.info',
    '.next/server/page.js',
    '.nuxt/app.js',
    '__pycache__/mod.pyc',
    '.venv/lib/python3.11/site.py',
    'venv/lib/x.py',
    'target/debug/main.rs',
    'vendor/github.com/x/y.go',
    '.forge/loom/index.json',
  ])('refuses %s', (relPath) => {
    expect(ignore.shouldIgnore(relPath)).toEqual({ ignored: true, reason: 'hard-deny' });
  });

  it.each([
    'src/app.min.js',
    'src/app.js.map',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'assets/logo.png',
    'assets/doc.pdf',
    'release/app.zip',
    'fonts/inter.woff2',
    'native/addon.node.dll',
    'lib/module.so',
    'lib/x.pyc',
  ])('refuses the file type %s', (relPath) => {
    expect(ignore.shouldIgnore(relPath).ignored).toBe(true);
  });

  it('allows ordinary source files', () => {
    for (const relPath of ['src/index.js', 'src/loom/db.js', 'tests/a.test.js', 'README.md', 'docs/x.md']) {
      expect(ignore.shouldIgnore(relPath)).toEqual({ ignored: false, reason: null });
    }
  });

  it('does not treat a file that merely shares a denied directory name as denied', () => {
    // `build` as a *file* is not a directory.
    expect(ignore.shouldIgnore('scripts/build')).toEqual({ ignored: false, reason: null });
  });
});

describe('loom/ignore secret deny', () => {
  it.each([
    '.env',
    '.env.local',
    'config/.env.production',
    'certs/server.pem',
    'certs/server.key',
    'certs/keystore.p12',
    'certs/cert.pfx',
    '~/.ssh/id_rsa',
    'id_ed25519',
    'keys/id_ed25519.pub',
    'src/aws-credentials.js',
    'src/client-secret.json',
    'app.keystore',
  ])('refuses %s as a secret', (relPath) => {
    expect(ignore.shouldIgnore(relPath)).toEqual({ ignored: true, reason: 'secret' });
  });

  it('refuses anything under a secret-named directory', () => {
    expect(ignore.shouldIgnore('config/secrets/api.js').reason).toBe('secret');
  });

  it('reports the secret reason before the hard-deny reason', () => {
    // A `.pem` is both a binary-ish file and a credential; the reason a user
    // sees should be "secret", because that one cannot be overridden.
    expect(ignore.shouldIgnore('deploy/server.pem').reason).toBe('secret');
  });

  it('is not confused by a name that merely contains the word', () => {
    expect(ignore.shouldIgnore('src/secretive-notes.md').ignored).toBe(true); // *secret* matches
    expect(ignore.shouldIgnore('src/notasecretname.js').ignored).toBe(true); // still *secret*
    expect(ignore.shouldIgnore('src/notes.js').ignored).toBe(false);
  });
});

describe('loom/ignore glob matching', () => {
  it('matches a bare pattern against a basename at any depth', () => {
    expect(ignore.matchGlob('*.log', 'app.log')).toBe(true);
    expect(ignore.matchGlob('*.log', 'logs/deep/app.log')).toBe(true);
    expect(ignore.matchGlob('*.log', 'app.log.txt')).toBe(false);
  });

  it('anchors a pattern that contains a slash', () => {
    expect(ignore.matchGlob('src/*.js', 'src/a.js')).toBe(true);
    expect(ignore.matchGlob('src/*.js', 'src/deep/a.js')).toBe(false);
    expect(ignore.matchGlob('src/*.js', 'other/src/a.js')).toBe(false);
  });

  it('anchors a leading slash to the project root', () => {
    expect(ignore.matchGlob('/todo.md', 'todo.md')).toBe(true);
    expect(ignore.matchGlob('/todo.md', 'docs/todo.md')).toBe(false);
  });

  it('treats ** as any number of segments', () => {
    expect(ignore.matchGlob('**/*.min.js', 'a.min.js')).toBe(true);
    expect(ignore.matchGlob('**/*.min.js', 'src/deep/a.min.js')).toBe(true);
    expect(ignore.matchGlob('src/**/test.js', 'src/test.js')).toBe(true);
    expect(ignore.matchGlob('src/**/test.js', 'src/a/b/test.js')).toBe(true);
    expect(ignore.matchGlob('src/**/test.js', 'other/a/test.js')).toBe(false);
  });

  it('supports ? as one character', () => {
    expect(ignore.matchGlob('a?c.js', 'abc.js')).toBe(true);
    expect(ignore.matchGlob('a?c.js', 'ac.js')).toBe(false);
  });

  it('treats a trailing slash as directory-only', () => {
    expect(ignore.matchGlob('tmp/', 'tmp/a.js')).toBe(true);
    expect(ignore.matchGlob('tmp/', 'tmp')).toBe(true);
    // A pattern with no slash matches at any depth, so a nested `tmp/` counts.
    expect(ignore.matchGlob('tmp/', 'src/tmp')).toBe(true);
    expect(ignore.matchGlob('tmp/', 'tmpfile.js')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    expect(ignore.matchGlob('a+b.js', 'a+b.js')).toBe(true);
    expect(ignore.matchGlob('a+b.js', 'aab.js')).toBe(false);
    expect(ignore.matchGlob('x(1).js', 'x(1).js')).toBe(true);
  });

  it('never throws on a malformed pattern', () => {
    expect(() => ignore.matchGlob('a[b', 'a[b')).not.toThrow();
  });
});

describe('loom/ignore .gitignore rules', () => {
  const rules = ignore.parseGitignore([
    '# comment',
    '',
    '*.tmp',
    '/build-output/',
    'docs/**/draft-*.md',
    '!keep.tmp',
  ].join('\n'));

  it('parses rules and drops comments and blanks', () => {
    expect(rules).toHaveLength(4);
    expect(rules.map((r) => r.pattern)).toEqual(['*.tmp', '/build-output/', 'docs/**/draft-*.md', 'keep.tmp']);
    expect(rules[3].negate).toBe(true);
  });

  it('ignores a path the project ignores', () => {
    expect(ignore.shouldIgnore('src/scratch.tmp', rules)).toEqual({ ignored: true, reason: 'gitignore' });
  });

  it('applies the last matching rule, so a negation re-includes', () => {
    expect(ignore.shouldIgnore('keep.tmp', rules).ignored).toBe(false);
    expect(ignore.shouldIgnore('other.tmp', rules).ignored).toBe(true);
  });

  it('honours an anchored directory rule', () => {
    expect(ignore.shouldIgnore('build-output/a.js', rules).ignored).toBe(true);
    expect(ignore.shouldIgnore('src/build-output/a.js', rules).ignored).toBe(false);
  });

  it('honours a ** rule', () => {
    expect(ignore.shouldIgnore('docs/draft-1.md', rules).ignored).toBe(true);
    expect(ignore.shouldIgnore('docs/a/b/draft-2.md', rules).ignored).toBe(true);
    expect(ignore.shouldIgnore('docs/a/b/final.md', rules).ignored).toBe(false);
  });

  it('does not let a negation override a secret', () => {
    const permissive = ignore.parseGitignore('!*.key\n!.env\n');
    expect(ignore.shouldIgnore('.env', permissive)).toEqual({ ignored: true, reason: 'secret' });
    expect(ignore.shouldIgnore('server.key', permissive)).toEqual({ ignored: true, reason: 'secret' });
  });

  it('returns no rules for non-string input', () => {
    expect(ignore.parseGitignore(null)).toEqual([]);
    expect(ignore.parseGitignore(undefined)).toEqual([]);
  });
});

describe('loom/ignore.filterPaths', () => {
  it('keeps only indexable paths', () => {
    const rules = ignore.parseGitignore('*.log\n');
    expect(ignore.filterPaths(['a.js', 'b.log', 'node_modules/c.js', '.env'], rules))
      .toEqual(['a.js']);
  });
});

describe('loom/ignore.shouldIgnore edge cases', () => {
  it('refuses an empty path', () => {
    expect(ignore.shouldIgnore('').ignored).toBe(true);
    expect(ignore.shouldIgnore(null).ignored).toBe(true);
  });
});
