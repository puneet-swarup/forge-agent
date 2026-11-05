// tests/streaming-display.test.js — P3.4 onChunk display-only streaming guard
'use strict';

const BaseAdapter = require('../src/adapters/base-adapter');

// Concrete test adapter that lets us script the DOM polling behaviour.
class ScriptedAdapter extends BaseAdapter {
  constructor(page, config, script) {
    super(page, config);
    this._script = script; // array of { text, generating } per tick
    this._tick = 0;
  }

  _getInputSelectors() { return []; }
  _getSendSelectors() { return []; }
  _getStopSelectors() { return []; }
  _getNewChatSelectors() { return []; }
  _getResponseSelectors() { return []; }
  getModelUrl() { return 'https://example.test'; }

  async _extractText() {
    const step = this._script[Math.min(this._tick, this._script.length - 1)];
    this._tick += 1;
    return step ? step.text : '';
  }

  async getGenerationState() {
    const step = this._script[Math.min(this._tick - 1, this._script.length - 1)];
    return !!(step && step.generating);
  }
}

function makePage() {
  return {
    async waitForTimeout() {
      // no-op; keeps the polling loop tight for tests
    },
  };
}

describe('P3.4 streaming onChunk display hook', () => {
  test('calls onChunk once per growth with monotonic deltas', async () => {
    const script = [
      { text: '', generating: true },
      { text: 'a', generating: true },
      { text: 'ab', generating: true },
      { text: 'abc', generating: true },
      { text: 'abc', generating: false },
      { text: 'abc', generating: false },
    ];
    const adapter = new ScriptedAdapter(makePage(), {
      STABLE_DELAY: 0,
      RESPONSE_TIMEOUT: 5_000,
      GENERATION_POLL: 1,
    }, script);

    const chunks = [];
    await adapter._waitForTextStable({
      containerSelectors: [],
      stableMs: 0,
      timeoutMs: 5_000,
      pollMs: 1,
      onChunk: (c) => chunks.push(c),
    });

    // Deltas should be 1, 1, 1 — never negative, never zero, never regressing.
    expect(chunks.map((c) => c.delta)).toEqual([1, 1, 1]);
    expect(chunks.map((c) => c.text)).toEqual(['a', 'ab', 'abc']);
  });

  test('onChunk is display-only: never short-circuits the wait', async () => {
    const script = [
      { text: 'x', generating: true },
      { text: 'xy', generating: true },
      { text: 'xyz', generating: true },
      { text: 'xyz', generating: false },
      { text: 'xyz', generating: false },
    ];
    const adapter = new ScriptedAdapter(makePage(), {
      STABLE_DELAY: 0,
      RESPONSE_TIMEOUT: 5_000,
      GENERATION_POLL: 1,
    }, script);

    let chunkCalls = 0;
    const final = await adapter._waitForTextStable({
      containerSelectors: [],
      stableMs: 0,
      timeoutMs: 5_000,
      pollMs: 1,
      onChunk: () => {
        chunkCalls += 1;
        // Even if a consumer throws, the wait must not break.
        if (chunkCalls === 2) throw new Error('consumer boom');
      },
    });

    expect(final).toBe('xyz');
    expect(chunkCalls).toBeGreaterThanOrEqual(2);
  });

  test('disabled path (no onChunk) returns the same text', async () => {
    const script = [
      { text: 'hello', generating: true },
      { text: 'hello world', generating: true },
      { text: 'hello world', generating: false },
      { text: 'hello world', generating: false },
    ];
    const adapter = new ScriptedAdapter(makePage(), {
      STABLE_DELAY: 0,
      RESPONSE_TIMEOUT: 5_000,
      GENERATION_POLL: 1,
    }, script);

    const final = await adapter._waitForTextStable({
      containerSelectors: [],
      stableMs: 0,
      timeoutMs: 5_000,
      pollMs: 1,
    });

    expect(final).toBe('hello world');
  });
});
