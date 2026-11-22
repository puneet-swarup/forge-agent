// tests/adapter-url-authority.test.js — one source of truth for "where is the UI".
//
// browser.js navigated using the factory's URL while the health check and
// newChat() used adapter.getModelUrl(). For ollama those disagreed — the factory
// said http://localhost:11434 (the REST API, plain text) and the adapter honoured
// OLLAMA_UI_URL — so a run navigated to one page and was immediately told it was
// on the wrong one.
'use strict';

const fs = require('fs');
const path = require('path');

const BROWSER = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser.js'), 'utf8');

describe('navigation URL authority', () => {
  test('browser.js asks the adapter first', () => {
    expect(BROWSER).toContain('this.adapter.getModelUrl()');
    expect(BROWSER).toMatch(/const targetUrl = this\.adapter/);
  });

  test('the factory URL remains the fallback, not the primary', () => {
    const block = BROWSER.slice(BROWSER.indexOf('const targetUrl'));
    expect(block.indexOf('this.adapter.getModelUrl()'))
      .toBeLessThan(block.indexOf('getModelUrl(config.MODEL)'));
  });

  test('the adapter is constructed before navigation', () => {
    // Asking an adapter that does not exist yet would silently fall back.
    expect(BROWSER.indexOf('getAdapter(config.MODEL')).toBeLessThan(BROWSER.indexOf('const targetUrl'));
  });

  test('every adapter exposes getModelUrl', () => {
    const dir = path.join(__dirname, '..', 'src', 'adapters');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('-adapter.js'))) {
      const Adapter = require(path.join(dir, file));
      expect(typeof Adapter.prototype.getModelUrl).toBe('function');
    }
  });

  test('the ollama adapter prefers OLLAMA_UI_URL over the API root', () => {
    const factory = require('../src/adapter-factory');
    const previous = process.env.OLLAMA_UI_URL;
    process.env.OLLAMA_UI_URL = 'https://example.ngrok-free.dev';
    try {
      const adapter = factory.getAdapter('ollama', null, {});
      expect(adapter.getModelUrl()).toBe('https://example.ngrok-free.dev');
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_UI_URL;
      else process.env.OLLAMA_UI_URL = previous;
    }
  });
});
