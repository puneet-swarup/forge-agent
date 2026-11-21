// tests/loom/extract.test.js — spec §4.2–§4.5.
//
// The extractors are the layer that decides what the digest can say, so the
// tests are about the two ways they can be wrong: a *missing* symbol (a regex
// that did not match) and a *wrong range* (a brace counter that ran into a
// string). The second is worse — a range that points at the wrong lines would
// present code that is not there — so several cases below are fixtures copied
// from the shapes this repository actually contains: selector strings full of
// braces, templates with `${ … }`, comments with `{`, and Rust lifetimes.

'use strict';

const fs = require('fs');
const path = require('path');

const extract = require('../../src/loom/extract');
const blocks = require('../../src/loom/extract/blocks');
const js = require('../../src/loom/extract/js');

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const SYMBOL_KINDS = new Set(['function', 'class', 'method', 'const', 'type', 'export', 'heading', 'table', 'key']);
const IMPORT_KINDS = new Set(['require', 'import', 'from', 'use', 'mod']);

function byName(symbols, name) {
  const found = symbols.filter((s) => s.name === name);
  return found.length === 1 ? found[0] : found;
}

describe('loom/extract — registry', () => {
  test('extensionOf reads the last dot of the basename only', () => {
    expect(extract.extensionOf('src/loom/db.js')).toBe('.js');
    expect(extract.extensionOf('src\\loom\\db.ts')).toBe('.ts');
    expect(extract.extensionOf('archive.tar.gz')).toBe('.gz');
    expect(extract.extensionOf('Makefile')).toBe('');
    expect(extract.extensionOf('.gitignore')).toBe('');
    expect(extract.extensionOf('trailing.')).toBe('');
    expect(extract.extensionOf('')).toBe('');
    expect(extract.extensionOf(null)).toBe('');
  });

  test('langFor names every registered language', () => {
    expect(extract.langFor('a.js')).toBe('javascript');
    expect(extract.langFor('a.mjs')).toBe('javascript');
    expect(extract.langFor('a.cjs')).toBe('javascript');
    expect(extract.langFor('a.jsx')).toBe('javascript');
    expect(extract.langFor('a.ts')).toBe('typescript');
    expect(extract.langFor('a.tsx')).toBe('typescript');
    expect(extract.langFor('a.py')).toBe('python');
    expect(extract.langFor('a.go')).toBe('go');
    expect(extract.langFor('a.rs')).toBe('rust');
    expect(extract.langFor('a.sql')).toBe('sql');
    expect(extract.langFor('a.md')).toBe('markdown');
    expect(extract.langFor('a.json')).toBe('json');
    expect(extract.langFor('a.yaml')).toBe('yaml');
    expect(extract.langFor('a.yml')).toBe('yaml');
    expect(extract.langFor('a.toml')).toBe('toml');
  });

  test('an unregistered extension is skipped, not an error', () => {
    expect(extract.isSupported('notes.txt')).toBe(false);
    expect(extract.langFor('notes.txt')).toBeNull();
    const result = extract.extract('one\ntwo\nthree', 'notes.txt');
    expect(result.supported).toBe(false);
    expect(result.lang).toBeNull();
    expect(result.symbols).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.loc).toBe(3);
    expect(result.partial).toBe(false);
  });

  test('supportedExtensions is sorted and complete', () => {
    const extensions = extract.supportedExtensions();
    expect(extensions).toEqual([...extensions].sort());
    expect(extensions).toContain('.js');
    expect(extensions).toContain('.toml');
    expect(extensions).toHaveLength(Object.keys(extract.REGISTRY).length);
  });

  test('extract never throws, even on nonsense input', () => {
    for (const value of [undefined, null, 42, '', '\u0000\u0000', '}{}{}{', '#'.repeat(1000)]) {
      const result = extract.extract(value, 'a.js');
      expect(Array.isArray(result.symbols)).toBe(true);
      expect(Array.isArray(result.imports)).toBe(true);
      expect(typeof result.loc).toBe('number');
    }
  });

  test('a parser failure is reported as partial, not thrown (I1)', () => {
    const registry = extract.REGISTRY['.js'];
    const original = registry.module.extract;
    registry.module.extract = () => { throw new Error('boom'); };
    try {
      const result = extract.extract('const a = 1;', 'a.js');
      expect(result.supported).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.error).toBe('boom');
      expect(result.symbols).toEqual([]);
    } finally {
      registry.module.extract = original;
    }
  });

  test('loc counts lines and ignores a single trailing newline', () => {
    expect(extract.extract('', 'a.js').loc).toBe(0);
    expect(extract.extract('a', 'a.js').loc).toBe(1);
    expect(extract.extract('a\n', 'a.js').loc).toBe(1);
    expect(extract.extract('a\nb', 'a.js').loc).toBe(2);
    expect(extract.extract('a\nb\n', 'a.js').loc).toBe(2);
    expect(extract.extract('\n', 'a.js').loc).toBe(1);
  });
});

describe('loom/extract/blocks — findBlockEnd', () => {
  test('a balanced block ends on the closing brace', () => {
    const text = 'function f() {\n  if (a) {\n    b();\n  }\n}\n';
    expect(blocks.findBlockEnd(text, 1)).toEqual({ line_end: 5, confidence: 0.95, partial: false });
  });

  test('braces inside single and double quoted strings do not count', () => {
    const text = [
      'function f() {',
      '  const a = "}}}";',
      "  const b = '{{{';",
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(4);
  });

  test('a brace in a template literal does not count, but ${ … } is code', () => {
    const text = [
      'function f() {',
      '  const t = `a { b ${ { x: 1 } } c`;',
      '  return t;',
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(4);
  });

  test('an escaped quote does not end a string', () => {
    const text = [
      'function f() {',
      "  const s = 'it\\'s { not a block }';",
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(3);
  });

  test('a line comment ends at the newline', () => {
    const text = [
      'function f() {',
      '  // a comment with { and }',
      '  return 1;',
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(4);
  });

  test('a block comment is skipped whole', () => {
    const text = [
      'function f() {',
      '  /* {',
      '     } */',
      '  return 1;',
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(5);
  });

  test('a nested function does not end the outer block', () => {
    const text = [
      'class A {',
      '  m() {',
      '    function inner() { return 1; }',
      '  }',
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(5);
    expect(blocks.findBlockEnd(text, 2).line_end).toBe(4);
  });

  test('an unbalanced block falls back to start + 40 with low confidence', () => {
    const text = ['function f() {', '  return 1;'].join('\n');
    const result = blocks.findBlockEnd(text, 1);
    expect(result.partial).toBe(true);
    expect(result.confidence).toBe(0.4);
    expect(result.line_end).toBe(Math.min(41, 2));
  });

  test('the fallback is capped by the file length', () => {
    const text = ['function f() {', 'a', 'b'].join('\n');
    expect(blocks.findBlockEnd(text, 1).line_end).toBe(3);
  });

  test('a block that stays open past 400 lines gives up', () => {
    const body = new Array(500).fill('  x();').join('\n');
    const text = `function f() {\n${body}\n}`;
    const result = blocks.findBlockEnd(text, 1);
    expect(result.partial).toBe(true);
    expect(result.confidence).toBe(0.4);
    expect(result.line_end).toBe(41);
  });

  test('a start line past the end of the file is a fallback, not a crash', () => {
    const result = blocks.findBlockEnd('a\nb', 99);
    expect(result.partial).toBe(true);
    expect(blocks.findBlockEnd('', 1).partial).toBe(true);
  });

  test('a Go raw string is not a template (interpolation off)', () => {
    const text = [
      'func f() {',
      '  s := `a ${ b { c`',
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1, 3, { interpolation: false }).line_end).toBe(3);
  });

  test('a Rust lifetime does not open a character literal', () => {
    const text = [
      'fn f<\'a>(p: &\'a str) {',
      '  if true { 1 } else { 2 }',
      '}',
    ].join('\n');
    expect(blocks.findBlockEnd(text, 1, 3, { lifetimes: true }).line_end).toBe(3);
  });

  test('line helpers agree with each other', () => {
    const text = 'one\ntwo\nthree\n';
    const starts = blocks.buildLineStarts(text);
    expect(starts).toEqual([0, 4, 8, 14]);
    expect(blocks.lineOfIndex(starts, 0)).toBe(1);
    expect(blocks.lineOfIndex(starts, 4)).toBe(2);
    expect(blocks.lineOfIndex(starts, 13)).toBe(3);
    expect(blocks.lineText(text, starts, 2)).toBe('two');
    expect(blocks.lineText(text, starts, 99)).toBe('');
    expect(blocks.countLines(text)).toBe(3);
    expect(blocks.indentOf('    x')).toBe(4);
    expect(blocks.indentOf('\tx')).toBe(1);
  });
});

describe('loom/extract/js — JavaScript and TypeScript', () => {
  const result = js.extract(read('selectors.js'), 'tests/loom/fixtures/selectors.js');

  test('finds classes, functions, methods, consts and types', () => {
    const names = result.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('class:BaseAdapter');
    expect(names).toContain('function:topLevel');
    expect(names).toContain('method:send');
    expect(names).toContain('method:create');
    expect(names).toContain('method:ready');
    expect(names).toContain('const:withDefaults');
    expect(names).toContain('const:MAX_RETRIES');
    expect(names).toContain('const:SELECTORS');
    expect(names).toContain('const:PURE');
  });

  test('braces inside strings, templates and comments do not break a range', () => {
    const klass = byName(result.symbols, 'BaseAdapter');
    const send = byName(result.symbols, 'send');
    const lines = read('selectors.js').split('\n');
    // The class opens on its `class` line and closes on the last `}`.
    expect(lines[klass.line_start - 1]).toContain('class BaseAdapter');
    expect(lines[klass.line_end - 1]).toBe('}');
    expect(lines[send.line_end - 1]).toBe('  }');
    expect(result.partial).toBe(false);
    expect(klass.confidence).toBe(0.95);
  });

  test('a method knows its enclosing class', () => {
    expect(byName(result.symbols, 'send').parent).toBe('BaseAdapter');
    expect(byName(result.symbols, 'create').parent).toBe('BaseAdapter');
    expect(byName(result.symbols, 'topLevel').parent).toBe('');
  });

  test('control keywords are never methods', () => {
    const methods = result.symbols.filter((s) => s.kind === 'method').map((s) => s.name);
    for (const keyword of ['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor']) {
      expect(methods).not.toContain(keyword);
    }
  });

  test('exported is set by the export keyword, module.exports and exports.x', () => {
    expect(byName(result.symbols, 'BaseAdapter').exported).toBe(1);
    expect(byName(result.symbols, 'topLevel').exported).toBe(1);
    expect(byName(result.symbols, 'withDefaults').exported).toBe(1);
    expect(byName(result.symbols, 'MAX_RETRIES').exported).toBe(0);
  });

  test('doc is the preceding block comment or // run, first sentence only', () => {
    expect(byName(result.symbols, 'BaseAdapter').doc).toBe('Base adapter.');
    expect(byName(result.symbols, 'send').doc).toBe('Type into the composer.');
    expect(byName(result.symbols, 'SELECTORS').doc).toBe('Adapter selectors.');
    expect(byName(result.symbols, 'topLevel').doc).toBe('');
  });

  test('signature is the declaration line, trimmed and bounded', () => {
    const send = byName(result.symbols, 'send');
    expect(send.signature).toBe('async send(text) {');
    for (const symbol of result.symbols) {
      expect(symbol.signature.length).toBeLessThanOrEqual(200);
      expect(symbol.signature).not.toMatch(/^\s/);
    }
  });

  test('an arrow with a block body spans the block, without one it is one line', () => {
    const withBlock = byName(result.symbols, 'withDefaults');
    expect(withBlock.line_end).toBeGreaterThan(withBlock.line_start);
    const withoutBlock = byName(result.symbols, 'PURE');
    expect(withoutBlock.line_end).toBe(withoutBlock.line_start);
  });

  test('imports are collected with their kind, once each', () => {
    const text = [
      "const a = require('./a');",
      "const b = require('./a');",
      "import c from './c';",
      "import './side-effect';",
      "export * from './d';",
    ].join('\n');
    const imports = js.extract(text, 'x.js').imports;
    expect(imports).toEqual([
      { specifier: './a', kind: 'require' },
      { specifier: './c', kind: 'import' },
      { specifier: './side-effect', kind: 'import' },
      { specifier: './d', kind: 'import' },
    ]);
  });

  test('TypeScript interfaces and types are found', () => {
    const ts = extract.extract(read('config.ts'), 'config.ts');
    expect(ts.lang).toBe('typescript');
    expect(ts.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['Config', 'Mode', 'Store']));
    expect(ts.symbols.find((s) => s.name === 'Config').kind).toBe('type');
    expect(ts.symbols.find((s) => s.name === 'Store').exported).toBe(1);
  });

  test('symbols are sorted by line', () => {
    const starts = result.symbols.map((s) => s.line_start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('loom/extract/py — Python', () => {
  const result = extract.extract(read('module.py'), 'module.py');

  test('finds classes and functions with indentation block ends', () => {
    const names = result.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('class:Runner');
    expect(names).toContain('method:run');
    expect(names).toContain('method:__init__');
    expect(names).toContain('function:main');
    expect(names).toContain('function:tail');
  });

  test('a method ends before the next method at the same indent', () => {
    const run = byName(result.symbols, 'run');
    const stop = byName(result.symbols, 'stop');
    expect(run.parent).toBe('Runner');
    expect(run.line_end).toBeLessThan(stop.line_start);
    expect(run.line_end).toBe(12); // the last content line, not the blank after it
    expect(stop.line_end).toBeLessThanOrEqual(result.loc);
  });

  test('a top-level function ends before the next one', () => {
    const main = byName(result.symbols, 'main');
    expect(main.line_end).toBe(18);
    expect(main.line_end).toBeLessThan(byName(result.symbols, 'tail').line_start);
  });

  test('from and import both resolve to their own kind, comma lists split', () => {
    expect(result.imports).toEqual([
      { specifier: 'os', kind: 'import' },
      { specifier: 'sys', kind: 'import' },
      { specifier: 'pathlib', kind: 'from' },
    ]);
  });

  test('a # comment above a definition becomes its doc', () => {
    expect(byName(result.symbols, 'Runner').doc).toBe('The runner.');
  });

  test('decorators and async def are both recognised', () => {
    const text = '@app.route("/")\nasync def handler():\n    pass\n';
    const found = extract.extract(text, 'x.py').symbols;
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('handler');
  });
});

describe('loom/extract/go — Go', () => {
  const result = extract.extract(read('server.go'), 'server.go');

  test('finds functions (with receivers) and types', () => {
    const names = result.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:Serve');
    expect(names).toContain('function:main');
    expect(names).toContain('type:Handler');
  });

  test('a brace in a string does not end the function early', () => {
    const serve = byName(result.symbols, 'Serve');
    expect(serve.line_end).toBe(serve.line_start + 2);
    expect(result.partial).toBe(false);
  });

  test('single and block imports are both collected', () => {
    expect(result.imports).toEqual([
      { specifier: 'fmt', kind: 'import' },
      { specifier: 'strings', kind: 'import' },
      { specifier: 'os', kind: 'import' },
    ]);
  });
});

describe('loom/extract/rs — Rust', () => {
  const result = extract.extract(read('lib.rs'), 'lib.rs');

  test('finds functions and types', () => {
    const names = result.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:compute');
    expect(names).toContain('type:Point');
  });

  test('a lifetime does not swallow the block', () => {
    const compute = byName(result.symbols, 'compute');
    expect(compute.line_end).toBe(result.loc);
    expect(compute.confidence).toBe(0.95);
    expect(result.partial).toBe(false);
  });

  test('use and mod are both collected', () => {
    expect(result.imports).toEqual([
      { specifier: 'std::fmt', kind: 'use' },
      { specifier: 'util', kind: 'mod' },
    ]);
  });
});

describe('loom/extract/sql — SQL', () => {
  const result = extract.extract(read('schema.sql'), 'schema.sql');

  test('finds tables and views, case-insensitively', () => {
    expect(result.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'table:users',
      'table:v_users',
      'table:open_ended',
    ]);
  });

  test('a terminated statement ends on its semicolon', () => {
    expect(byName(result.symbols, 'users').line_end).toBe(4);
    expect(byName(result.symbols, 'v_users').line_end).toBe(6);
  });

  test('an unterminated statement is flagged partial with low confidence', () => {
    const open = byName(result.symbols, 'open_ended');
    expect(open.confidence).toBe(0.4);
    expect(result.partial).toBe(true);
  });
});

describe('loom/extract/md — Markdown', () => {
  const text = '# Title\n\n## Section\n\n### Deep\n\n#### Not indexed\n';

  test('levels 1-3 are headings, level 4 is not', () => {
    const result = extract.extract(text, 'notes.md');
    expect(result.symbols.map((s) => s.name)).toEqual(['Title', 'Section', 'Deep']);
    expect(result.symbols.every((s) => s.kind === 'heading')).toBe(true);
  });

  test('a heading has no body range and a trailing hash is stripped', () => {
    const result = extract.extract('## Closed ##\nbody\n', 'notes.md');
    expect(result.symbols[0].name).toBe('Closed');
    expect(result.symbols[0].line_start).toBe(1);
    expect(result.symbols[0].line_end).toBe(1);
  });

  test('a hash without a space is not a heading', () => {
    expect(extract.extract('#nope\n', 'notes.md').symbols).toEqual([]);
  });
});

describe('loom/extract/data — JSON, YAML, TOML', () => {
  test('JSON reports top-level keys only', () => {
    const result = extract.extract(read('package.json'), 'package.json');
    expect(result.symbols.map((s) => s.name)).toEqual(['name', 'version', 'scripts', 'nested']);
    expect(result.symbols.every((s) => s.kind === 'key')).toBe(true);
    expect(result.symbols[0].line_start).toBe(2);
  });

  test('YAML reports keys at column 0 only', () => {
    const result = extract.extract(read('config.yaml'), 'config.yaml');
    expect(result.symbols.map((s) => s.name)).toEqual(['name', 'version', 'nested', 'list']);
  });

  test('TOML reports top-level keys and section headers', () => {
    const result = extract.extract(read('pyproject.toml'), 'pyproject.toml');
    expect(result.symbols.map((s) => s.name)).toEqual(['title', 'build-system', 'tool.black']);
  });

  test('malformed JSON is still scanned, not thrown on', () => {
    const result = extract.extract('{\n  "a": 1,\n  "b": {\n', 'broken.json');
    expect(result.symbols.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.partial).toBe(false);
  });
});

describe('loom/extract — shape contract over every fixture', () => {
  const fixtures = fs.readdirSync(FIXTURES).filter((name) => fs.statSync(path.join(FIXTURES, name)).isFile());

  test.each(fixtures)('%s produces valid rows', (name) => {
    const result = extract.extract(read(name), name);
    expect(result.supported).toBe(true);
    expect(typeof result.partial).toBe('boolean');
    for (const symbol of result.symbols) {
      expect(SYMBOL_KINDS.has(symbol.kind)).toBe(true);
      expect(symbol.name).toBeTruthy();
      expect(Number.isInteger(symbol.line_start)).toBe(true);
      expect(Number.isInteger(symbol.line_end)).toBe(true);
      expect(symbol.line_start).toBeGreaterThanOrEqual(1);
      expect(symbol.line_end).toBeGreaterThanOrEqual(symbol.line_start);
      expect(symbol.line_end).toBeLessThanOrEqual(result.loc);
      expect(typeof symbol.signature).toBe('string');
      expect([0, 1]).toContain(symbol.exported);
      expect(typeof symbol.parent).toBe('string');
      expect(typeof symbol.doc).toBe('string');
      expect(symbol.doc.length).toBeLessThanOrEqual(160);
      expect(symbol.confidence).toBeGreaterThan(0);
      expect(symbol.confidence).toBeLessThanOrEqual(1);
    }
    for (const imported of result.imports) {
      expect(IMPORT_KINDS.has(imported.kind)).toBe(true);
      expect(typeof imported.specifier).toBe('string');
      expect(imported.specifier.length).toBeGreaterThan(0);
    }
  });
});

describe('loom/extract — over this repository’s own source', () => {
  const ROOT = path.join(__dirname, '..', '..', 'src');

  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, out);
      else out.push(abs);
    }
    return out;
  }

  const files = walk(ROOT).filter((file) => file.endsWith('.js'));

  test('every source file is scanned without throwing, and every range is in bounds', () => {
    let symbols = 0;
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const result = extract.extract(fs.readFileSync(file, 'utf8'), rel);
      symbols += result.symbols.length;
      for (const symbol of result.symbols) {
        expect(symbol.line_start).toBeGreaterThanOrEqual(1);
        expect(symbol.line_end).toBeGreaterThanOrEqual(symbol.line_start);
        expect(symbol.line_end).toBeLessThanOrEqual(result.loc);
      }
    }
    expect(files.length).toBeGreaterThan(50);
    expect(symbols).toBeGreaterThan(500);
  });

  test('real symbols are found where they live', () => {
    const transport = extract.extract(fs.readFileSync(path.join(ROOT, 'transport.js'), 'utf8'), 'transport.js');
    expect(transport.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(['encodeTransportArg', 'decodeTransportArg']),
    );

    const base = extract.extract(fs.readFileSync(path.join(ROOT, 'adapters', 'base-adapter.js'), 'utf8'), 'adapters/base-adapter.js');
    const klass = byName(base.symbols, 'BaseAdapter');
    expect(klass.kind).toBe('class');
    // The class range is the 40-line placeholder (see the next test), so only
    // methods inside that window get a parent — a real, documented consequence.
    expect(byName(base.symbols, '_getInputSelectors').parent).toBe('BaseAdapter');
    expect(base.symbols.filter((s) => s.parent === 'BaseAdapter').length).toBeGreaterThan(5);
  });

  test('the spec’s 400-line cap is what marks a long block partial', () => {
    // base-adapter.js is ~813 lines: the class is longer than the spec's scan
    // budget, so the range is the 40-line placeholder and the file is partial.
    // That is the designed failure — a range that cannot be measured is never
    // served at digest confidence.
    const text = fs.readFileSync(path.join(ROOT, 'adapters', 'base-adapter.js'), 'utf8');
    const result = extract.extract(text, 'adapters/base-adapter.js');
    const klass = byName(result.symbols, 'BaseAdapter');
    expect(result.partial).toBe(true);
    expect(klass.confidence).toBe(0.4);
    expect(klass.line_end).toBe(klass.line_start + 40);
    expect(blocks.findBlockEnd(text, klass.line_start, result.loc, { maxScanLines: 100000 }).line_end).toBeGreaterThan(700);
  });
});
