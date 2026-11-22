// tests/adapter-template.test.js — the adapter layer is a template method, not
// six copies of the same loop.
//
// Before this refactor, discoverComposer / discoverSendButton /
// discoverLatestResponse were reimplemented in six adapters: 432 lines against
// 55 in the base class, all of which had to be kept in step by hand — and were
// not. Two of the copies had already drifted (ChatGPT returned the whole
// transcript; Sarvam returned the largest block).
//
// The rule now: the base class owns the algorithm, an adapter supplies selector
// lists and may override exactly one hook.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'adapters');
const ADAPTERS = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('-adapter.js') && f !== 'base-adapter.js');

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

describe('the base class owns discovery', () => {
  const base = read('base-adapter.js');

  test('it implements all three discovery methods', () => {
    expect(base).toContain('async discoverComposer(');
    expect(base).toContain('async discoverSendButton(');
    expect(base).toContain('async discoverLatestResponse(');
  });

  test('it declares a structural fallback hook', () => {
    expect(base).toContain('async _structuralFallback(');
  });

  test('each discovery consults the hook after its selectors', () => {
    for (const kind of ['input', 'send', 'response']) {
      expect(base).toContain(`_structuralFallback('${kind}')`);
    }
  });
});

describe('no adapter reimplements the algorithm', () => {
  for (const file of ADAPTERS) {
    test(`${file} does not duplicate discovery`, () => {
      const src = read(file);
      // A reimplementation is any of the three methods defined on the adapter.
      expect(src).not.toMatch(/async discoverComposer\s*\(/);
      expect(src).not.toMatch(/async discoverSendButton\s*\(/);
      expect(src).not.toMatch(/async discoverLatestResponse\s*\(/);
    });
  }
});

describe('adapters that need a structural fallback declare one', () => {
  const needsFallback = {
    'gemini-adapter.js': 'send',
    'sarvam-adapter.js': 'send',
    'chatgpt-adapter.js': 'response',
  };

  for (const [file, kind] of Object.entries(needsFallback)) {
    test(`${file} handles '${kind}'`, () => {
      const src = read(file);
      expect(src).toContain('_structuralFallback');
      expect(src).toContain(`'${kind}'`);
    });
  }

  test('adapters with no quirk do not invent a hook', () => {
    for (const file of ['deepseek-adapter.js', 'google-adapter.js', 'qwen-adapter.js']) {
      expect(read(file)).not.toContain('_structuralFallback');
    }
  });
});

describe('behaviour the refactor must not lose', () => {
  test('the base hook returns null by default, so no adapter gains magic', async () => {
    const BaseAdapter = require('../src/adapters/base-adapter');
    const instance = Object.create(BaseAdapter.prototype);
    await expect(instance._structuralFallback('send')).resolves.toBeNull();
  });

  test('every adapter still exposes its selector lists', () => {
    for (const file of ADAPTERS) {
      const Adapter = require(path.join(DIR, file));
      const proto = Adapter.prototype;
      for (const method of ['_getInputSelectors', '_getSendSelectors', '_getResponseSelectors']) {
        expect(typeof proto[method]).toBe('function');
        const list = Object.create(proto)[method]();
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─────────────────────────────────────────────
//  No duplicate method definitions
//
//  A class body silently accepts two methods with the same name and the last one
//  wins. That happened here: a patch added fixed selectors while the old ones
//  remained below them, so the "fix" never took effect and every test passed,
//  because the tests read the same file the runtime did.
// ─────────────────────────────────────────────

describe('no adapter defines a method twice', () => {
  const DIR = path.join(__dirname, '..', 'src', 'adapters');

  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('-adapter.js'))) {
    test(`${file} has no duplicate method names`, () => {
      const src = fs.readFileSync(path.join(DIR, file), 'utf8');

      // Method definitions at class-member indentation.
      const names = [...src.matchAll(/^\s{1,4}([a-zA-Z_]\w*)\s*\([^)]*\)\s*\{/gm)]
        .map((m) => m[1]);

      const seen = new Map();
      const duplicates = [];
      for (const name of names) {
        if (name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch') continue;
        const count = (seen.get(name) || 0) + 1;
        seen.set(name, count);
        if (count === 2) duplicates.push(name);
      }

      expect(duplicates).toEqual([]);
    });
  }
});
