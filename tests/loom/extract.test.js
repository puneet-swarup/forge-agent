// tests/loom/extract.test.js — spec §4.2–§4.5: the per-language extractors.
//
// The snippets are shaped like the code they will meet in the wild (a model
// adapter class with selector arrays full of braces and quotes, a Go server with
// a receiver method, a migration with a commented-out CREATE), because the
// failure modes of a regex extractor only show up in real shapes. The last two
// describes are the contract, not the language: unknown extensions degrade, and
// no input — however malformed — throws.

'use strict';

const registry = require('../../src/loom/extract');
const jsModule = require('../../src/loom/extract/js');

const { detect, extract } = registry;

/** Symbols by name, for terse assertions. */
const byName = (result) => Object.fromEntries(result.symbols.map((s) => [s.name, s]));
const names = (result) => result.symbols.map((s) => s.name);
const specifiers = (result) => result.imports.map((i) => i.specifier);

describe('extract — javascript / typescript', () => {
  const source = `'use strict';
/**
 * Shared base class for model adapters. Holds browser plumbing.
 */
class BaseAdapter {
  constructor(page) {
    this.page = page;
  }

  async sendMessage(text) {
    const template = \`hi \${this.name ? '{x}' : '}'} there\`;
    return template;
  }

  _waitForTextStable() {
    const selector = 'button[type="submit"] { }';
    /* a comment with } in it */
    return selector;
  }
}

function helper(a) {
  return a;
}

const buildPrompt = (task) => {
  return task;
};

const ONE_LINER = () => 1;

const SELECTORS = {
  input: 'textarea',
  send: 'button',
};

interface Options {
  retries: number;
}

type Mode = 'fast' | 'slow';

module.exports = { BaseAdapter, helper: helper };
`;

  const result = extract(source, 'src/adapters/base-adapter.js');

  test('finds classes, functions, methods, arrow consts and types', () => {
    const found = byName(result);
    expect(found.BaseAdapter.kind).toBe('class');
    expect(found.helper.kind).toBe('function');
    expect(found.sendMessage.kind).toBe('method');
    expect(found.buildPrompt.kind).toBe('const');
    expect(found.ONE_LINER.kind).toBe('const');
    expect(found.SELECTORS.kind).toBe('const');
    expect(found.Options.kind).toBe('type');
    expect(found.Mode.kind).toBe('type');
  });

  test('does not mistake control flow for methods', () => {
    expect(names(result)).not.toContain('if');
    expect(names(result)).not.toContain('constructor');
  });

  test('marks module.exports destructuring as exported', () => {
    const found = byName(result);
    expect(found.BaseAdapter.exported).toBe(1);
    expect(found.helper.exported).toBe(1);
    expect(found.buildPrompt.exported).toBe(0);
  });

  test('measures a class body to its closing brace, not to the first one', () => {
    const found = byName(result);
    expect(found.BaseAdapter.line_start).toBe(5);
    expect(found.BaseAdapter.line_end).toBe(20);
  });

  test('ignores braces inside strings, template literals and comments', () => {
    const found = byName(result);
    expect(found.sendMessage.line_start).toBe(10);
    expect(found.sendMessage.line_end).toBe(13);
    expect(found._waitForTextStable.line_start).toBe(15);
    expect(found._waitForTextStable.line_end).toBe(19);
    expect(result.partial).toBe(false);
  });

  test('attributes methods to their enclosing class', () => {
    const found = byName(result);
    expect(found.sendMessage.parent).toBe('BaseAdapter');
    expect(found._waitForTextStable.parent).toBe('BaseAdapter');
    expect(found.helper.parent).toBe('');
  });

  test('takes the first sentence of the leading doc comment', () => {
    expect(byName(result).BaseAdapter.doc).toBe('Shared base class for model adapters.');
  });

  test('keeps the signature to one trimmed line', () => {
    expect(byName(result).sendMessage.signature).toBe('async sendMessage(text) {');
  });

  test('reports the language, the line count and no imports for a file without any', () => {
    expect(result.lang).toBe('js');
    expect(result.loc).toBe(source.split('\n').length - 1);
    expect(result.imports).toEqual([]);
  });

  test('collects require, import and export-from specifiers once each', () => {
    const js = extract(
      [
        "const fs = require('fs');",
        "const { a } = require('./a');",
        "const again = require('./a');",
        "import path from 'node:path';",
        "import './side-effect.css';",
        "export { thing } from './thing';",
        "const lazy = await import('./lazy.js');",
      ].join('\n'),
      'src/mixed.js',
    );
    expect(specifiers(js)).toEqual(['fs', './a', 'node:path', './side-effect.css', './thing', './lazy.js']);
    expect(js.imports.find((i) => i.specifier === 'fs').kind).toBe('require');
    expect(js.imports.find((i) => i.specifier === 'node:path').kind).toBe('import');
  });

  test('marks an export keyword and an export list as exported', () => {
    const ts = extract(
      [
        'export function alpha() {}',
        'export const beta = () => 1;',
        'function gamma() {}',
        'export { gamma as delta };',
      ].join('\n'),
      'src/exports.ts',
    );
    const found = byName(ts);
    expect(found.alpha.exported).toBe(1);
    expect(found.beta.exported).toBe(1);
    expect(found.gamma.exported).toBe(1);
    expect(ts.lang).toBe('ts');
  });

  test('ends a one-line type alias on its own line', () => {
    const ts = extract(['type A = string;', 'const B = 1;'].join('\n'), 'src/a.ts');
    const found = byName(ts);
    expect(found.A.line_start).toBe(1);
    expect(found.A.line_end).toBe(1);
  });

  test('summarises a file with no doc comment by its exported surface', () => {
    const ts = extract(['export function alpha() {}', 'export function beta() {}'].join('\n'), 'src/s.ts');
    expect(ts.summary).toBe('Exports: alpha, beta.');
  });
});

describe('extract — findBlockEnd', () => {
  const lines = (...parts) => parts.join('\n');

  test('balances a body containing braces in strings', () => {
    const text = lines(
      'function f() {',
      "  const a = '{';",
      '  const b = "}";',
      '  return a + b;',
      '}',
    );
    expect(jsModule.findBlockEnd(text, 1).line_end).toBe(5);
  });

  test('balances a template literal with a nested ${} expression', () => {
    const text = lines(
      'function f(x) {',
      '  const s = `a ${ x ? { y: 1 } : c } b`;',
      '  return s;',
      '}',
    );
    expect(jsModule.findBlockEnd(text, 1).line_end).toBe(4);
  });

  test('ignores braces in line and block comments', () => {
    const text = lines(
      'function f() {',
      '  // } not the end',
      '  /* } nor this',
      '     } nor that */',
      '  return 1;',
      '}',
    );
    expect(jsModule.findBlockEnd(text, 1).line_end).toBe(6);
  });

  test('starts at the body brace, not at a default parameter object', () => {
    const text = lines(
      'function open(opts = {}) {',
      '  return opts;',
      '}',
    );
    expect(jsModule.findBlockEnd(text, 1).line_end).toBe(3);
  });

  test('starts at an object literal that is itself the declaration body', () => {
    const text = lines(
      'const COLUMNS = Object.freeze({',
      '  a: 1,',
      '});',
      'const NEXT = 2;',
    );
    expect(jsModule.findBlockEnd(text, 1).line_end).toBe(3);
  });

  test('gives up at min(line_start + 40, loc) when the braces never balance', () => {
    const text = lines('function broken() {', '  return 1;');
    const end = jsModule.findBlockEnd(text, 1);
    expect(end.closed).toBe(false);
    expect(end.line_end).toBe(2); // min(1 + 40, loc = 2)
  });

  test('gives up after 400 scanned lines', () => {
    const body = Array.from({ length: 500 }, (_, i) => `  const v${i} = ${i};`);
    const text = ['class Big {', ...body].join('\n');
    const end = jsModule.findBlockEnd(text, 1);
    expect(end.closed).toBe(false);
    expect(end.line_end).toBe(41);
  });

  test('drops the confidence of an unclosed symbol to 0.4 and flags the file partial', () => {
    const result = extract(['function broken() {', '  return 1;'].join('\n'), 'src/broken.js');
    expect(result.symbols[0].confidence).toBe(0.4);
    expect(result.partial).toBe(true);
  });
});

describe('extract — python', () => {
  const source = `"""Store helpers for the Loom index."""
import os
import sqlite3
from .paths import loom_dir
from pathlib import Path


class Store:
    """Wraps one index database."""

    def __init__(self, path):
        self.path = path

    def close(self):
        """Flush and close."""
        return True


# Opens a store, rebuilding a corrupt one.
def open_store(path):
    return Store(path)


async def refresh(store):
    return await store.refresh()


def _private_helper():
    return 1
`;

  const result = extract(source, 'src/store.py');

  test('finds module-level defs, async defs and classes', () => {
    const found = byName(result);
    expect(found.Store.kind).toBe('class');
    expect(found.open_store.kind).toBe('function');
    expect(found.refresh.kind).toBe('function');
    expect(found.__init__.kind).toBe('function');
  });

  test('ends a block at the first line that dedents to the def', () => {
    const found = byName(result);
    expect(found.Store.line_start).toBe(8);
    expect(found.Store.line_end).toBe(16);
    expect(found.open_store.line_start).toBe(20);
    expect(found.open_store.line_end).toBe(21);
  });

  test('attributes methods to their class', () => {
    expect(byName(result).close.parent).toBe('Store');
    expect(byName(result).open_store.parent).toBe('');
  });

  test('treats a leading underscore as private', () => {
    const found = byName(result);
    expect(found._private_helper.exported).toBe(0);
    expect(found.__init__.exported).toBe(0);
    expect(found.open_store.exported).toBe(1);
  });

  test('reads a docstring first, then a # comment', () => {
    const found = byName(result);
    expect(found.Store.doc).toBe('Wraps one index database.');
    expect(found.close.doc).toBe('Flush and close.');
    expect(found.open_store.doc).toBe('Opens a store, rebuilding a corrupt one.');
  });

  test('distinguishes from-imports from plain imports', () => {
    expect(specifiers(result)).toEqual(['os', 'sqlite3', '.paths', 'pathlib']);
    expect(result.imports.filter((i) => i.kind === 'from').map((i) => i.specifier)).toEqual([
      '.paths',
      'pathlib',
    ]);
  });

  test('summarises from the module docstring', () => {
    expect(result.summary).toBe('Store helpers for the Loom index.');
  });
});

describe('extract — go', () => {
  const source = `// Package loom builds the project index.
package loom

import (
	"encoding/json"
	"fmt"
)

import "os"

type Server struct {
	addr string
}

type (
	Heat  float64
	Entry struct {
		path string
	}
)

func New(addr string) *Server {
	return &Server{addr: addr}
}

func (s *Server) Handle(msg string) error {
	return fmt.Errorf("bad: %s", msg)
}
`;

  const result = extract(source, 'internal/server.go');

  test('finds funcs, receiver methods and types', () => {
    const found = byName(result);
    expect(found.New.kind).toBe('function');
    expect(found.Handle.kind).toBe('method');
    expect(found.Server.kind).toBe('type');
    expect(found.Heat.kind).toBe('type');
    expect(found.Entry.kind).toBe('type');
  });

  test('uses the receiver type as the method parent', () => {
    expect(byName(result).Handle.parent).toBe('Server');
    expect(byName(result).New.parent).toBe('');
  });

  test('follows Go capitalisation for exported names', () => {
    const found = byName(result);
    expect(found.Server.exported).toBe(1);
    expect(found.New.exported).toBe(1);
  });

  test('reads both import forms', () => {
    expect(specifiers(result)).toEqual(['encoding/json', 'fmt', 'os']);
  });

  test('ends a struct at its closing brace and a bare type on its own line', () => {
    const found = byName(result);
    expect(found.Server.line_start).toBe(11);
    expect(found.Server.line_end).toBe(13);
    expect(found.Heat.line_end).toBe(found.Heat.line_start);
  });

  test('summarises from the package comment', () => {
    expect(result.summary).toBe('Package loom builds the project index.');
  });
});

describe('extract — rust', () => {
  const source = `//! Crate docs for the index.
use std::collections::HashMap;
use crate::store::{Store, Entry};
mod digest;

/// A scored file.
pub struct Scored {
    pub path: String,
}

pub struct Marker;

enum Kind {
    A,
    B,
}

trait Sink {
    fn write(&self) -> usize;
}

impl Scored {
    /// Build one.
    pub fn new(path: String) -> Self {
        Self { path }
    }

    fn private(&self) -> u8 {
        1
    }
}

pub async fn digest(store: &Store) -> String {
    format!("{}", 1)
}
`;

  const result = extract(source, 'src/scored.rs');

  test('finds fns, structs, enums and traits', () => {
    const found = byName(result);
    expect(found.digest.kind).toBe('function');
    expect(found.Scored.kind).toBe('type');
    expect(found.Kind.kind).toBe('type');
    expect(found.Sink.kind).toBe('type');
  });

  test('treats pub as exported', () => {
    const found = byName(result);
    expect(found.digest.exported).toBe(1);
    expect(found.private.exported).toBe(0);
    expect(found.Kind.exported).toBe(0);
  });

  test('gives impl methods their type as parent', () => {
    expect(byName(result).new.parent).toBe('Scored');
    expect(byName(result).private.parent).toBe('Scored');
    expect(byName(result).digest.parent).toBe('');
  });

  test('records use and mod edges, without the trailing ::', () => {
    expect(specifiers(result)).toEqual(['std::collections::HashMap', 'crate::store', 'digest']);
    expect(result.imports.find((i) => i.specifier === 'digest').kind).toBe('mod');
  });

  test('ends a unit struct on its own line', () => {
    const found = byName(result);
    expect(found.Marker.line_start).toBe(found.Marker.line_end);
  });

  test('summarises from the crate doc comment', () => {
    expect(result.summary).toBe('Crate docs for the index.');
  });
});

describe('extract — sql', () => {
  const source = `-- 001: the initial Loom schema.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY);

CREATE VIEW hot_files AS SELECT * FROM files;

CREATE MATERIALIZED VIEW "public"."top_files" AS SELECT 1;

-- CREATE TABLE commented_out (id int);
`;

  const result = extract(source, 'migrations/001_init.sql');

  test('finds tables, views and materialized views', () => {
    expect(names(result)).toEqual(['meta', 'files', 'hot_files', 'public.top_files']);
    expect(result.symbols.every((s) => s.kind === 'table')).toBe(true);
  });

  test('measures the whole statement, up to its semicolon', () => {
    const found = byName(result);
    expect(found.meta.line_start).toBe(2);
    expect(found.meta.line_end).toBe(5);
    expect(found.files.line_end).toBe(found.files.line_start);
  });

  test('ignores a commented-out CREATE', () => {
    expect(names(result)).not.toContain('commented_out');
  });

  test('declares no imports', () => {
    expect(result.imports).toEqual([]);
  });

  test('takes the leading comment as the summary', () => {
    expect(result.summary).toBe('001: the initial Loom schema.');
  });
});

describe('extract — markdown', () => {
  const source = `# Loom

The index and its digest.

## Storage

See [the spec](../src/loom_specs.md) and [GitHub](https://github.com/x/y).

\`\`\`bash
# not a heading
[not a link](./nope.md)
\`\`\`

### Tables

Back to [storage](#storage) and [the readme](./README.md).
`;

  const result = extract(source, 'docs/LOOM.md');

  test('finds headings one to three levels deep', () => {
    expect(names(result)).toEqual(['Loom', 'Storage', 'Tables']);
    expect(result.symbols.every((s) => s.kind === 'heading')).toBe(true);
  });

  test('nests a heading under the nearest shallower one', () => {
    const found = byName(result);
    expect(found.Storage.parent).toBe('Loom');
    expect(found.Tables.parent).toBe('Storage');
  });

  test('records local links and skips external ones and anchors', () => {
    expect(specifiers(result)).toEqual(['../src/loom_specs.md', './README.md']);
    expect(result.imports.every((i) => i.kind === 'import')).toBe(true);
  });

  test('ignores headings and links inside fenced code blocks', () => {
    expect(names(result)).not.toContain('not a heading');
    expect(specifiers(result)).not.toContain('./nope.md');
  });

  test('uses the first h1 as the summary', () => {
    expect(result.summary).toBe('Loom');
  });

  test('treats a level-four heading as body text', () => {
    const deep = extract('# A\n#### Deep\n', 'docs/a.md');
    expect(names(deep)).toEqual(['A']);
  });
});

describe('extract — data files', () => {
  test('reads top-level JSON keys and no deeper', () => {
    const source = [
      '{',
      '  "name": "forge-agent",',
      '  "scripts": {',
      '    "test": "jest",',
      '    "build": "tsc"',
      '  },',
      '  "keywords": ["a", "b"],',
      '  "note": "a { brace in a string"',
      '}',
    ].join('\n');
    const result = extract(source, 'package.json');
    expect(names(result)).toEqual(['name', 'scripts', 'keywords', 'note']);
    expect(result.symbols.every((s) => s.kind === 'key')).toBe(true);
    expect(result.lang).toBe('json');
  });

  test('reads top-level YAML keys', () => {
    const source = ['# CI pipeline.', 'name: ci', 'on:', '  push:', '    branches: [main]', 'jobs:', '  test:', '    runs-on: ubuntu-latest'].join('\n');
    const result = extract(source, '.github/workflows/ci.yml');
    expect(names(result)).toEqual(['name', 'on', 'jobs']);
    expect(result.lang).toBe('yaml');
    expect(result.summary).toBe('CI pipeline.');
  });

  test('reads TOML sections and keys', () => {
    const source = ['# Rust manifest.', '[package]', 'name = "loom"', '', '[dependencies]', 'serde = { version = "1" }'].join('\n');
    const result = extract(source, 'Cargo.toml');
    expect(names(result)).toEqual(['package', 'name', 'dependencies', 'serde']);
    expect(result.lang).toBe('toml');
  });

  test('summarises a JSON file by its keys', () => {
    expect(extract('{\n  "a": 1\n}', 'x.json').summary).toBe('Keys: a.');
  });
});

describe('extract — registry', () => {
  test('detects a language from every registered extension', () => {
    const cases = {
      'a.js': 'js',
      'a.mjs': 'js',
      'a.cjs': 'js',
      'a.jsx': 'js',
      'a.ts': 'ts',
      'a.tsx': 'ts',
      'a.py': 'py',
      'a.go': 'go',
      'a.rs': 'rs',
      'a.sql': 'sql',
      'a.md': 'md',
      'a.json': 'json',
      'a.yaml': 'yaml',
      'a.yml': 'yaml',
      'a.toml': 'toml',
    };
    for (const [file, lang] of Object.entries(cases)) {
      expect(detect('', file)).toBe(lang);
    }
  });

  test('is case-insensitive about the extension', () => {
    expect(detect('', 'SRC/Main.PY')).toBe('py');
  });

  test('sniffs a shebang when there is no extension at all', () => {
    expect(detect('#!/usr/bin/env node\nconst a = 1;', 'bin/forge')).toBe('js');
    expect(detect('#!/usr/bin/env python3\nx = 1\n', 'bin/forge')).toBe('py');
  });

  test('returns null for an unknown extension', () => {
    expect(detect('hello', 'notes.txt')).toBeNull();
    expect(detect('hello', 'Makefile')).toBeNull();
    expect(detect('hello', '.gitignore')).toBeNull();
  });

  test('returns an empty result for an unknown extension, but still counts lines', () => {
    const result = extract('line one\nline two\n', 'notes.txt');
    expect(result).toEqual({
      lang: null,
      symbols: [],
      imports: [],
      summary: '',
      loc: 2,
      partial: false,
    });
  });

  test('dispatches to the module that owns the extension', () => {
    expect(extract('class A {}', 'a.ts').lang).toBe('ts');
    expect(names(extract('class A {}', 'a.ts'))).toEqual(['A']);
    expect(extract('def f():\n    pass\n', 'a.py').symbols[0].kind).toBe('function');
    expect(extract('CREATE TABLE t (id int);', 'a.sql').symbols[0].kind).toBe('table');
  });

  test('every symbol carries the §4.2 fields, in range', () => {
    const result = extract('export class A {\n  go() {}\n}\n', 'a.ts');
    for (const symbol of result.symbols) {
      expect(typeof symbol.name).toBe('string');
      expect(registry.KINDS).toContain(symbol.kind);
      expect(symbol.line_start).toBeGreaterThanOrEqual(1);
      expect(symbol.line_end).toBeGreaterThanOrEqual(symbol.line_start);
      expect(symbol.line_end).toBeLessThanOrEqual(result.loc);
      expect([0, 1]).toContain(symbol.exported);
      expect(typeof symbol.parent).toBe('string');
      expect(typeof symbol.doc).toBe('string');
      expect(symbol.confidence).toBeGreaterThan(0);
      expect(symbol.confidence).toBeLessThanOrEqual(1);
    }
    for (const imported of result.imports) {
      expect(registry.IMPORT_KINDS).toContain(imported.kind);
    }
  });

  test('handles an empty file', () => {
    expect(extract('', 'a.js')).toEqual({
      lang: 'js',
      symbols: [],
      imports: [],
      summary: '',
      loc: 0,
      partial: false,
    });
  });
});

describe('extract — malformed input degrades, never explodes', () => {
  const hostile = [
    '',
    '\n',
    'class {',
    'function',
    '{{{',
    '}}}',
    '`${',
    '"unterminated',
    "'''",
    '/*',
    '//',
    '```',
    'CREATE TABLE',
    '{"a":',
    '[]',
    'a:\n  - b',
    'def',
    'func',
    'use ::',
    'module.exports = {',
    'import',
    '\u0000\u0001\u0002',
    `${'x'.repeat(5000)}`,
    `${'('.repeat(500)}{`,
  ];

  const paths = [
    'a.js', 'a.ts', 'a.py', 'a.go', 'a.rs', 'a.sql', 'a.md', 'a.json', 'a.yaml', 'a.toml', 'a.unknownext',
  ];

  test('never throws, for any snippet and any extension', () => {
    for (const text of hostile) {
      for (const path of paths) {
        expect(() => extract(text, path)).not.toThrow();
        const result = extract(text, path);
        expect(Array.isArray(result.symbols)).toBe(true);
        expect(Array.isArray(result.imports)).toBe(true);
        expect(typeof result.summary).toBe('string');
        expect(typeof result.loc).toBe('number');
      }
    }
  });

  test('treats non-string input as empty rather than throwing', () => {
    for (const value of [undefined, null, 0, {}, [], () => {}]) {
      expect(() => extract(value, 'a.js')).not.toThrow();
      expect(extract(value, 'a.js').symbols).toEqual([]);
      expect(() => detect(value, 'a.js')).not.toThrow();
    }
  });

  test('treats a missing path as an unknown language', () => {
    expect(() => extract('const a = 1;', undefined)).not.toThrow();
    expect(detect('const a = 1;', undefined)).toBeNull();
  });

  test('keeps every range inside the file for malformed snippets', () => {
    for (const text of hostile) {
      for (const path of paths) {
        const result = extract(text, path);
        for (const symbol of result.symbols) {
          expect(symbol.line_start).toBeGreaterThanOrEqual(1);
          expect(symbol.line_end).toBeLessThanOrEqual(Math.max(result.loc, 1));
        }
      }
    }
  });
});
