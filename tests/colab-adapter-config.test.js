// tests/colab-adapter-config.test.js - local/Colab adapter configuration
'use strict';

const path = require('path');
const fs = require('fs');

describe('Colab / local adapter configuration', () => {
  const ORIG = Object.assign({}, process.env);
  const ENV_KEYS = ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'OLLAMA_MODEL', 'LOCAL_CHAT_PORT'];

  beforeEach(() => {
    ENV_KEYS.forEach(k => delete process.env[k]);
    jest.resetModules();
  });

  afterAll(() => {
    ENV_KEYS.forEach(k => {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    });
  });

  test('DEFAULTS expose the Colab adapter keys', () => {
    const DEFAULTS = require('../src/config').DEFAULTS;
    expect(DEFAULTS).toHaveProperty('OLLAMA_BASE_URL');
    expect(DEFAULTS).toHaveProperty('OLLAMA_API_KEY');
    expect(DEFAULTS).toHaveProperty('OLLAMA_MODEL');
    expect(DEFAULTS).toHaveProperty('LOCAL_CHAT_PORT');
  });

  test('OLLAMA_BASE_URL env var is picked up by the adapter', () => {
    process.env.OLLAMA_BASE_URL = 'https://example.ngrok-free.dev';
    process.env.OLLAMA_API_KEY = 'secret-key';
    const LocalChatAdapter = require('../src/adapters/local-chat-adapter');
    const a = new LocalChatAdapter({}, {});
    expect(a._ollamaBaseUrl).toBe('https://example.ngrok-free.dev');
    expect(a._ollamaApiKey).toBe('secret-key');
  });

  test('config values are used when env vars are absent', () => {
    const LocalChatAdapter = require('../src/adapters/local-chat-adapter');
    const a = new LocalChatAdapter({}, {
      OLLAMA_BASE_URL: 'https://cfg.example',
      OLLAMA_API_KEY: 'cfgkey',
      OLLAMA_MODEL: 'cfg-model',
    });
    expect(a._ollamaBaseUrl).toBe('https://cfg.example');
    expect(a._ollamaApiKey).toBe('cfgkey');
    expect(a._model).toBe('cfg-model');
  });

  test('adapter falls back to localhost when nothing is configured', () => {
    const LocalChatAdapter = require('../src/adapters/local-chat-adapter');
    const a = new LocalChatAdapter({}, {});
    expect(a._ollamaBaseUrl).toBe('http://localhost:11434');
    expect(a._ollamaApiKey).toBe('');
  });

  test('CLI --model-url / --api-key flags override via process.argv', () => {
    const savedArgv = process.argv.slice();
    process.argv.push('--model-url=https://flag.example', '--api-key=flagkey', '--local-model=flagmodel', '--local-port=1999');
    try {
      const config = require('../src/config');
      expect(config.OLLAMA_BASE_URL).toBe('https://flag.example');
      expect(config.OLLAMA_API_KEY).toBe('flagkey');
      expect(config.OLLAMA_MODEL).toBe('flagmodel');
      expect(config.LOCAL_CHAT_PORT).toBe(1999);
    } finally {
      process.argv.length = 0;
      process.argv.push.apply(process.argv, savedArgv);
    }
  });

  test('CLI aliases --ollama-url / --ollama-api-key are accepted', () => {
    const savedArgv = process.argv.slice();
    process.argv.push('--ollama-url', 'https://alias.example', '--ollama-api-key', 'alias-key');
    try {
      const config = require('../src/config');
      expect(config.OLLAMA_BASE_URL).toBe('https://alias.example');
      expect(config.OLLAMA_API_KEY).toBe('alias-key');
    } finally {
      process.argv.length = 0;
      process.argv.push.apply(process.argv, savedArgv);
    }
  });

  test('.env.example documents the Colab adapter variables', () => {
    const example = path.join(__dirname, '..', '.env.example');
    expect(fs.existsSync(example)).toBe(true);
    const body = fs.readFileSync(example, 'utf8');
    expect(body).toContain('OLLAMA_BASE_URL');
    expect(body).toContain('OLLAMA_API_KEY');
    expect(body).toContain('OLLAMA_MODEL');
  });
});
