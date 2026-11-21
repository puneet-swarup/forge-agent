// tests/test-model-cli.test.js — the selector test must be runnable against a
// real, logged-in session.
//
// `--test-model` used to force headless unconditionally. Google and ChatGPT
// frequently refuse a headless session that they accept visibly, so the test
// failed on a login wall — which says nothing about the selectors it exists to
// check. These are cheap structural checks on the wiring.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

describe('--test-model', () => {
  test('does not force headless', () => {
    expect(SRC).toContain('config.HEADLESS = !args.headed;');
    expect(SRC).not.toMatch(/config\.HEADLESS\s*=\s*true;\s*\/\/ Use headless for test/);
  });

  test('--headed is a real flag', () => {
    expect(SRC).toMatch(/case '--headed':\s+opts\.headed\s+=\s+true;/);
  });

  test('the help lists every model the test supports', () => {
    const help = SRC.slice(SRC.indexOf('--test-model=<n>'));
    for (const model of ['deepseek', 'qwen', 'chatgpt', 'gemini', 'google']) {
      expect(help.slice(0, 200)).toContain(model);
    }
  });

  test('every adapter inherits the selector test', () => {
    const base = require('../src/adapters/base-adapter');
    expect(typeof base.prototype.testSelectors).toBe('function');

    const dir = path.join(__dirname, '..', 'src', 'adapters');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('-adapter.js'))) {
      if (file === 'base-adapter.js') continue;
      const Adapter = require(path.join(dir, file));
      expect(typeof Adapter.prototype.testSelectors).toBe('function');
    }
  });
});
