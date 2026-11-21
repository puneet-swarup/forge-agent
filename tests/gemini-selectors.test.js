// tests/gemini-selectors.test.js — the selectors Gemini's UI actually needs.
//
// Gemini reported: input found, send button NOT found, new chat NOT found. The
// agent survived only because BaseAdapter falls back to pressing Enter, which
// cannot distinguish "send" from "newline" in a composer that accepts both.
'use strict';

const GeminiAdapter = require('../src/adapters/gemini-adapter');

function selectorsFor(method) {
  const adapter = Object.create(GeminiAdapter.prototype);
  return adapter[method]();
}

describe('Gemini selectors', () => {
  test('the composer is looked for in the rich-text editor first', () => {
    const sels = selectorsFor('_getInputSelectors');
    expect(sels[0]).toContain('rich-textarea');
    expect(sels.some((s) => s.includes('contenteditable'))).toBe(true);
  });

  test('send covers aria-label, test-id, class and icon variants', () => {
    const sels = selectorsFor('_getSendSelectors');
    const joined = sels.join(' ');
    expect(joined).toMatch(/aria-label\*="Send/i);
    expect(joined).toContain('data-test-id');
    expect(joined).toContain('data-mat-icon-name="send"');
    expect(joined).toContain('send-button');
  });

  test('send does not rely on one attribute, because it has moved before', () => {
    expect(selectorsFor('_getSendSelectors').length).toBeGreaterThanOrEqual(8);
  });

  test('new chat covers the sidebar button, not only the /app link', () => {
    const sels = selectorsFor('_getNewChatSelectors');
    const joined = sels.join(' ');
    expect(joined).toContain('data-test-id="new-chat-button"');
    expect(joined).toMatch(/aria-label\*="New chat"/i);
    expect(joined).toContain('a[href="/app"]');
  });

  test('response selectors target the model bubble, not the whole page', () => {
    const sels = selectorsFor('_getResponseSelectors');
    expect(sels.join(' ')).toContain('model-response');
  });

  test('every selector list is non-empty and free of duplicates', () => {
    for (const method of ['_getInputSelectors', '_getSendSelectors', '_getNewChatSelectors', '_getResponseSelectors', '_getStopSelectors']) {
      const sels = selectorsFor(method);
      expect(sels.length).toBeGreaterThan(0);
      expect(new Set(sels).size).toBe(sels.length);
    }
  });
});
