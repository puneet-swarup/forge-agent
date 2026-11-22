// tests/ollama-adapter.test.js - local Ollama adapter (localhost:11434)
'use strict';

const OllamaAdapter = require('../src/adapters/ollama-adapter');
const BaseAdapter = require('../src/adapters/base-adapter');

function makeAdapter(config) {
 const page = {
 locator: jest.fn(),
 waitForTimeout: jest.fn(),
 keyboard: { press: jest.fn() },
 };
 return new OllamaAdapter(page, config || {});
}

describe('OllamaAdapter', () => {
 const OLD = process.env.OLLAMA_BASE_URL;
 const OLD_M = process.env.OLLAMA_MODEL;
 afterEach(() => {
 if (OLD === undefined) delete process.env.OLLAMA_BASE_URL;
 else process.env.OLLAMA_BASE_URL = OLD;
 if (OLD_M === undefined) delete process.env.OLLAMA_MODEL;
 else process.env.OLLAMA_MODEL = OLD_M;
 });

 test('extends BaseAdapter', () => {
 expect(makeAdapter()).toBeInstanceOf(BaseAdapter);
 });

 test('is marked as a dedicated instance', () => {
 expect(OllamaAdapter.DEDICATED_INSTANCE).toBe(true);
 });

 test('baseUrl defaults to localhost:11434', () => {
 delete process.env.OLLAMA_BASE_URL;
 expect(makeAdapter().baseUrl).toBe('http://localhost:11434');
 });

 test('baseUrl honours the OLLAMA_BASE_URL env var', () => {
 process.env.OLLAMA_BASE_URL = 'http://10.0.0.5:11434/';
 expect(makeAdapter().baseUrl).toBe('http://10.0.0.5:11434');
 });

 test('baseUrl honours config', () => {
 delete process.env.OLLAMA_BASE_URL;
 expect(makeAdapter({ OLLAMA_BASE_URL: 'http://box:11434' }).baseUrl)
 .toBe('http://box:11434');
 });

 test('modelName defaults to deepseek-r1:8b', () => {
 delete process.env.OLLAMA_MODEL;
 expect(makeAdapter().modelName).toBe('deepseek-r1:8b');
 });

 test('modelName honours config', () => {
 delete process.env.OLLAMA_MODEL;
 expect(makeAdapter({ OLLAMA_MODEL: 'qwen2.5-coder' }).modelName)
 .toBe('qwen2.5-coder');
 });

 test('dedicated instance applies NO inter-prompt throttle', () => {
 const a = makeAdapter({ SEND_DELAY: 5000 });
 expect(a._sendDelayMs()).toBe(0);
 });

 test('shared adapter still throttles', () => {
 const b = new BaseAdapter({}, { SEND_DELAY: 250 });
 expect(b._sendDelayMs()).toBe(250);
 });

 test('exposes selector lists', () => {
 const a = makeAdapter();
 expect(a._getInputSelectors().length).toBeGreaterThanOrEqual(2);
 expect(a._getSendSelectors().length).toBeGreaterThanOrEqual(2);
 expect(a._getStopSelectors().length).toBeGreaterThanOrEqual(1);
 expect(a._getResponseSelectors().length).toBeGreaterThanOrEqual(2);
 });

  test('getModelUrl returns the bundled chat page, not the API root', () => {
    // Port 11434 serves plain text ("Ollama is running") — a browser pointed at
    // it has no composer. A live diagnostic reported "NONE of 3 matched" against
    // a URL this repository chose itself.
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_UI_URL;

    const url = makeAdapter().getModelUrl();
    expect(url).toContain('local-ollama-chat.html');
    expect(url).not.toBe('http://localhost:11434');
  });

  test('OLLAMA_UI_URL overrides the bundled page', () => {
    process.env.OLLAMA_UI_URL = 'http://localhost:3000';
    try {
      expect(makeAdapter().getModelUrl()).toBe('http://localhost:3000');
    } finally {
      delete process.env.OLLAMA_UI_URL;
    }
  });

 test('probe never throws when the daemon is unreachable', async () => {
 process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
 const res = await makeAdapter().probe();
 expect(res.ok).toBe(false);
 });
});

describe('registry registers local Ollama', () => {
 const { getAdapter, getModelInfo, SUPPORTED_MODELS } = require('../src/adapter-factory');

 test('SUPPORTED_MODELS includes ollama', () => {
 expect(SUPPORTED_MODELS).toContain('ollama');
 });

 test('model info marks ollama as dedicated', () => {
 const info = getModelInfo('ollama-local');
 expect(info.dedicated).toBe(true);
 });

 test('factory builds an OllamaAdapter', () => {
 const a = getAdapter('local-ollama', {}, {});
 expect(a.constructor.name).toBe('OllamaAdapter');
 });
});
