// tests/loom/graph.test.js — spec §5.6 and §16.1 (`graph.test.js`):
// "importers_sig stable under reorder; changes when an importer is added".
//
// The graph is exercised against the JSON store unconditionally (the path most
// users run on Node 20) and against SQLite where the runtime provides
// `node:sqlite`, because `imports` rows are keyed only by `file_id` and a
// backend that silently de-duplicated them would pass on one and fail on the
// other.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dbmod = require('../../src/loom/db');
const graph = require('../../src/loom/graph');

function sqliteAvailable() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    probe.close();
    return true;
  } catch (_) {
    return false;
  }
}

const HAS_SQLITE = sqliteAvailable();
const BACKENDS = HAS_SQLITE ? ['json', 'sqlite'] : ['json'];

let tmp;
let storeFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-graph-'));
  storeFile = path.join(tmp, 'index.db');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A live file row with the fields the graph reads. */
function fileRow(relPath, extra = {}) {
  return {
    rel_path: relPath,
    lang: 'js',
    bytes: 100,
    mtime_ms: 1000,
    content_sha: `sha-${relPath}`,
    loc: 10,
    indexed_at: 1,
    parse_state: 'ok',
    importers_sig: '',
    deleted: 0,
    ...extra,
  };
}

function openStore(backend) {
  const handle = dbmod.open(storeFile, { forceJson: backend === 'json' });
  expect(handle.kind).toBe(backend);
  return handle;
}

/** files, then edges given as `importer -> resolved`. */
function seed(db, files, edges) {
  const ids = new Map();
  for (const relPath of files) ids.set(relPath, db.insert('files', fileRow(relPath)));
  for (const [importer, resolved] of edges) {
    db.insert('imports', { file_id: ids.get(importer), specifier: resolved, resolved, kind: 'import' });
  }
  return ids;
}

describe.each(BACKENDS)('loom/graph signature (§5.6) [%s]', (backend) => {
  it('is 16 hex characters, and a fixed point of the empty list', () => {
    expect(graph.SIG_LENGTH).toBe(16);
    expect(graph.EMPTY_SIG).toMatch(/^[0-9a-f]{16}$/);
    expect(graph.signatureOf([])).toBe(graph.EMPTY_SIG);
  });

  it('does not depend on the order of the importer list', () => {
    const a = graph.signatureOf(['src/b.js', 'src/a.js', 'src/c.js']);
    const b = graph.signatureOf(['src/c.js', 'src/a.js', 'src/b.js']);
    expect(a).toBe(b);
  });

  it('does not depend on duplicates', () => {
    expect(graph.signatureOf(['src/a.js', 'src/a.js'])).toBe(graph.signatureOf(['src/a.js']));
  });

  it('changes when one importer is added', () => {
    const before = graph.signatureOf(['src/a.js', 'src/b.js']);
    const after = graph.signatureOf(['src/a.js', 'src/b.js', 'src/c.js']);
    expect(after).not.toBe(before);
  });

  it('differs from the empty signature as soon as anyone imports the file', () => {
    expect(graph.signatureOf(['src/a.js'])).not.toBe(graph.EMPTY_SIG);
  });

  it('keeps importers_sig stable when the imports table is re-ordered', () => {
    const db = openStore(backend);
    try {
      seed(
        db,
        ['src/a.js', 'src/b.js', 'src/target.js'],
        [['src/a.js', 'src/target.js'], ['src/b.js', 'src/target.js']],
      );
      graph.rebuildGraph(db);
      const first = db.where('files', { rel_path: 'src/target.js' })[0].importers_sig;

      // Rewrite both edges in the opposite order, as a re-index could.
      const a = db.where('files', { rel_path: 'src/a.js' })[0].id;
      const b = db.where('files', { rel_path: 'src/b.js' })[0].id;
      const target = db.where('files', { rel_path: 'src/target.js' })[0].id;
      db.replaceWhere('imports', { file_id: a }, [
        { file_id: a, specifier: './target', resolved: 'src/target.js', kind: 'import' },
      ]);
      db.replaceWhere('imports', { file_id: b }, [
        { file_id: b, specifier: '../target', resolved: 'src/target.js', kind: 'require' },
      ]);

      const stats = graph.rebuildGraph(db);
      expect(db.get('files', target).importers_sig).toBe(first);
      expect(stats.signaturesChanged).toBe(0);
      expect(stats.roleStale).toBe(0);
    } finally {
      db.close();
    }
  });

  it('moves importers_sig when an importer is added, and flags role drift', () => {
    const db = openStore(backend);
    try {
      const ids = seed(
        db,
        ['src/a.js', 'src/b.js', 'src/target.js'],
        [['src/a.js', 'src/target.js']],
      );
      const target = ids.get('src/target.js');
      db.insert('summaries', {
        file_id: target,
        purpose: 'Shared helper.',
        source: 'heuristic',
        sha: 'sha-src/target.js',
        base_conf: 0.7,
        made_at: 1,
        role_stale: 0,
      });

      const first = graph.rebuildGraph(db);
      expect(first.roleStale).toBe(0);
      expect(first.firstRun).toBeGreaterThan(0);
      const baseline = db.get('files', target).importers_sig;

      db.insert('imports', {
        file_id: ids.get('src/b.js'),
        specifier: './target',
        resolved: 'src/target.js',
        kind: 'import',
      });

      const second = graph.rebuildGraph(db);
      expect(second.roleStale).toBe(1);
      expect(db.get('files', target).importers_sig).not.toBe(baseline);
      expect(db.get('summaries', target).role_stale).toBe(1);
      // The file's own bytes never moved: this is drift, not a re-index.
      expect(db.get('files', target).content_sha).toBe('sha-src/target.js');
    } finally {
      db.close();
    }
  });

  it('does not call the first computation drift', () => {
    const db = openStore(backend);
    try {
      const ids = seed(db, ['src/a.js', 'src/target.js'], [['src/a.js', 'src/target.js']]);
      const target = ids.get('src/target.js');
      db.insert('summaries', {
        file_id: target,
        purpose: 'Shared helper.',
        source: 'heuristic',
        sha: 'sha-src/target.js',
        base_conf: 0.7,
        made_at: 1,
        role_stale: 0,
      });

      const stats = graph.rebuildGraph(db);
      expect(stats.roleStale).toBe(0);
      expect(stats.firstRun).toBe(2);
      expect(db.get('summaries', target).role_stale).toBe(0);
      expect(db.get('files', target).importers_sig).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      db.close();
    }
  });

  it('drift is one-way: a signature that returns leaves the summary stale', () => {
    const db = openStore(backend);
    try {
      const ids = seed(
        db,
        ['src/a.js', 'src/b.js', 'src/target.js'],
        [['src/a.js', 'src/target.js']],
      );
      const target = ids.get('src/target.js');
      db.insert('summaries', {
        file_id: target, purpose: 'p', source: 'heuristic', sha: 'sha-src/target.js',
        base_conf: 0.7, made_at: 1, role_stale: 0,
      });
      graph.rebuildGraph(db);

      db.insert('imports', {
        file_id: ids.get('src/b.js'), specifier: './target', resolved: 'src/target.js', kind: 'import',
      });
      expect(graph.rebuildGraph(db).roleStale).toBe(1);

      db.replaceWhere('imports', { file_id: ids.get('src/b.js') }, []);
      const back = graph.rebuildGraph(db);
      expect(back.roleStale).toBe(0);
      expect(db.get('summaries', target).role_stale).toBe(1);
    } finally {
      db.close();
    }
  });

  it('ignores tombstoned importers and tombstoned targets', () => {
    const db = openStore(backend);
    try {
      const ids = seed(
        db,
        ['src/a.js', 'src/dead.js', 'src/target.js'],
        [['src/a.js', 'src/target.js'], ['src/dead.js', 'src/target.js']],
      );
      graph.rebuildGraph(db);
      const withDead = db.get('files', ids.get('src/target.js')).importers_sig;
      expect(graph.importers(db, 'src/target.js')).toEqual(['src/a.js', 'src/dead.js']);

      db.update('files', ids.get('src/dead.js'), { deleted: 1 });
      const stats = graph.rebuildGraph(db);
      expect(graph.importers(db, 'src/target.js')).toEqual(['src/a.js']);
      expect(db.get('files', ids.get('src/target.js')).importers_sig).not.toBe(withDead);
      expect(stats.edges).toBe(1);

      // A tombstoned target contributes no edges at all.
      db.update('files', ids.get('src/target.js'), { deleted: 1 });
      expect(graph.rebuildGraph(db).edges).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts an unresolved specifier as an edge not followed, never as a dependency', () => {
    const db = openStore(backend);
    try {
      const ids = seed(db, ['src/a.js'], []);
      db.insert('imports', {
        file_id: ids.get('src/a.js'), specifier: 'left-pad', resolved: null, kind: 'import',
      });
      const stats = graph.rebuildGraph(db);
      expect(stats.unfollowed).toBe(1);
      expect(stats.edges).toBe(0);
      expect(graph.dependencies(db, 'src/a.js')).toEqual([]);
      expect(graph.edgesOf(db, 'src/a.js')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second rebuild changes nothing', () => {
    const db = openStore(backend);
    try {
      const ids = seed(
        db,
        ['src/a.js', 'src/b.js', 'src/target.js'],
        [['src/a.js', 'src/target.js'], ['src/b.js', 'src/target.js']],
      );
      db.insert('summaries', {
        file_id: ids.get('src/target.js'), purpose: 'p', source: 'heuristic',
        sha: 'sha-src/target.js', base_conf: 0.7, made_at: 1, role_stale: 0,
      });
      graph.rebuildGraph(db);
      const snapshot = db.all('files').map((row) => [row.rel_path, row.importers_sig]);

      const second = graph.rebuildGraph(db);
      expect(second.signaturesChanged).toBe(0);
      expect(second.roleStale).toBe(0);
      expect(db.all('files').map((row) => [row.rel_path, row.importers_sig])).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('returns a neutral result when the store is absent', () => {
    expect(graph.rebuildGraph(null)).toEqual({
      files: 0, edges: 0, unfollowed: 0, signaturesChanged: 0, roleStale: 0, firstRun: 0,
    });
    expect(graph.importers(null, 'src/a.js')).toEqual([]);
    expect(graph.dependencies(null, 'src/a.js')).toEqual([]);
    expect(graph.writeEdges(null, { relPath: 'src/a.js', imports: [] })).toEqual({
      fileId: null, written: 0, resolved: 0,
    });
  });
});

describe('loom/graph edge writing (§4.6)', () => {
  it('resolves specifiers against an injected file list and replaces old edges', () => {
    const db = openStore('json');
    try {
      const ids = seed(db, ['src/a.js', 'src/util.js'], []);
      const exists = (rel) => rel === 'src/util.js';

      const first = graph.writeEdges(db, {
        relPath: 'src/a.js',
        imports: [
          { specifier: './util', kind: 'require' },
          { specifier: 'lodash', kind: 'require' },
        ],
        exists,
      });
      expect(first).toEqual({ fileId: ids.get('src/a.js'), written: 2, resolved: 1 });
      expect(graph.edgesOf(db, 'src/a.js').map((row) => [row.specifier, row.resolved]))
        .toEqual([['./util', 'src/util.js'], ['lodash', null]]);

      // A second write replaces, not appends: the dropped import is gone.
      graph.writeEdges(db, { relPath: 'src/a.js', imports: [{ specifier: 'lodash' }], exists });
      expect(graph.edgesOf(db, 'src/a.js').map((row) => row.specifier)).toEqual(['lodash']);

      expect(graph.dependencies(db, 'src/a.js')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses to write edges for a file it does not know', () => {
    const db = openStore('json');
    try {
      seed(db, ['src/a.js'], []);
      expect(graph.writeEdges(db, { relPath: 'src/ghost.js', imports: [{ specifier: './a' }] }))
        .toEqual({ fileId: null, written: 0, resolved: 0 });
    } finally {
      db.close();
    }
  });

  it('builds the graph from extractor output end to end', () => {
    const extract = require('../../src/loom/extract');
    const db = openStore('json');
    try {
      seed(db, ['src/a.js', 'src/util.js'], []);
      const out = extract.extract("const u = require('./util');\nmodule.exports = u;\n", 'src/a.js');
      expect(out.imports).toHaveLength(1);

      graph.writeEdges(db, { relPath: 'src/a.js', imports: out.imports, exists: (rel) => rel === 'src/util.js' });
      const stats = graph.rebuildGraph(db);
      expect(stats.edges).toBe(1);
      expect(graph.importers(db, 'src/util.js')).toEqual(['src/a.js']);
      expect(graph.dependencies(db, 'src/a.js')).toEqual(['src/util.js']);
    } finally {
      db.close();
    }
  });
});
