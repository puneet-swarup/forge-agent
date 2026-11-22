// tests/loom/query.test.js — recall and whats_here over a real index.
//
// These are the questions an agent asks after the digest has oriented it: where
// is this defined, what is in this file, who imports it. Before them, the answer
// was "read the file" — which costs a tool call and a chunk of context for a
// question the index can answer in one line.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { recall, whatsHere, formatRecall, formatWhatsHere, scoreName } = require('../../src/loom/query');

/** Build a real index over a temporary project, then query it. */
function withIndex(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-query-'));

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const loom = require('../../src/loom/index');
  const refresh = require('../../src/loom/refresh');
  const config = require('../../src/config');
  const previous = config.LOOM_ENABLED;

  try {
    config.LOOM_ENABLED = true;
    loom.open({ root: dir, forceJson: true });
    const db = loom.db();
    refresh.refresh({ db, root: dir });
    return fn(db, dir);
  } finally {
    config.LOOM_ENABLED = previous;
    try { loom.close(); } catch (_) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PROJECT = {
  'src/auth.js': [
    "const crypto = require('crypto');",
    'function hashPassword(password) { return crypto.createHash("sha256").update(password).digest("hex"); }',
    'function verifyPassword(password, hash) { return hashPassword(password) === hash; }',
    'module.exports = { hashPassword, verifyPassword };',
  ].join('\n'),
  'src/user.js': [
    "const { hashPassword } = require('./auth');",
    'class User { constructor(name) { this.name = name; } }',
    'function createUser(name, password) { return new User(name); }',
    'module.exports = { User, createUser };',
  ].join('\n'),
};

describe('scoreName', () => {
  test('exact beats prefix beats substring', () => {
    expect(scoreName('hashPassword', 'hashPassword')).toBeGreaterThan(scoreName('hashPassword', 'hash'));
    expect(scoreName('hashPassword', 'hash')).toBeGreaterThan(scoreName('hashPassword', 'Password'));
  });

  test('a subsequence still matches, weakly', () => {
    expect(scoreName('renderToPage', 'rtp')).toBeGreaterThan(0);
    expect(scoreName('renderToPage', 'rtp')).toBeLessThan(scoreName('renderToPage', 'render'));
  });

  test('an unrelated query scores zero', () => {
    expect(scoreName('hashPassword', 'zzz')).toBe(0);
  });

  test('case and separators do not matter', () => {
    expect(scoreName('hash_password', 'HASHPASSWORD')).toBe(100);
    expect(scoreName('src/loom/query.js', 'loomquery')).toBeGreaterThan(0);
  });

  test('empty input scores zero rather than throwing', () => {
    expect(scoreName('', 'x')).toBe(0);
    expect(scoreName('x', '')).toBe(0);
  });
});

describe('recall', () => {
  test('finds a function by name with its file and line', () => {
    withIndex(PROJECT, (db) => {
      const result = recall(db, 'hashPassword');
      const hit = result.results.find((r) => r.kind === 'symbol' && r.name === 'hashPassword');

      expect(hit).toBeTruthy();
      expect(hit.path).toBe('src/auth.js');
      expect(hit.line).toBe(2);
      expect(hit.exported).toBe(true);
    });
  });

  test('finds a file by partial path', () => {
    withIndex(PROJECT, (db) => {
      const paths = recall(db, 'auth').results.filter((r) => r.kind === 'file').map((r) => r.path);
      expect(paths).toContain('src/auth.js');
    });
  });

  test('exported_only filters unexported symbols', () => {
    withIndex(PROJECT, (db) => {
      const all = recall(db, 'hashPassword').results;
      const exported = recall(db, 'hashPassword', { exportedOnly: true }).results;
      expect(exported.length).toBeLessThanOrEqual(all.length);
      expect(exported.every((r) => r.kind !== 'symbol' || r.exported)).toBe(true);
    });
  });

  test('limit caps the rows but reports the true total', () => {
    withIndex(PROJECT, (db) => {
      const result = recall(db, 'a', { limit: 2 });
      expect(result.results.length).toBeLessThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(result.results.length);
    });
  });

  test('no match is an empty result, not an error', () => {
    withIndex(PROJECT, (db) => {
      const result = recall(db, 'nothingLikeThisExists');
      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(formatRecall(result)).toMatch(/No match/);
    });
  });

  test('a null db or empty query returns empty rather than throwing', () => {
    expect(recall(null, 'x').results).toEqual([]);
    expect(recall({}, '').results).toEqual([]);
  });
});

describe('whats_here', () => {
  test('reports purpose, symbols, imports and dependents', () => {
    withIndex(PROJECT, (db) => {
      const info = whatsHere(db, 'src/auth.js');

      expect(info.path).toBe('src/auth.js');
      expect(info.symbols.map((s) => s.name)).toEqual(
        expect.arrayContaining(['hashPassword', 'verifyPassword']));

      // src/user.js imports ./auth, so auth's dependents must include it.
      expect(info.dependents).toContain('src/user.js');
    });
  });

  test('reports the imports of the file itself', () => {
    withIndex(PROJECT, (db) => {
      const info = whatsHere(db, 'src/user.js');
      expect(info.imports.map((i) => i.specifier)).toContain('./auth');
      expect(info.imports[0].resolved).toBe('src/auth.js');
    });
  });

  test('accepts a leading ./ and backslashes', () => {
    withIndex(PROJECT, (db) => {
      expect(whatsHere(db, './src/auth.js').path).toBe('src/auth.js');
      expect(whatsHere(db, 'src\\auth.js').path).toBe('src/auth.js');
    });
  });

  test('an unknown file returns null and formats as a sentence', () => {
    withIndex(PROJECT, (db) => {
      expect(whatsHere(db, 'src/nope.js')).toBeNull();
      expect(formatWhatsHere(null, 'src/nope.js')).toMatch(/not in the index/);
    });
  });

  test('null arguments do not throw', () => {
    expect(whatsHere(null, 'x')).toBeNull();
    expect(whatsHere({}, '')).toBeNull();
  });
});

describe('the agent-facing tools', () => {
  const config = require('../../src/config');

  test('recall and whats_here are registered tools', () => {
    const { TOOLS } = require('../../src/tools');
    expect(TOOLS.recall).toBeTruthy();
    expect(TOOLS.whats_here).toBeTruthy();
    expect(TOOLS.recall.parameters.query.required).toBe(true);
    expect(TOOLS.whats_here.parameters.path.required).toBe(true);
  });

  test('both reject empty input instead of guessing', async () => {
    const { executeTool } = require('../../src/tools');
    await expect(executeTool('recall', { query: '  ' })).rejects.toThrow(/non-empty query/);
    await expect(executeTool('whats_here', { path: '' })).rejects.toThrow(/requires a path/);
  });

  test('with Loom off, the tool explains itself instead of failing', async () => {
    const previous = config.LOOM_ENABLED;
    config.LOOM_ENABLED = false;
    try {
      const { executeTool } = require('../../src/tools');
      const result = await executeTool('recall', { query: 'anything' });
      expect(result.result).toMatch(/disabled for this run/);
    } finally {
      config.LOOM_ENABLED = previous;
    }
  });
});
