// tests/loom/graph.test.js — spec §4.6, §5.6, §7: the dependency graph.
//
// The graph is the one derived artefact everything downstream trusts: heat
// counts importers, the digest names the most connected files, role drift
// compares importer sets. So the cases here are about the two ways a graph goes
// wrong — a missing edge and an invented one — plus the invariants that keep it
// safe to call from a tool handler (I1, I2, I6) and the determinism the digest
// depends on for byte-identical output.
//
// Existence is answered by the node set, so nothing here touches the disk.

'use strict';

const graphMod = require('../../src/loom/graph');

const { buildGraph, dependenciesOf, dependentsOf, entryPoints, cycles, emptyGraph } = graphMod;

/** A small project: a CLI, a core module, a two-file cycle and a partial file. */
function project() {
  return [
    {
      path: 'src/cli.js',
      lang: 'js',
      loc: 40,
      summary: 'Core module. CLI entry point.',
      symbols: [
        { name: 'main', kind: 'function', line_start: 12, line_end: 30, exported: 1, confidence: 0.9 },
        { name: 'parseArgs', kind: 'function', line_start: 3, line_end: 10, exported: 0, confidence: 0.9 },
      ],
      imports: [
        { specifier: './app', kind: 'require' },
        { specifier: './missing-local', kind: 'require' },
        { specifier: 'node:fs', kind: 'require' },
      ],
    },
    {
      path: 'src/app.js',
      lang: 'js',
      loc: 80,
      summary: 'Core module. Wires the CLI to the core.',
      symbols: [{ name: 'run', kind: 'function', line_start: 5, line_end: 44, exported: 1, confidence: 0.9 }],
      imports: [
        { specifier: './core/util', kind: 'require' },
        { specifier: './cycle-a', kind: 'require' },
        { specifier: 'playwright', kind: 'require' },
      ],
    },
    {
      path: 'src/core/util.js',
      lang: 'js',
      loc: 12,
      summary: '',
      symbols: [],
      imports: [{ specifier: 'node:path', kind: 'require' }],
    },
    {
      path: 'src/cycle-a.js',
      lang: 'js',
      loc: 10,
      summary: 'Cycle member A.',
      symbols: [],
      imports: [{ specifier: './cycle-b', kind: 'require' }],
    },
    {
      path: 'src/cycle-b.js',
      lang: 'js',
      loc: 10,
      summary: 'Cycle member B.',
      symbols: [],
      imports: [{ specifier: './cycle-a', kind: 'require' }],
    },
    {
      path: 'src/partial.js',
      lang: 'js',
      loc: 90,
      summary: 'Parsed only in part.',
      partial: true,
      symbols: [{ name: 'guess', kind: 'function', line_start: 1, line_end: 2, exported: 1, confidence: 0.9 }],
      imports: [{ specifier: './core/util', kind: 'require' }],
    },
    { path: 'README.md', lang: 'md', loc: 30, summary: 'Documentation.', symbols: [], imports: [] },
  ];
}

/** Node by path, for terse assertions. */
const nodeByPath = (graph, relPath) => graph.nodes.find((node) => node.path === relPath);

describe('loom/graph — nodes', () => {
  test('one node per file, sorted by path, structure preserved', () => {
    const graph = buildGraph(project());
    expect(graph.nodes.map((n) => n.path)).toEqual([
      'README.md',
      'src/app.js',
      'src/cli.js',
      'src/core/util.js',
      'src/cycle-a.js',
      'src/cycle-b.js',
      'src/partial.js',
    ]);
    const cli = nodeByPath(graph, 'src/cli.js');
    expect(cli.lang).toBe('js');
    expect(cli.loc).toBe(40);
    expect(cli.summary).toBe('Core module. CLI entry point.');
    expect(cli.partial).toBe(false);
    expect(nodeByPath(graph, 'src/partial.js').partial).toBe(true);
  });

  test('symbols are sorted by line, then name', () => {
    const cli = nodeByPath(buildGraph(project()), 'src/cli.js');
    expect(cli.symbols.map((s) => s.name)).toEqual(['parseArgs', 'main']);
  });

  test('duplicate paths keep the first occurrence, not a merge', () => {
    const files = project();
    files.push({ path: 'src/cli.js', lang: 'js', loc: 999, summary: 'duplicate', symbols: [], imports: [] });
    const graph = buildGraph(files);
    expect(graph.nodes.filter((n) => n.path === 'src/cli.js')).toHaveLength(1);
    expect(nodeByPath(graph, 'src/cli.js').loc).toBe(40);
  });

  test('a file with no imports and no importers is still a node', () => {
    const graph = buildGraph(project());
    expect(nodeByPath(graph, 'README.md').inDegree).toBe(0);
    expect(nodeByPath(graph, 'README.md').outDegree).toBe(0);
  });
});

describe('loom/graph — edges', () => {
  test('an edge exists only for a resolved local import', () => {
    const graph = buildGraph(project());
    expect(graph.edges).toContainEqual({
      from: 'src/cli.js',
      to: 'src/app.js',
      specifier: './app',
      kind: 'require',
    });
  });

  test('resolution follows resolve.js: extensionless and index forms both land', () => {
    const graph = buildGraph([
      { path: 'src/a.js', imports: [{ specifier: './core/util', kind: 'require' }] },
      { path: 'src/core/util.js', imports: [] },
      { path: 'src/core/index.js', imports: [] },
      { path: 'src/b.js', imports: [{ specifier: './core', kind: 'require' }] },
    ]);
    expect(dependenciesOf(graph, 'src/a.js')).toEqual(['src/core/util.js']);
    expect(dependenciesOf(graph, 'src/b.js')).toEqual(['src/core/index.js']);
  });

  test('external specifiers are counted, never turned into edges', () => {
    const graph = buildGraph(project());
    const fromCli = graph.edges.filter((edge) => edge.from === 'src/cli.js');
    expect(fromCli.map((edge) => edge.to)).toEqual(['src/app.js']);
    expect(graph.stats.external).toBeGreaterThan(0);
    expect(graph.edges.some((edge) => edge.specifier === 'playwright')).toBe(false);
  });

  test('an unresolved local specifier is reported, not invented', () => {
    const graph = buildGraph(project());
    expect(graph.unresolved).toEqual([
      { from: 'src/cli.js', specifier: './missing-local', kind: 'require' },
    ]);
    expect(graph.stats.unresolved).toBe(1);
    expect(graph.edges.some((edge) => edge.to === 'src/missing-local.js')).toBe(false);
  });

  test('edges are de-duplicated and degrees count distinct partners', () => {
    const graph = buildGraph([
      { path: 'src/a.js', imports: [{ specifier: './b', kind: 'require' }, { specifier: './b.js', kind: 'require' }] },
      { path: 'src/b.js', imports: [] },
    ]);
    expect(graph.edges).toHaveLength(2); // two specifiers, two distinct rows
    expect(dependenciesOf(graph, 'src/a.js')).toEqual(['src/b.js']);
    expect(nodeByPath(graph, 'src/a.js').outDegree).toBe(1);
    expect(nodeByPath(graph, 'src/b.js').inDegree).toBe(1);
  });

  test('a self-import is not an edge', () => {
    const graph = buildGraph([{ path: 'src/a.js', imports: [{ specifier: './a', kind: 'require' }] }]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolved).toEqual([]);
  });

  test('an import that already carries `resolved` uses it when the target is known', () => {
    const graph = buildGraph([
      { path: 'src/a.js', imports: [{ specifier: '@/b', resolved: 'src/b.js', kind: 'require' }] },
      { path: 'src/b.js', imports: [] },
    ]);
    expect(dependenciesOf(graph, 'src/a.js')).toEqual(['src/b.js']);
  });

  test('a stale `resolved` pointing outside the node set falls back to resolution', () => {
    const graph = buildGraph([
      { path: 'src/a.js', imports: [{ specifier: './b', resolved: 'src/gone.js', kind: 'require' }] },
      { path: 'src/b.js', imports: [] },
    ]);
    expect(dependenciesOf(graph, 'src/a.js')).toEqual(['src/b.js']);
    expect(graph.unresolved).toEqual([]);
  });

  test('edges and unresolved are sorted for a stable comparison', () => {
    const graph = buildGraph(project());
    const keys = graph.edges.map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.specifier}`);
    expect(keys).toEqual(keys.slice().sort());
  });
});

describe('loom/graph — query helpers', () => {
  test('dependenciesOf and dependentsOf are sorted and de-duplicated', () => {
    const graph = buildGraph(project());
    expect(dependenciesOf(graph, 'src/app.js')).toEqual([
      'src/core/util.js',
      'src/cycle-a.js',
    ]);
    expect(dependentsOf(graph, 'src/core/util.js')).toEqual([
      'src/app.js',
      'src/partial.js',
    ]);
  });

  test('an unknown or non-normalisable path answers with an empty list', () => {
    const graph = buildGraph(project());
    expect(dependenciesOf(graph, 'src/nope.js')).toEqual([]);
    expect(dependentsOf(graph, 'src/nope.js')).toEqual([]);
    expect(dependenciesOf(graph, '../escape.js')).toEqual([]);
    expect(dependenciesOf(graph, null)).toEqual([]);
  });
});

describe('loom/graph — entry points (§7)', () => {
  test('the filename pattern is a declared entry point', () => {
    const graph = buildGraph([{ path: 'src/cli.js', imports: [] }, { path: 'src/other.js', imports: [] }]);
    expect(entryPoints(graph)).toEqual(['src/cli.js']);
    expect(graph.declaredEntries).toEqual(['src/cli.js']);
  });

  test('package.json main, bin and exports all count', () => {
    const graph = buildGraph(
      [
        { path: 'src/main.js', imports: [] },
        { path: 'bin/run.js', imports: [] },
        { path: 'src/api.js', imports: [] },
      ],
      { packageJson: { main: './src/main.js', bin: { fa: './bin/run.js' }, exports: { '.': './src/api' } } },
    );
    expect(entryPoints(graph)).toEqual(['bin/run.js', 'src/api.js', 'src/main.js']);
  });

  test('explicit opts.entries are honoured and filtered to real files', () => {
    const graph = buildGraph(
      [{ path: 'src/a.js', imports: [] }, { path: 'src/b.js', imports: [] }],
      { entries: ['src/b.js', 'src/ghost.js'] },
    );
    expect(graph.declaredEntries).toEqual(['src/b.js']);
    expect(entryPoints(graph)).toEqual(['src/b.js']);
  });

  test('zero importers with a local import is an inferred entry point', () => {
    const graph = buildGraph([
      { path: 'scripts/task.js', imports: [{ specifier: '../src/lib', kind: 'require' }] },
      { path: 'src/lib.js', imports: [] },
    ]);
    expect(entryPoints(graph)).toEqual(['scripts/task.js']);
    expect(graph.declaredEntries).toEqual([]);
    expect(nodeByPath(graph, 'scripts/task.js').entry).toBe(true);
    expect(nodeByPath(graph, 'src/lib.js').entry).toBe(false);
  });

  test('a leaf with no imports and no importers is not an entry point', () => {
    const graph = buildGraph([{ path: 'README.md', imports: [] }]);
    expect(entryPoints(graph)).toEqual([]);
  });

  test('a non-object packageJson is ignored rather than fatal', () => {
    const graph = buildGraph([{ path: 'src/index.js', imports: [] }], { packageJson: '{not json' });
    expect(entryPoints(graph)).toEqual(['src/index.js']);
  });
});

describe('loom/graph — cycles', () => {
  test('a two-file cycle is reported as one sorted group', () => {
    const graph = buildGraph(project());
    expect(cycles(graph)).toEqual([['src/cycle-a.js', 'src/cycle-b.js']]);
    expect(graph.cyclic).toBe(true);
    expect(graph.stats.cycles).toBe(1);
  });

  test('an acyclic graph reports nothing', () => {
    const graph = buildGraph([{ path: 'src/a.js', imports: [{ specifier: './b', kind: 'require' }] }, { path: 'src/b.js', imports: [] }]);
    expect(cycles(graph)).toEqual([]);
    expect(graph.cyclic).toBe(false);
  });

  test('a self-loop is not reported as a cycle, because it is not an edge', () => {
    const graph = buildGraph([{ path: 'src/a.js', imports: [{ specifier: './a', kind: 'require' }] }]);
    expect(cycles(graph)).toEqual([]);
  });

  test('a three-file cycle and a nested pair are both found', () => {
    const graph = buildGraph([
      { path: 'a.js', imports: [{ specifier: './b', kind: 'require' }] },
      { path: 'b.js', imports: [{ specifier: './c', kind: 'require' }] },
      { path: 'c.js', imports: [{ specifier: './a', kind: 'require' }, { specifier: './d', kind: 'require' }] },
      { path: 'd.js', imports: [{ specifier: './e', kind: 'require' }] },
      { path: 'e.js', imports: [{ specifier: './d', kind: 'require' }] },
    ]);
    expect(cycles(graph)).toEqual([
      ['a.js', 'b.js', 'c.js'],
      ['d.js', 'e.js'],
    ]);
  });

  test('cycles() recomputes from edges when the graph carries none', () => {
    const graph = {
      nodes: [],
      edges: [
        { from: 'x.js', to: 'y.js', specifier: './y', kind: 'require' },
        { from: 'y.js', to: 'x.js', specifier: './x', kind: 'require' },
      ],
    };
    expect(cycles(graph)).toEqual([['x.js', 'y.js']]);
  });
});

describe('loom/graph — determinism', () => {
  test('the same input yields the same graph, twice', () => {
    const first = JSON.stringify(buildGraph(project()));
    const second = JSON.stringify(buildGraph(project()));
    expect(second).toBe(first);
  });

  test('input order does not matter', () => {
    const files = project();
    const shuffled = [...files].reverse().map((file) => ({
      ...file,
      imports: [...(file.imports || [])].reverse(),
      symbols: [...(file.symbols || [])].reverse(),
    }));
    expect(JSON.stringify(buildGraph(shuffled))).toBe(JSON.stringify(buildGraph(files)));
  });
});

describe('loom/graph — invariants', () => {
  test('I2: LOOM_ENABLED=0 is an empty graph and does no work', () => {
    let touched = false;
    const graph = buildGraph(project(), {
      env: { LOOM_ENABLED: '0' },
      exists: () => {
        touched = true;
        return true;
      },
    });
    expect(graph).toEqual(emptyGraph());
    expect(touched).toBe(false);
  });

  test('I2: LOOM_ENABLED=false is the same kill switch', () => {
    expect(buildGraph(project(), { env: { LOOM_ENABLED: 'false' } })).toEqual(emptyGraph());
    expect(buildGraph(project(), { env: { LOOM_ENABLED: '1' } }).nodes).toHaveLength(7);
  });

  test('I1: malformed input yields an empty graph rather than a throw', () => {
    for (const input of [null, undefined, 'nope', 42, {}, [null, 42, 'x', [], { path: null }]]) {
      expect(() => buildGraph(input)).not.toThrow();
      expect(buildGraph(input)).toEqual(emptyGraph());
    }
  });

  test('I1: a throwing existence check is a miss, not a crash', () => {
    const graph = buildGraph(project(), {
      exists: () => {
        throw new Error('disk on fire');
      },
    });
    expect(graph.edges).toEqual([]);
    expect(graph.stats.unresolved).toBeGreaterThan(0);
  });

  test('I6: paths are project-relative with forward slashes', () => {
    const graph = buildGraph([
      { path: 'src\\win\\a.js', imports: [{ specifier: './b', kind: 'require' }] },
      { path: './src/win/b.js', imports: [] },
      { path: '/absolute/c.js', imports: [] },
      { path: '../escape/d.js', imports: [] },
    ]);
    expect(graph.nodes.map((n) => n.path)).toEqual(['src/win/a.js', 'src/win/b.js']);
    expect(dependenciesOf(graph, 'src/win/a.js')).toEqual(['src/win/b.js']);
  });

  test('the query helpers survive a malformed graph', () => {
    for (const bad of [null, undefined, {}, { nodes: 'x', edges: 7 }]) {
      expect(dependenciesOf(bad, 'a.js')).toEqual([]);
      expect(dependentsOf(bad, 'a.js')).toEqual([]);
      expect(entryPoints(bad)).toEqual([]);
      expect(cycles(bad)).toEqual([]);
    }
  });
});
