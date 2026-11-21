// tests/chatgpt-selectors.test.js — ChatGPT's markup as it actually is.
//
// A live --diagnose run showed all eight response selectors matching nothing
// with a reply on screen: no `prose` class, no `data-message-author-role`, no
// `article`. The transcript is
//   <div class="… thread-scroll-container peer/transcript" role="region">
'use strict';

const ChatGPTAdapter = require('../src/adapters/chatgpt-adapter');

function selectorsFor(method) {
  return Object.create(ChatGPTAdapter.prototype)[method]();
}

describe('ChatGPT selectors', () => {
  test('response detection includes the transcript container from the live dump', () => {
    const sels = selectorsFor('_getResponseSelectors');
    expect(sels).toContain('.thread-scroll-container');
    expect(sels).toContain('[role="region"].thread-scroll-container');
  });

  test('the old prose selectors are kept as fallbacks, not as the primary', () => {
    const sels = selectorsFor('_getResponseSelectors');
    expect(sels).toContain('[class*="prose"]');
    expect(sels[0]).not.toContain('prose');
  });

  test('response detection has a structural fallback', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'adapters', 'chatgpt-adapter.js'), 'utf8');
    expect(src).toContain('Response container found structurally');
  });

  test('send works only with text in the composer, which the probe now does', () => {
    const sels = selectorsFor('_getSendSelectors');
    // These two are what matched on a live run once a character was typed.
    expect(sels).toContain('button[aria-label="Send"]');
    expect(sels).toContain('form button[type="submit"]');
  });

  test('every selector list is non-empty and duplicate-free', () => {
    for (const method of ['_getInputSelectors', '_getSendSelectors', '_getStopSelectors', '_getNewChatSelectors', '_getResponseSelectors']) {
      const sels = selectorsFor(method);
      expect(sels.length).toBeGreaterThan(0);
      expect(new Set(sels).size).toBe(sels.length);
    }
  });
});

describe('health check', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'health.js'), 'utf8');

  test('asks the adapter for the composer instead of checking three selectors', () => {
    // On ChatGPT the composer is the fourth candidate, so the old check warned
    // "input not visible" on a page the adapter could type into.
    expect(src).toContain('adapter.discoverComposer');
  });
});
