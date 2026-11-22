// tests/adapter-url-authority.test.js — one source of truth for "where is the UI".
//
// browser.js navigated using the factory's URL while the health check and
// newChat() used adapter.getModelUrl(). For the local model those disagreed — the factory
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

  test('the local model serves its own proxy page', () => {
    // LocalChatAdapter starts a loopback server that serves the chat page and
    // proxies to OLLAMA_BASE_URL, so the page URL is that server — not the
    // daemon's API root, and not a file:// page.
    const factory = require('../src/adapter-factory');
    const adapter = factory.getAdapter('local', null, {});
    expect(adapter.getModelUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

});
