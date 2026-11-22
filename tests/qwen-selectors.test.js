// tests/qwen-selectors.test.js — Qwen's UI, as a live run found it.
//
// The round trip worked (8.6 s, reply "OK") and `.qwen-markdown` matched once a
// reply existed. Two gaps remained, and both had the same cause: this UI builds
// controls out of <div role="button">, so button-only selectors matched nothing
// while the control was plainly on screen.
'use strict';

const QwenAdapter = require('../src/adapters/qwen-adapter');

const selectorsFor = (method) => Object.create(QwenAdapter.prototype)[method]();

describe('Qwen selectors', () => {
  test('the composer is the textarea the live page actually has', () => {
    const sels = selectorsFor('_getInputSelectors');
    expect(sels.join(' ')).toContain('.message-input-textarea');
    expect(sels.some((s) => s === 'textarea')).toBe(true);
  });

  test('send matches the class the live page uses', () => {
    // 4 of 6 matched once text was in the composer; this is the one that always did.
    expect(selectorsFor('_getSendSelectors')).toContain('.message-input-right-button-send');
  });

  test('new chat targets the role, not the tag', () => {
    // <div class="sidebar-entry-fixed-list-content" aria-label="New Chat"
    //      role="button"> — a button-only selector misses it.
    const sels = selectorsFor('_getNewChatSelectors');
    expect(sels).toContain('[aria-label*="New Chat" i]');
    expect(sels).toContain('.sidebar-entry-fixed-list-content');
    expect(sels[0]).not.toMatch(/^button/);
  });

  test('stop also allows a role-based control', () => {
    const sels = selectorsFor('_getStopSelectors');
    expect(sels.join(' ')).toContain('[role="button"]');
  });

  test('response detection uses the class that matched after a reply', () => {
    expect(selectorsFor('_getResponseSelectors')[0]).toBe('.qwen-markdown');
  });

  test('every selector list is non-empty and duplicate-free', () => {
    for (const method of ['_getInputSelectors', '_getSendSelectors', '_getStopSelectors', '_getNewChatSelectors', '_getResponseSelectors']) {
      const sels = selectorsFor(method);
      expect(sels.length).toBeGreaterThan(0);
      expect(new Set(sels).size).toBe(sels.length);
    }
  });

  test('no adapter defines its own discovery (the template method holds)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'adapters', 'qwen-adapter.js'), 'utf8');
    expect(src).not.toMatch(/async discoverComposer\s*\(/);
    expect(src).not.toMatch(/async discoverSendButton\s*\(/);
    expect(src).not.toMatch(/async discoverLatestResponse\s*\(/);
  });
});
