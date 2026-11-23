// tests/transport-factory.test.js — step 3: one place decides, nothing downstream asks.
//
// The registry declares a category per model. This is the only place that turns
// that into a transport, so the agent never branches on "does this use a browser".
'use strict';

const { createTransport, needsBrowser, endpointFor } = require('../src/transport-factory');
const { BrowserChatTransport } = require('../src/browser-transport');
const { HttpChatTransport } = require('../src/http-transport');
const { conforms } = require('../src/chat-transport');
const factory = require('../src/adapter-factory');

describe('the category decides the transport', () => {
  test('an http model gets an HttpChatTransport and no browser', () => {
    const t = createTransport({ model: 'local', config: { OLLAMA_BASE_URL: 'http://localhost:11434' } });
    expect(t).toBeInstanceOf(HttpChatTransport);
    expect(needsBrowser('local')).toBe(false);
  });

  test('a browser model gets a BrowserChatTransport', () => {
    const browser = { adapter: null, page: null, newChat: async () => {} };
    const t = createTransport({ model: 'deepseek', config: {}, browser });
    expect(t).toBeInstanceOf(BrowserChatTransport);
    expect(needsBrowser('deepseek')).toBe(true);
  });

  test('every model resolves to exactly one transport', () => {
    for (const model of factory.SUPPORTED_MODELS) {
      const browser = { adapter: null, page: null, newChat: async () => {} };
      const t = createTransport({ model, config: { OLLAMA_BASE_URL: 'http://x' }, browser });
      expect(conforms(t).ok).toBe(true);
    }
  });

  test('a browser model without a browser is a caller bug, said plainly', () => {
    expect(() => createTransport({ model: 'deepseek', config: {} }))
      .toThrow(/needs a browser, and none was provided/);
  });

  test('an alias resolves to its canonical model', () => {
    expect(needsBrowser('ollama')).toBe(false);   // alias of local
    expect(needsBrowser('llama')).toBe(false);
  });
});

describe('endpoint resolution', () => {
  test('--model-url wins', () => {
    const e = endpointFor('local', { MODEL_URL: 'http://explicit', OLLAMA_BASE_URL: 'http://other' });
    expect(e.baseUrl).toBe('http://explicit');
  });

  test('a per-model env wins over the shared one', () => {
    const e = endpointFor('colab', { COLAB_BASE_URL: 'http://colab', OLLAMA_BASE_URL: 'http://shared' });
    expect(e.baseUrl).toBe('http://colab');
  });

  test('OLLAMA_BASE_URL is the shared fallback', () => {
    expect(endpointFor('local', { OLLAMA_BASE_URL: 'http://localhost:11434' }).baseUrl)
      .toBe('http://localhost:11434');
  });

  test('no endpoint configured is empty, not undefined', () => {
    expect(endpointFor('colab', {}).baseUrl).toBe('');
  });

  test('the api key and model id come through', () => {
    const e = endpointFor('local', { OLLAMA_BASE_URL: 'http://x', OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'deepseek-r1' });
    expect(e.apiKey).toBe('k');
    expect(e.model).toBe('deepseek-r1');
  });
});

describe('the browser transport delegates, it does not implement', () => {
  function fakeBrowser() {
    const calls = [];
    return {
      calls,
      adapter: { getGenerationState: async () => false },
      page: {},
      sendMessage: async (t) => { calls.push(['send', t]); return { ok: true }; },
      waitForResponse: async () => { calls.push(['wait']); return 'reply'; },
      newChat: async () => { calls.push(['newChat']); },
    };
  }

  test('each method forwards to the browser', async () => {
    const browser = fakeBrowser();
    const t = new BrowserChatTransport({ browser, model: 'deepseek' });

    await t.send('hi');
    await expect(t.awaitReply()).resolves.toBe('reply');
    await t.newChat();

    expect(browser.calls).toEqual([['send', 'hi'], ['wait'], ['newChat']]);
  });

  test('isGenerating reads the adapter state', async () => {
    const browser = fakeBrowser();
    expect(await new BrowserChatTransport({ browser }).isGenerating()).toBe(false);

    browser.adapter.getGenerationState = async () => ({ generating: true });
    expect(await new BrowserChatTransport({ browser }).isGenerating()).toBe(true);
  });

  test('capabilities come from what the browser and adapter actually offer', () => {
    const caps = new BrowserChatTransport({ browser: fakeBrowser() }).capabilities;
    expect(caps.observable).toBe(true);
    expect(caps.stop).toBe(false);   // this fake has no stopGeneration
  });

  test('stop says so when the model cannot', async () => {
    const t = new BrowserChatTransport({ browser: fakeBrowser() });
    await expect(t.stop()).rejects.toThrow(/cannot stop/);
  });

  test('close does not close the browser — the agent owns that lifecycle', async () => {
    let closed = false;
    const browser = { ...fakeBrowser(), close: async () => { closed = true; } };
    await new BrowserChatTransport({ browser }).close();
    expect(closed).toBe(false);
  });
});
