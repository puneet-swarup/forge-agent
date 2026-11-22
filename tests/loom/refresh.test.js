// tests/loom/refresh.test.js — spec §5: the stored index and incremental sweep.
//
// What this suite holds:
//   * the fast negative is a *negative* only (mtime + size equal ⇒ unchanged,
//     a mismatch ⇒ candidate, the hash decides);
//   * a deleted file is tombstoned, not silently kept;
//   * the dirty flag (§5.5) is what makes `run_command` safe: same size, same
//     mtime, different bytes is invisible until something forces a rehash;
//   * access rows are what the digest ranks by — the headline reason the index
//     exists at all;
//   * I1 (nothing throws) and I2 (disabled ⇒ no I/O) hold on every entry point.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const loom = require('../../src/loom');
const refresh = require('../../src/loom/refresh');
const digest = require('../../src/loom/digest');

let tmp;

const write = (rel, text) => {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
};

const openStore = (opts = {}) => {
  loom.open({ root: tmp, env: {}, forceJson: true, ...opts });
  return loom.db();
};

const sweep = (db, opts = {}) => refresh.refresh({ db, root: tmp, env: {}, ...opts });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-refresh-'));
  loom.close();
});

afterEach(() => {
  loom.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the first sweep', () => {
  it('indexes every candidate and calls it a rebuild', () => {
    write('src/alpha.js', '// alpha\nfunction alpha() { return 1; }\nmodule.exports = { alpha };\n');
    write('src/beta.js', 'const beta = 2;\n');
    write('README.md', '# Beta\n\nNotes.\n');

    const db = openStore();
    const result = sweep(db);

    expect(result.skipped).toBe(false);
    expect(result.rebuilt).toBe(true); // everything is new: 100% churn
    expect(result.added).toBe(3);
    expect(result.indexed).toBe(3);
    expect(db.count('files')).toBe(3);
  });

  it('stores symbols, imports and a heuristic summary', () => {
    write('src/alpha.js', '// alpha does a thing\nfunction alpha() { return 1; }\nmodule.exports = { alpha };\n');
    write('src/beta.js', "// beta\nconst alpha = require('./alpha');\nmodule.exports = { alpha };\n");

    const db = openStore();
    sweep(db);

    const symbols = db.all('symbols').map((row) => row.name);
    expect(symbols).toContain('alpha');

    const imports = db.all('imports');
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('./alpha');
    // Resolution happens at write time so §5.6 role drift can read the table.
    expect(imports[0].resolved).toBe('src/alpha.js');

    const summary = db.all('summaries')[0];
    expect(summary.source).toBe('heuristic');
    expect(summary.base_conf).toBeCloseTo(0.7, 5);
  });

  it('never indexes a credential or a hard-denied directory', () => {
    write('.env', 'TOKEN=abcdef\n');
    write('node_modules/left-pad/index.js', 'module.exports = 1;\n');
    write('src/alpha.js', 'const a = 1;\n');

    const db = openStore();
    const result = sweep(db);

    const paths = db.all('files').map((row) => row.rel_path);
    expect(paths).toEqual(['src/alpha.js']);
    expect(result.added).toBe(1);
  });

  it('marks an oversized file skipped instead of pretending to have read it', () => {
    write('src/big.js', `const big = "${'x'.repeat(400)}";\n`);

    const db = openStore();
    sweep(db, { maxFileBytes: 50 });

    const row = db.all('files')[0];
    expect(row.parse_state).toBe('skipped');
    expect(db.count('symbols')).toBe(0);
  });
});

describe('the second sweep', () => {
  it('does no work when nothing changed', () => {
    write('src/alpha.js', 'const a = 1;\n');
    const db = openStore();
    sweep(db);

    const again = sweep(db);
    expect(again.changed).toBe(0);
    expect(again.added).toBe(0);
    expect(again.gone).toBe(0);
    expect(again.rebuilt).toBe(false);
    expect(again.indexed).toBe(0);
  });

  it('refreshes the stat only when the bytes are identical (§5.1)', () => {
    write('src/alpha.js', 'const a = 1;\n');
    const db = openStore();
    sweep(db);
    // The JSON backend hands out live row objects; copy before mutating.
    const before = { ...db.all('files')[0] };

    // Same bytes, new mtime — a checkout, an rsync, a copy.
    fs.writeFileSync(path.join(tmp, 'src/alpha.js'), 'const a = 1;\n');
    fs.utimesSync(path.join(tmp, 'src/alpha.js'), new Date(), new Date(Date.now() + 60000));

    const again = sweep(db);
    const after = db.all('files')[0];
    expect(again.changed).toBe(0);
    expect(again.touched).toBe(1);
    expect(after.content_sha).toBe(before.content_sha);
    expect(after.mtime_ms).not.toBe(before.mtime_ms);
  });

  it('re-indexes a changed file and replaces its structure', () => {
    write('src/alpha.js', '// alpha\nfunction alpha() { return 1; }\n');
    const db = openStore();
    sweep(db);
    expect(db.all('symbols').map((r) => r.name)).toContain('alpha');

    // Different length on purpose: equal size *and* mtime is the documented
    // fast-negative blind spot, covered by the dirty-flag test instead.
    write('src/alpha.js', '// gamma\nfunction gamma() { return 22; }\n');
    const again = sweep(db);

    expect(again.changed).toBe(1);
    const names = db.all('symbols').map((r) => r.name);
    expect(names).toContain('gamma');
    expect(names).not.toContain('alpha');
  });

  it('tombstones a deleted file and drops it from the graph', () => {
    write('src/alpha.js', 'const a = 1;\n');
    write('src/beta.js', 'const b = 1;\n');
    const db = openStore();
    sweep(db);

    fs.rmSync(path.join(tmp, 'src/beta.js'));
    const again = sweep(db);

    expect(again.gone).toBe(1);
    const row = db.where('files', { rel_path: 'src/beta.js' })[0];
    expect(row.deleted).toBe(1);
    expect(refresh.filesForGraph(db).map((f) => f.path)).toEqual(['src/alpha.js']);
    expect(refresh.readGraph(db, { root: tmp }).nodes).toHaveLength(1);
  });
});

describe('the dirty flag (§5.5)', () => {
  it('is the only thing that catches same-size, same-mtime, different bytes', () => {
    const file = path.join(tmp, 'src/alpha.js');
    write('src/alpha.js', 'const a = 1;\n');
    // Pin a whole-second mtime so the restore below is exact; a sub-millisecond
    // timestamp would round-trip as a different value and defeat the point.
    const pinned = new Date('2024-01-01T00:00:00.000Z');
    fs.utimesSync(file, pinned, pinned);

    const db = openStore();
    sweep(db);

    fs.writeFileSync(file, 'const a = 2;\n'); // same length, different bytes
    fs.utimesSync(file, pinned, pinned);

    // Fast negative: mtime and size match, so the change is invisible.
    expect(sweep(db).changed).toBe(0);

    // run_command just ran: the dispatcher marks the index dirty.
    expect(refresh.markDirty(db)).toBe(true);
    expect(refresh.isDirty(db)).toBe(true);

    const forced = sweep(db);
    expect(forced.changed).toBe(1);
    expect(forced.dirty).toBe(true);
    expect(refresh.isDirty(db)).toBe(false); // cleared by a successful sweep
  });
});

describe('the rebuild threshold', () => {
  it('rebuilds the whole index when churn crosses LOOM_REBUILD_THRESHOLD', () => {
    for (let i = 0; i < 10; i += 1) write(`src/f${i}.js`, `const v${i} = ${i};\n`);
    const db = openStore();
    sweep(db);

    for (let i = 0; i < 5; i += 1) write(`src/f${i}.js`, `const v${i} = ${i + 100};\n`);
    const again = sweep(db);

    expect(again.rebuilt).toBe(true);
    expect(again.indexed).toBe(10);
  });

  it('stays incremental below the threshold', () => {
    for (let i = 0; i < 10; i += 1) write(`src/f${i}.js`, `const v${i} = ${i};\n`);
    const db = openStore();
    sweep(db);

    write('src/f0.js', 'const v0 = 100;\n');
    const again = sweep(db);

    expect(again.rebuilt).toBe(false);
    expect(again.indexed).toBe(1);
  });
});

describe('the graph', () => {
  it('derives edges from the stored import rows', () => {
    write('src/alpha.js', 'const b = 1;\n');
    write('src/beta.js', "const alpha = require('./alpha');\n");
    const db = openStore();
    sweep(db);

    const graph = refresh.readGraph(db, { root: tmp });
    expect(graph.edges).toEqual([
      { from: 'src/beta.js', to: 'src/alpha.js', specifier: './alpha', kind: 'require' },
    ]);
  });

  it('flags role drift when a file gains an importer but its bytes do not change (§5.6)', () => {
    write('src/alpha.js', '// alpha\nfunction alpha() { return 1; }\n');
    const db = openStore();
    sweep(db);

    write('src/beta.js', "// beta\nconst alpha = require('./alpha');\n");
    const again = sweep(db);

    expect(again.roleDrift).toContain('src/alpha.js');
    const alpha = db.where('files', { rel_path: 'src/alpha.js' })[0];
    expect(alpha.importers_sig).not.toBe('');
    const summary = db.where('summaries', { file_id: alpha.id })[0];
    expect(summary.role_stale).toBe(1);
    // Role-stale prose is not served (§5.1, I3).
    expect(refresh.filesForGraph(db).find((f) => f.path === 'src/alpha.js').summary).toBe('');
  });
});

describe('access tracking (§7)', () => {
  it('records an access row for an indexed file and refuses anything else', () => {
    write('src/alpha.js', 'const a = 1;\n');
    const db = openStore();
    sweep(db);

    expect(refresh.recordAccess(db, 'src/alpha.js', 'read', { session: 's1', lines: 12 })).toBe(true);
    expect(refresh.recordAccess(db, 'src/alpha.js', 'nonsense', {})).toBe(false);
    expect(refresh.recordAccess(db, 'src/missing.js', 'read', {})).toBe(false);
    expect(refresh.recordAccess(db, '../escape.js', 'read', {})).toBe(false);

    const rows = refresh.accessRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: 'src/alpha.js', op: 'read', lines: 12, session: 's1' });
  });

  it('ranks the file the agent actually read above its alphabetical neighbour', () => {
    write('src/alpha.js', '// alpha\nconst a = 1;\n');
    write('src/beta.js', '// beta\nconst b = 1;\n');

    const db = openStore();
    sweep(db);

    const cold = digest.renderDigest(refresh.readGraph(db, { root: tmp }), {
      root: 'proj', access: refresh.accessRows(db),
    });
    // Nothing has been touched: alpha wins the alphabetical tie.
    expect(cold.indexOf('alpha.js')).toBeLessThan(cold.indexOf('beta.js'));

    refresh.recordAccess(db, 'src/beta.js', 'edit', { ts: Date.now() });
    refresh.recordAccess(db, 'src/beta.js', 'read', { ts: Date.now() });

    const hot = digest.renderDigest(refresh.readGraph(db, { root: tmp }), {
      root: 'proj', access: refresh.accessRows(db),
    });
    expect(hot).toContain('alpha.js');
    expect(hot.indexOf('beta.js')).toBeLessThan(hot.indexOf('alpha.js'));
  });

  it('keeps only the most recent rows when a limit is given', () => {
    write('src/alpha.js', 'const a = 1;\n');
    const db = openStore();
    sweep(db);
    for (let i = 0; i < 5; i += 1) refresh.recordAccess(db, 'src/alpha.js', 'read', { ts: 1000 + i });
    const rows = refresh.accessRows(db, { limit: 2 });
    expect(rows.map((r) => r.ts)).toEqual([1003, 1004]);
  });
});

describe('invariants', () => {
  it('I1 — never throws, whatever it is handed', () => {
    expect(() => refresh.refresh({})).not.toThrow();
    expect(refresh.refresh({ db: null }).skipped).toBe(true);
    expect(() => refresh.refresh({ db: {}, root: tmp })).not.toThrow();
    expect(refresh.refresh({ db: {}, root: tmp }).error).toBeTruthy();
    expect(() => refresh.refresh({ db: openStore(), root: '/nonexistent/xyz' })).not.toThrow();
    expect(() => refresh.readGraph(null)).not.toThrow();
    expect(refresh.accessRows(null)).toEqual([]);
    expect(refresh.filesForGraph(null)).toEqual([]);
    expect(refresh.recordAccess(null, 'src/a.js', 'read')).toBe(false);
    expect(refresh.markDirty(null)).toBe(false);
  });

  it('I2 — LOOM_ENABLED=0 does no work and creates nothing', () => {
    write('src/alpha.js', 'const a = 1;\n');
    const db = openStore();
    const result = refresh.refresh({ db, root: tmp, env: { LOOM_ENABLED: '0' } });
    expect(result.skipped).toBe(true);
    expect(db.count('files')).toBe(0);
  });
});

describe('candidate collection', () => {
  it('honours .gitignore and is deterministic', () => {
    write('.gitignore', '*.log\nscratch/\n');
    write('src/alpha.js', 'const a = 1;\n');
    write('debug.log', 'noise\n');
    write('scratch/notes.md', '# notes\n');

    const rules = refresh.readGitignore(tmp);
    const files = refresh.collectCandidates(tmp, { rules });
    expect(files).toEqual(['src/alpha.js']);
    expect(files).toEqual([...files].sort());
  });

  it('stops at the file cap', () => {
    for (let i = 0; i < 12; i += 1) write(`src/f${i}.js`, 'const a = 1;\n');
    expect(refresh.collectCandidates(tmp, { maxFiles: 5 })).toHaveLength(5);
  });
});
