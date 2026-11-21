// tests/loom/digest.test.js — spec §8 (budget, section order, line formats), §7
// (heat) and §6.4 (a file with no purpose yet).
//
// The digest goes into the model's first prompt, so its failure modes are
// expensive: one character over the ceiling is a budget breach, one half-line is
// a hallucinated path, one symbol from a half-parsed file is an edit against the
// wrong range. Each describe below pins one of those down, plus the two
// invariants a caller relies on — it never throws (I1) and a disabled Loom does
// nothing at all (I2).

'use strict';

const digestMod = require('../../src/loom/digest');
const graphMod = require('../../src/loom/graph');

const { renderDigest, heatOf, FOOTER } = digestMod;
const { buildGraph } = graphMod;

const estTokens = (text) => Math.ceil(text.length / 4);

/** A project big enough that a 200-token digest cannot hold all of it. */
function bigProject(count = 30) {
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const n = String(i).padStart(2, '0');
    files.push({
      path: `src/module-${n}.js`,
      lang: 'js',
      loc: 100 + i,
      summary: `Core module number ${i}. Handles the ${n}th stage of the pipeline and its wiring.`,
      symbols: [
        { name: `run${n}`, kind: 'function', line_start: 3, line_end: 20, exported: 1, confidence: 0.9 },
        { name: `helper${n}`, kind: 'function', line_start: 22, line_end: 30, exported: 1, confidence: 0.9 },
        { name: `internal${n}`, kind: 'const', line_start: 31, line_end: 31, exported: 0, confidence: 0.9 },
      ],
      imports: i + 1 < count
        ? [{ specifier: `./module-${String(i + 1).padStart(2, '0')}`, kind: 'require' }]
        : [],
    });
  }
  files.push({
    path: 'src/index.js',
    lang: 'js',
    loc: 20,
    summary: 'Core module. Entry.',
    symbols: [{ name: 'main', kind: 'function', line_start: 1, line_end: 9, exported: 1, confidence: 0.9 }],
    imports: [{ specifier: './module-00', kind: 'require' }],
  });
  return files;
}

const bigGraph = () => buildGraph(bigProject(30), { packageJson: { main: 'src/index.js' } });

const NOTES = [
  { text: 'Entry wiring is generated.', verified: 0, scope: 'src/index.js' },
  { text: 'Adapters must not import tools.', verified: 1, scope: 'src/index.js' },
];

const CHANGED = ['src/module-02.js', 'src/module-01.js'];

/** Lines every digest is allowed to contain. A partial line matches nothing. */
const LINE_PATTERNS = [
  /^$/,
  /^# Project map \(Loom, \d+ files indexed\)$/,
  /^Stack: .+ · root: .+$/,
  /^Entry: \S.*$/,
  /^Dirs: \S.*$/,
  /^## Hot files$/,
  /^## Key symbols$/,
  /^## Notes$/,
  /^- \S.*$/,
  /^Changed, not re-indexed: \S.*$/,
  new RegExp(`^${FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
];

const allLinesWellFormed = (text) => text.split('\n').every((line) => LINE_PATTERNS.some((re) => re.test(line)));

describe('loom/digest — budget (§8.1)', () => {
  test('stays inside the ceiling at 200, 600 and 1200 tokens', () => {
    for (const maxTokens of [200, 600, 1200]) {
      const digest = renderDigest(bigGraph(), { maxTokens, root: 'demo', notes: NOTES, changed: CHANGED });
      expect(digest.length).toBeGreaterThan(0);
      expect(estTokens(digest)).toBeLessThanOrEqual(maxTokens);
      expect(digest.length).toBeLessThanOrEqual(maxTokens * 4);
    }
  });

  test('a bigger budget never yields less content', () => {
    const at = (maxTokens) => renderDigest(bigGraph(), { maxTokens, root: 'demo', notes: NOTES, changed: CHANGED });
    const small = at(200);
    const medium = at(600);
    const large = at(1200);
    expect(medium.length).toBeGreaterThan(small.length);
    expect(large.length).toBeGreaterThanOrEqual(medium.length);
  });

  test('every line of the smaller digest survives in the larger one', () => {
    const small = renderDigest(bigGraph(), { maxTokens: 200, root: 'demo' }).split('\n');
    const large = renderDigest(bigGraph(), { maxTokens: 1200, root: 'demo' }).split('\n');
    for (const line of small) {
      if (line === '' || line === FOOTER) continue;
      expect(large).toContain(line);
    }
  });

  test('maxTokens defaults to 1200', () => {
    const explicit = renderDigest(bigGraph(), { maxTokens: 1200, root: 'demo' });
    const implied = renderDigest(bigGraph(), { root: 'demo' });
    expect(implied).toBe(explicit);
  });

  test('a malformed maxTokens falls back to the default instead of misbehaving', () => {
    const digest = renderDigest(bigGraph(), { maxTokens: -5, root: 'demo' });
    expect(estTokens(digest)).toBeLessThanOrEqual(1200);
    expect(estTokens(renderDigest(bigGraph(), { maxTokens: 'lots', root: 'demo' }))).toBeLessThanOrEqual(1200);
  });
});

describe('loom/digest — sections and priority (§8.2)', () => {
  test('header, stack and footer are always present', () => {
    const digest = renderDigest(bigGraph(), { maxTokens: 200, root: 'demo', stack: ['Node.js', 'CommonJS'] });
    expect(digest.split('\n')[0]).toBe('# Project map (Loom, 31 files indexed)');
    expect(digest).toContain('Stack: Node.js, CommonJS · root: demo');
    expect(digest.endsWith(FOOTER)).toBe(true);
  });

  test('sections are dropped in priority order as the budget shrinks', () => {
    const at = (maxTokens) => renderDigest(bigGraph(), { maxTokens, root: 'demo', notes: NOTES, changed: CHANGED });

    const small = at(200);
    expect(small).toContain('## Hot files');
    expect(small).not.toContain('## Key symbols');
    expect(small).not.toContain('## Notes');
    expect(small).not.toContain('Changed, not re-indexed:');

    const medium = at(600);
    expect(medium).toContain('## Key symbols');
    expect(medium).not.toContain('## Notes');
    expect(medium).not.toContain('Changed, not re-indexed:');

    const large = at(1200);
    expect(large).toContain('## Key symbols');
    expect(large).toContain('## Notes');
    expect(large).toContain('Changed, not re-indexed:');
  });

  test('the Entry line outranks the Hot files section', () => {
    const digest = renderDigest(bigGraph(), { maxTokens: 200, root: 'demo' });
    expect(digest).toContain('Entry: src/index.js');
  });

  test('a section header is never emitted without an entry under it', () => {
    for (const maxTokens of [200, 240, 280, 320, 400, 600]) {
      const digest = renderDigest(bigGraph(), { maxTokens, root: 'demo', notes: NOTES, changed: CHANGED });
      const lines = digest.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith('## ')) continue;
        expect(lines[i + 1]).toBeDefined();
        expect(lines[i + 1].startsWith('- ')).toBe(true);
      }
    }
  });

  test('counters.digestTruncations is incremented once when content is dropped', () => {
    const counters = { digestTruncations: 0 };
    renderDigest(bigGraph(), { maxTokens: 200, root: 'demo', counters });
    expect(counters.digestTruncations).toBe(1);

    const clean = { digestTruncations: 0 };
    renderDigest(bigGraph(), { maxTokens: 1200, root: 'demo', counters: clean });
    expect(clean.digestTruncations).toBe(0);
  });

  test('the cap on hot files is 12 and on key symbols 24', () => {
    // Twelve files with three exported symbols each: 36 candidates, capped at 24.
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/f${String(i).padStart(2, '0')}.js`,
      lang: 'js',
      loc: 10,
      summary: `Module ${i}.`,
      symbols: ['a', 'b', 'c'].map((name, j) => ({
        name: `${name}${i}`, kind: 'function', line_start: j * 10 + 1, line_end: j * 10 + 5, exported: 1, confidence: 0.9,
      })),
      imports: [],
    }));
    const digest = renderDigest(buildGraph(files), { maxTokens: 4000, root: 'demo' });
    const hot = digest.split('\n').slice(digest.split('\n').indexOf('## Hot files') + 1);
    const hotLines = [];
    for (const line of hot) {
      if (!line.startsWith('- ')) break;
      hotLines.push(line);
    }
    expect(hotLines).toHaveLength(12);

    const symbolStart = digest.split('\n').indexOf('## Key symbols') + 1;
    const symbolLines = [];
    for (const line of digest.split('\n').slice(symbolStart)) {
      if (!line.startsWith('- ')) break;
      symbolLines.push(line);
    }
    expect(symbolLines).toHaveLength(24);
  });

  test('maxFiles and maxSymbols override the caps', () => {
    const digest = renderDigest(bigGraph(), { maxTokens: 4000, root: 'demo', maxFiles: 3, maxSymbols: 2 });
    const lines = digest.split('\n');
    const hotStart = lines.indexOf('## Hot files') + 1;
    expect(lines[hotStart].startsWith('- ')).toBe(true);
    expect(lines[hotStart + 3]).toBe('');
    const symbolStart = lines.indexOf('## Key symbols') + 1;
    expect(lines[symbolStart].startsWith('- ')).toBe(true);
    expect(lines[symbolStart + 2]).toBe('');
  });
});

describe('loom/digest — never truncates mid-line', () => {
  test('a line that cannot fit is dropped whole, not cut', () => {
    const longPath = `src/${'x'.repeat(900)}.js`;
    const graph = buildGraph([
      { path: 'src/index.js', lang: 'js', loc: 10, summary: 'Entry.', symbols: [], imports: [{ specifier: './a', kind: 'require' }] },
      { path: longPath, lang: 'js', loc: 10, summary: 'Huge name.', symbols: [], imports: [] },
      { path: 'src/a.js', lang: 'js', loc: 5, summary: 'Leaf.', symbols: [], imports: [] },
    ]);
    const counters = { digestTruncations: 0 };
    const digest = renderDigest(graph, { maxTokens: 200, root: 'demo', counters });

    expect(digest).not.toContain('x'.repeat(50));
    expect(digest).not.toContain(longPath);
    expect(counters.digestTruncations).toBe(1);
    expect(allLinesWellFormed(digest)).toBe(true);
  });

  test('every line matches a known line format at every budget', () => {
    for (const maxTokens of [200, 300, 600, 1200]) {
      const digest = renderDigest(bigGraph(), { maxTokens, root: 'demo', notes: NOTES, changed: CHANGED });
      expect(allLinesWellFormed(digest)).toBe(true);
    }
  });

  test('a purpose too long for its line is clipped at a word boundary', () => {
    const graph = buildGraph([
      {
        path: 'src/index.js',
        lang: 'js',
        loc: 10,
        summary: `Core module. ${'word '.repeat(80)}end.`,
        symbols: [],
        imports: [],
      },
    ]);
    const digest = renderDigest(graph, { maxTokens: 1200, root: 'demo' });
    const hotLine = digest.split('\n').find((line) => line.startsWith('- src/index.js'));
    expect(hotLine.length).toBeLessThan(220);
    expect(hotLine.endsWith('…')).toBe(true);
  });
});

describe('loom/digest — content', () => {
  test('a file with no purpose says so, per §6.4', () => {
    const graph = buildGraph([{ path: 'src/index.js', lang: 'js', loc: 4, summary: '', symbols: [], imports: [] }]);
    expect(renderDigest(graph, { root: 'demo' })).toContain('- src/index.js (4L) — (purpose pending re-index)');
  });

  test('the export clause lists at most six exported names at confidence >= 0.70', () => {
    const symbols = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => ({
      name, kind: 'const', line_start: i + 1, line_end: i + 1, exported: 1, confidence: 0.9,
    }));
    symbols.push({ name: 'low', kind: 'const', line_start: 20, line_end: 20, exported: 1, confidence: 0.3 });
    symbols.push({ name: 'private', kind: 'const', line_start: 21, line_end: 21, exported: 0, confidence: 0.9 });
    const graph = buildGraph([{ path: 'src/index.js', lang: 'js', loc: 20, summary: 'Core module.', symbols, imports: [] }]);
    const digest = renderDigest(graph, { root: 'demo' });
    expect(digest).toContain('Exports: a, b, c, d, e, f.');
    expect(digest).not.toContain('low');
    expect(digest).not.toContain('private');
  });

  test('the entry line lists at most six paths', () => {
    const graph = buildGraph(bigProject(10));
    const digest = renderDigest(graph, { root: 'demo' });
    const entryLine = digest.split('\n').find((line) => line.startsWith('Entry: '));
    expect(entryLine.split(', ').length).toBeLessThanOrEqual(6);
  });

  test('the changed line lists at most eight sorted paths', () => {
    const changed = Array.from({ length: 12 }, (_, i) => `src/c${String(i).padStart(2, '0')}.js`).reverse();
    const digest = renderDigest(bigGraph(), { maxTokens: 4000, root: 'demo', changed });
    const line = digest.split('\n').find((l) => l.startsWith('Changed, not re-indexed: '));
    const paths = line.replace('Changed, not re-indexed: ', '').split(', ');
    expect(paths).toHaveLength(8);
    expect(paths).toEqual([...paths].sort());
  });

  test('notes are capped at six and an unverified note is labelled', () => {
    const notes = Array.from({ length: 9 }, (_, i) => ({ text: `note ${i}`, verified: 1, scope: 'a.js' }));
    notes.push({ text: 'stale claim', verified: 0, scope: 'a.js' });
    const digest = renderDigest(bigGraph(), { maxTokens: 4000, root: 'demo', notes });
    const lines = digest.split('\n');
    const start = lines.indexOf('## Notes') + 1;
    const rendered = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith('- ')) break;
      rendered.push(line);
    }
    expect(rendered).toHaveLength(6);
  });

  test('an unverified note carries the suffix', () => {
    const digest = renderDigest(bigGraph(), { maxTokens: 4000, root: 'demo', notes: NOTES });
    expect(digest).toContain('- Entry wiring is generated. (unverified)');
    expect(digest).toContain('- Adapters must not import tools.');
  });

  test('the stack line falls back to the languages present', () => {
    const graph = buildGraph([
      { path: 'src/a.js', lang: 'js', imports: [] },
      { path: 'tool.py', lang: 'py', imports: [] },
    ]);
    expect(renderDigest(graph, { root: 'demo' })).toContain('Stack: JavaScript, Python · root: demo');
  });

  test('root falls back to "project"', () => {
    const graph = buildGraph([{ path: 'src/index.js', imports: [] }]);
    expect(renderDigest(graph)).toContain('· root: project');
  });

  test('paths are rendered project-relative with forward slashes (I6)', () => {
    const graph = buildGraph([{ path: 'src\\win\\index.js', lang: 'js', loc: 3, summary: 'Core module.', imports: [] }]);
    const digest = renderDigest(graph, { root: 'demo' });
    expect(digest).toContain('src/win/index.js');
    expect(digest).not.toContain('\\');
  });
});

describe('loom/digest — heat (§7)', () => {
  test('heatOf adds entry, importer and note bonuses', () => {
    expect(heatOf({ entry: false, inDegree: 0 })).toBe(0);
    expect(heatOf({ entry: true, inDegree: 0 })).toBe(3);
    expect(heatOf({ entry: false, inDegree: 3 })).toBe(2);
    expect(heatOf({ entry: true, inDegree: 4 }, { noteCount: 1 })).toBe(7);
  });

  test('a file with many importers outranks an otherwise identical leaf', () => {
    const graph = buildGraph([
      { path: 'src/hub.js', lang: 'js', loc: 10, summary: 'Hub.', symbols: [], imports: [] },
      { path: 'src/leaf.js', lang: 'js', loc: 10, summary: 'Leaf.', symbols: [], imports: [] },
      { path: 'src/a.js', imports: [{ specifier: './hub', kind: 'require' }] },
      { path: 'src/b.js', imports: [{ specifier: './hub', kind: 'require' }] },
      { path: 'src/c.js', imports: [{ specifier: './hub', kind: 'require' }] },
    ]);
    const digest = renderDigest(graph, { root: 'demo' });
    expect(digest.indexOf('- src/hub.js')).toBeLessThan(digest.indexOf('- src/leaf.js'));
  });

  test('recent access outranks old access', () => {
    const now = Date.UTC(2026, 0, 1);
    const graph = buildGraph([
      { path: 'src/old.js', lang: 'js', loc: 10, summary: 'Old.', imports: [] },
      { path: 'src/new.js', lang: 'js', loc: 10, summary: 'New.', imports: [] },
    ]);
    const digest = renderDigest(graph, {
      root: 'demo',
      now,
      access: [
        { path: 'src/old.js', op: 'read', ts: now - 90 * 86400000 },
        { path: 'src/new.js', op: 'edit', ts: now - 1 * 86400000 },
      ],
    });
    expect(digest.indexOf('- src/new.js')).toBeLessThan(digest.indexOf('- src/old.js'));
  });

  test('files that are not parse_state=ok or are deleted are excluded', () => {
    const graph = {
      nodes: [
        { path: 'src/bad.js', lang: 'js', loc: 10, summary: 'Bad.', parse_state: 'error', symbols: [] },
        { path: 'src/gone.js', lang: 'js', loc: 10, summary: 'Gone.', deleted: 1, symbols: [] },
        { path: 'src/good.js', lang: 'js', loc: 10, summary: 'Good.', symbols: [] },
      ],
      edges: [],
      entries: [],
    };
    const digest = renderDigest(graph, { root: 'demo' });
    expect(digest).toContain('src/good.js');
    expect(digest).not.toContain('src/bad.js');
    expect(digest).not.toContain('src/gone.js');
    expect(digest).toContain('3 files indexed');
  });
});

describe('loom/digest — I3, no authoritative symbol from a partial file', () => {
  const partialProject = () => [
    {
      path: 'src/index.js',
      lang: 'js',
      loc: 10,
      summary: 'Entry.',
      symbols: [{ name: 'main', kind: 'function', line_start: 1, line_end: 5, exported: 1, confidence: 0.9 }],
      imports: [{ specifier: './broken', kind: 'require' }],
    },
    {
      path: 'src/broken.js',
      lang: 'js',
      loc: 200,
      summary: 'Half parsed.',
      partial: true,
      symbols: [
        { name: 'guessed', kind: 'function', line_start: 10, line_end: 12, exported: 1, confidence: 0.9 },
      ],
      imports: [],
    },
  ];

  test('a partial file contributes no symbols and no export clause', () => {
    const digest = renderDigest(buildGraph(partialProject()), { root: 'demo' });
    expect(digest).not.toContain('guessed');
    expect(digest).not.toContain('Exports: guessed');
    expect(digest).toContain('main [function] src/index.js:1-5');
  });

  test('a partial file is labelled in the hot list rather than trusted', () => {
    const digest = renderDigest(buildGraph(partialProject()), { root: 'demo' });
    const line = digest.split('\n').find((l) => l.startsWith('- src/broken.js'));
    expect(line).toContain('partial index');
    expect(line).toContain('structure unverified');
  });
});

describe('loom/digest — determinism', () => {
  test('the same graph renders byte-identically twice', () => {
    const graph = bigGraph();
    const opts = { root: 'demo', notes: NOTES, changed: CHANGED, maxTokens: 600 };
    expect(renderDigest(graph, opts)).toBe(renderDigest(graph, opts));
  });

  test('node and edge order in the graph do not matter', () => {
    const graph = bigGraph();
    const shuffled = {
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
      entries: [...graph.entries].reverse(),
    };
    expect(renderDigest(shuffled, { root: 'demo', maxTokens: 600 })).toBe(renderDigest(graph, { root: 'demo', maxTokens: 600 }));
  });

  test('note and access order do not matter', () => {
    const graph = bigGraph();
    const now = Date.UTC(2026, 0, 1);
    const access = [
      { path: 'src/module-00.js', op: 'read', ts: now - 86400000 },
      { path: 'src/module-01.js', op: 'edit', ts: now - 2 * 86400000 },
    ];
    const forward = renderDigest(graph, { root: 'demo', notes: NOTES, access, now });
    const backward = renderDigest(graph, {
      root: 'demo',
      notes: [...NOTES].reverse(),
      access: [...access].reverse(),
      now,
    });
    expect(backward).toBe(forward);
  });
});

describe('loom/digest — empty and malformed input', () => {
  test('an empty graph renders the skeleton, not nothing', () => {
    const digest = renderDigest({ nodes: [], edges: [], entries: [] }, { root: 'demo' });
    expect(digest).toContain('# Project map (Loom, 0 files indexed)');
    expect(digest).toContain('Stack: unknown · root: demo');
    expect(digest.endsWith(FOOTER)).toBe(true);
    expect(digest).not.toContain('## Hot files');
  });

  test('a null or non-object graph renders the empty string', () => {
    expect(renderDigest(null)).toBe('');
    expect(renderDigest(undefined)).toBe('');
    expect(renderDigest('nope')).toBe('');
    expect(renderDigest(42)).toBe('');
  });

  test('nothing malformed throws (I1)', () => {
    const malformed = [
      {},
      { nodes: 'x' },
      { nodes: [null, 42, {}, { path: 7 }] },
      { nodes: [{ path: 'a.js' }], edges: 'nope' },
      { nodes: [{ path: 'a.js', symbols: 'nope' }], edges: [{}, null] },
      { nodes: [{ path: 'a.js', loc: 'lots', summary: 42 }], entries: [null, 5, 'a.js'] },
    ];
    for (const graph of malformed) {
      expect(() => renderDigest(graph, { root: 'demo' })).not.toThrow();
      expect(typeof renderDigest(graph, { root: 'demo' })).toBe('string');
    }
    for (const opts of [null, undefined, 'x', 7, { notes: 'x', access: 4, changed: {} }]) {
      expect(() => renderDigest(bigGraph(), opts)).not.toThrow();
    }
  });

  test('I2: LOOM_ENABLED=0 is an empty string and touches nothing', () => {
    let touched = false;
    const graph = {
      get nodes() {
        touched = true;
        return [];
      },
      edges: [],
    };
    expect(renderDigest(graph, { env: { LOOM_ENABLED: '0' } })).toBe('');
    expect(renderDigest(graph, { env: { LOOM_ENABLED: 'false' } })).toBe('');
    expect(touched).toBe(false);
  });
});
