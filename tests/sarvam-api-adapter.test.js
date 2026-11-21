// tests/sarvam-adapter.test.js — Sarvam AI is an API, not a chat UI.
//
// Unlike the eight browser adapters, Sarvam is an OpenAI-compatible HTTP
// endpoint (https://api.sarvam.ai/v1). These tests pin the parts that go wrong
// silently: the endpoint being overridden by a leftover OLLAMA_BASE_URL, the
// key being dropped, and the model defaulting to a deprecated id.
'use strict';

const SarvamApiAdapter = require('../src/adapters/sarvam-api-adapter');
const factory = require('../src/adapter-factory');

function build(extra = {}) {
  const adapter = factory.getAdapter('sarvam-api', null, { SARVAM_API_KEY: 'test-key', ...extra });
  return adapter;
}

describe('Sarvam adapter', () => {
  let adapter;

  afterEach(() => {
    try { if (adapter && adapter._server) adapter._server.close(); } catch (_) { /* ignore */ }
  });

  test('is registered separately from the chat UI', () => {
    expect(factory.getModelDisplayName('sarvam-api')).toBe('Sarvam AI (API)');
    expect(factory.getModelDisplayName('sarvam105b')).toBe('Sarvam AI (API)');
    // The plain name belongs to the browser-driven UI adapter.
    expect(factory.getModelDisplayName('sarvam')).toBe('Sarvam AI (Indus)');
  });

  test('points at the Sarvam endpoint', () => {
    adapter = build();
    expect(adapter._ollamaBaseUrl).toBe(SarvamApiAdapter.BASE_URL);
    expect(adapter.getModelUrl()).toBe(SarvamApiAdapter.BASE_URL);
  });

  test('a leftover OLLAMA_BASE_URL cannot redirect Sarvam traffic', () => {
    // This is the failure that would send prompts to a stranger's tunnel.
    const previous = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'https://someone-else.ngrok.app';
    try {
      adapter = build();
      expect(adapter._ollamaBaseUrl).toBe(SarvamApiAdapter.BASE_URL);
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = previous;
    }
  });

  test('defaults to the current flagship model, not the deprecated one', () => {
    adapter = build();
    expect(adapter._model).toBe('sarvam-105b');
    expect(adapter._model).not.toBe('sarvam-m');
  });

  test('the key is taken from SARVAM_API_KEY', () => {
    adapter = build();
    expect(adapter._ollamaApiKey).toBe('test-key');
  });

  test('OLLAMA_API_KEY still works as a fallback', () => {
    adapter = factory.getAdapter('sarvam-api', null, { OLLAMA_API_KEY: 'fallback-key' });
    expect(adapter._ollamaApiKey).toBe('fallback-key');
  });

  test('the model can be overridden', () => {
    adapter = build({ SARVAM_MODEL: 'sarvam-105b-conversations' });
    expect(adapter._model).toBe('sarvam-105b-conversations');
  });

  test('it is a distinct adapter, not a rebadged colab tunnel', () => {
    adapter = build();
    expect(adapter.constructor.name).toBe('SarvamApiAdapter');
    expect(adapter._isSarvam).toBe(true);
  });

  test('the documented models are the ones the API still serves', () => {
    // Sarvam-M was deprecated; shipping it as a default would fail on first use.
    expect(SarvamApiAdapter.DEFAULT_MODEL).toBe('sarvam-105b');
  });
});
