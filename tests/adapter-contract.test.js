// tests/adapter-contract.test.js — every adapter honours the common contract.
//
// T3 of the handoff lists qwen / gemini / google / local-chat as
// "broken". Checked against the code, all eight adapters implement the six
// contract methods (colab inherits them from local-chat, by design) — so the
// defect, if any, is in the selector VALUES against a live UI, which cannot be
// tested offline. What CAN be tested offline is the contract itself, and that is
// what this suite does: no empty lists, no duplicated selectors, no selector
// shared between the composer and the send button, a usable model URL, and
// selector strings that are structurally valid.
//
// The live check stays a human task: `forge-agent --test-model` against a real
// login, per adapter.
'use strict';

const path = require('path');
const fs = require('fs');

const ADAPTERS = [
  'deepseek', 'chatgpt', 'gemini', 'google', 'qwen', 'local-chat', 'colab',
];

const CONTRACT = [
  '_getInputSelectors',
  '_getSendSelectors',
  '_getStopSelectors',
  '_getNewChatSelectors',
  '_getResponseSelectors',
  'getModelUrl',
];

const ADAPTER_DIR = path.join(__dirname, '..', 'src', 'adapters');

function load(name) {
  const Adapter = require(path.join(ADAPTER_DIR, `${name}-adapter`));
  // A null page is fine: every method under test is pure configuration.
  const config = {
    DEEPSEEK_URL: 'https://example.test',
    LOCAL_CHAT_PORT: 1337,
    OLLAMA_BASE_URL: 'https://example.test',
    OLLAMA_MODEL: 'm',
  };
  return new Adapter(null, config);
}

/** Structural sanity for a CSS selector string. */
function looksLikeSelector(sel) {
  if (typeof sel !== 'string' || sel.trim() === '') return false;
  const pairs = [['[', ']'], ['(', ')']];
  for (const [open, close] of pairs) {
    const o = (sel.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const c = (sel.match(new RegExp(`\\${close}`, 'g')) || []).length;
    if (o !== c) return false;
  }
  if ((sel.match(/"/g) || []).length % 2 !== 0) return false;
  if ((sel.match(/'/g) || []).length % 2 !== 0) return false;
  return true;
}

describe.each(ADAPTERS)('%s adapter', (name) => {
  test('implements the six contract methods', () => {
    const adapter = load(name);
    for (const method of CONTRACT) {
      expect(typeof adapter[method]).toBe('function');
    }
  });

  test('every selector list is a non-empty array of plausible selectors', () => {
    const adapter = load(name);

    for (const method of CONTRACT.filter((m) => m.endsWith('Selectors'))) {
      const list = adapter[method]();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);

      for (const sel of list) {
        expect(typeof sel).toBe('string');
        expect(sel.trim()).not.toBe('');
        if (!looksLikeSelector(sel)) {
          throw new Error(`${name}.${method}() has a malformed selector: ${JSON.stringify(sel)}`);
        }
      }
    }
  });

  test('no selector is repeated within a list', () => {
    const adapter = load(name);
    for (const method of CONTRACT.filter((m) => m.endsWith('Selectors'))) {
      const list = adapter[method]();
      const dupes = list.filter((s, i) => list.indexOf(s) !== i);
      expect(dupes).toEqual([]);
    }
  });

  test('the composer and the send button never share a selector', () => {
    // If they did, "find the send button" could click into the composer and the
    // message would never be submitted.
    const adapter = load(name);
    const input = new Set(adapter._getInputSelectors());
    const overlap = adapter._getSendSelectors().filter((s) => input.has(s));
    expect(overlap).toEqual([]);
  });

  test('the response and stop selectors are disjoint', () => {
    // A stop button matched as a response container would be scraped as the reply.
    const adapter = load(name);
    const stop = new Set(adapter._getStopSelectors());
    const overlap = adapter._getResponseSelectors().filter((s) => stop.has(s));
    expect(overlap).toEqual([]);
  });

  test('getModelUrl returns a usable URL or explains what to configure', () => {
    const adapter = load(name);
    if (name === 'colab') {
      // Colab has no default endpoint on purpose (a personal tunnel used to be
      // shipped here); the adapter must resolve its own URL or complain.
      expect(() => adapter.getModelUrl()).not.toThrow();
      return;
    }
    const url = adapter.getModelUrl();
    expect(typeof url).toBe('string');
    expect(url).toMatch(/^(https?|file):\/\//);
  });
});

describe('adapter registry matches the adapter files', () => {
  test('every registry entry points at an adapter that loads', () => {
    const { SUPPORTED_MODELS } = require('../src/adapter-factory');
    for (const model of SUPPORTED_MODELS) {
      expect(() => require(`../src/adapter-factory`).getAdapter(model, null, {})).not.toThrow();
    }
  });

  test('every adapter file is referenced by a registry entry', () => {
    // Model names and file names differ on purpose (model "local" is served by
    // local-chat-adapter), so compare against the registry's adapter paths.
    const factory = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapter-factory.js'), 'utf8');
    const wired = new Set(
      [...factory.matchAll(/adapter:\s*'\.\/adapters\/([a-z-]+)'/g)].map((m) => m[1])
    );

    const files = fs.readdirSync(ADAPTER_DIR)
      .filter((f) => f.endsWith('-adapter.js'))
      .map((f) => f.replace(/\.js$/, ''));

    // base-adapter is the abstract base, not a model.
    const unregistered = files.filter((f) => f !== 'base-adapter' && !wired.has(f));
    expect(unregistered).toEqual([]);
    expect(wired.size).toBeGreaterThanOrEqual(7);
  });
});
