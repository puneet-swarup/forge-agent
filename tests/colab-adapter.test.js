// tests/colab-adapter.test.js - dedicated Colab/remote tunnel adapter
'use strict';

const ColabAdapter = require('../src/adapters/colab-adapter');
const LocalChatAdapter = require('../src/adapters/local-chat-adapter');
const BaseAdapter = require('../src/adapters/base-adapter');

function makeAdapter(config) {
  const page = { goto: jest.fn(), evaluate: jest.fn(), locator: jest.fn() };
  return new ColabAdapter(page, Object.assign({ LOCAL_CHAT_PORT: 0 }, config || {}));
}

const ENV_KEYS = ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'OLLAMA_MODEL', 'LOCAL_CHAT_PORT'];
const ORIG = {};
ENV_KEYS.forEach(k => { ORIG[k] = process.env[k]; });

afterEach(() => {
  ENV_KEYS.forEach(k => {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  });
});

describe('ColabAdapter', () => {
  test('extends LocalChatAdapter and BaseAdapter', () => {
    const a = makeAdapter();
    expect(a).toBeInstanceOf(LocalChatAdapter);
    expect(a).toBeInstanceOf(BaseAdapter);
  });

  test('is marked as a dedicated instance (no throttle)', () => {
    expect(ColabAdapter.DEDICATED_INSTANCE).toBe(true);
    expect(makeAdapter()._sendDelayMs()).toBe(0);
  });

  test('uses a remote URL from config', () => {
    const a = makeAdapter({ OLLAMA_BASE_URL: 'https://remote.example' });
    expect(a._ollamaBaseUrl).toBe('https://remote.example');
  });

  test('uses the API key from config', () => {
    const a = makeAdapter({ OLLAMA_API_KEY: 'abc123' });
    expect(a._ollamaApiKey).toBe('abc123');
  });

  test('env vars take precedence over config', () => {
    process.env.OLLAMA_BASE_URL = 'https://env.example';
    process.env.OLLAMA_API_KEY = 'envkey';
    const a = makeAdapter({ OLLAMA_BASE_URL: 'https://cfg.example', OLLAMA_API_KEY: 'cfgkey' });
    expect(a._ollamaBaseUrl).toBe('https://env.example');
    expect(a._ollamaApiKey).toBe('envkey');
  });

  test('_getOllamaEndpoint appends /v1/chat/completions', () => {
    const a = makeAdapter({ OLLAMA_BASE_URL: 'https://remote.example' });
    expect(a._getOllamaEndpoint().pathname).toBe('/v1/chat/completions');
  });

  test('_getOllamaEndpoint preserves an existing path', () => {
    const a = makeAdapter({ OLLAMA_BASE_URL: 'https://remote.example/api' });
    expect(a._getOllamaEndpoint().pathname).toBe('/api/v1/chat/completions');
  });

  test('_getOllamaEndpoint throws on an invalid URL', () => {
    const a = makeAdapter({ OLLAMA_BASE_URL: 'not a url' });
    expect(() => a._getOllamaEndpoint()).toThrow();
  });

  test('probe returns ok:false (never throws) for an invalid URL', async () => {
    const a = makeAdapter({ OLLAMA_BASE_URL: '::::bad' });
    const res = await a.probe();
    expect(res.ok).toBe(false);
  });

  test('probe returns ok:false when the endpoint is unreachable', async () => {
    const a = makeAdapter({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' });
    const res = await a.probe();
    expect(res.ok).toBe(false);
  });
});

describe('adapter factory registration for colab', () => {
  const factory = require('../src/adapter-factory');

  test('SUPPORTED_MODELS includes colab', () => {
    expect(factory.SUPPORTED_MODELS).toContain('colab');
  });

  test('resolves the colab aliases', () => {
    ['colab', 'tunnel', 'ngrok', 'remote-ollama'].forEach(alias => {
      expect(factory.resolveModelName(alias)).toBe('colab');
    });
  });

  test('colab is marked dedicated', () => {
    expect(factory.getModelInfo('colab').dedicated).toBe(true);
  });

  test('getAdapter returns a ColabAdapter', () => {
    const a = factory.getAdapter('colab', {}, { LOCAL_CHAT_PORT: 0 });
    expect(a).toBeInstanceOf(ColabAdapter);
  });

  test('ollama alias resolves to the local daemon adapter (not the proxy)', () => {
    expect(factory.resolveModelName('ollama')).toBe('ollama');
    const info = factory.getModelInfo('ollama');
    expect(info.adapter || info.url).toBeTruthy();
    const a = factory.getAdapter('ollama', {}, {});
    expect(a.constructor.name).toBe('OllamaAdapter');
  });

  test('local alias resolves to the generic proxy adapter', () => {
    expect(factory.resolveModelName('local')).toBe('local');
    expect(factory.resolveModelName('local-chat')).toBe('local');
    const a = factory.getAdapter('local', {}, { LOCAL_CHAT_PORT: 0 });
    expect(a).toBeInstanceOf(LocalChatAdapter);
  });
});
