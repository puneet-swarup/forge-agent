// tests/sarvam-indus-adapter.test.js — Sarvam's chat UI (Indus).
//
// This adapter was written against the live UI and carries knowledge that is
// easy to lose: the composer is TipTap/ProseMirror (fill() does not work), the
// send control lives in .indus-send-slot, and the app is served from
// indus.sarvam.ai/indus. It existed on the loom branch but was never registered
// in the adapter factory, so `--model=sarvam` could not reach it.
'use strict';

const SarvamAdapter = require('../src/adapters/sarvam-adapter');
const factory = require('../src/adapter-factory');

function selectorsFor(method) {
  return Object.create(SarvamAdapter.prototype)[method]();
}

describe('Sarvam Indus adapter', () => {
  test('is reachable as --model=sarvam', () => {
    expect(factory.getModelDisplayName('sarvam')).toBe('Sarvam AI (Indus)');
    expect(factory.getModelDisplayName('indus')).toBe('Sarvam AI (Indus)');
    expect(factory.getModelUrl('sarvam')).toBe('https://indus.sarvam.ai/indus');
  });

  test('the factory returns this adapter for the model name', () => {
    const instance = factory.getAdapter('sarvam', null, {});
    expect(instance.constructor.name).toBe('SarvamAdapter');
  });

  test('the composer targets TipTap / ProseMirror, not a textarea', () => {
    const sels = selectorsFor('_getInputSelectors');
    expect(sels[0]).toBe('.tiptap.ProseMirror');
    expect(sels.join(' ')).toContain('contenteditable');
  });

  test('send looks inside the .indus-send-slot container first', () => {
    const sels = selectorsFor('_getSendSelectors');
    expect(sels[0]).toContain('.indus-send-slot');
  });

  test('disabled send buttons are excluded, so a click cannot hang', () => {
    const sels = selectorsFor('_getSendSelectors');
    expect(sels.join(' ')).toMatch(/:not\(\[disabled\]\)|:not\(\[aria-disabled/);
  });

  test('response detection includes the structural containers Indus actually uses', () => {
    const sels = selectorsFor('_getResponseSelectors');
    // Indus has no markdown/prose class; a live dump showed the transcript in
    // <section class="flex h-full">.
    expect(sels).toContain('section.flex.h-full');
    expect(sels).toContain('[data-message-author-role="assistant"]');
  });

  test('response detection has a structural fallback for utility-class markup', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'adapters', 'sarvam-adapter.js'), 'utf8');
    expect(src).toContain('Response container found structurally');
  });

  test('every selector list is non-empty and duplicate-free', () => {
    for (const method of ['_getInputSelectors', '_getSendSelectors', '_getStopSelectors', '_getNewChatSelectors', '_getResponseSelectors']) {
      const sels = selectorsFor(method);
      expect(sels.length).toBeGreaterThan(0);
      expect(new Set(sels).size).toBe(sels.length);
    }
  });

  test('it overrides text insertion, because ProseMirror ignores fill()', () => {
    // The reason this adapter exists rather than reusing the base class.
    expect(typeof SarvamAdapter.prototype._typeText).toBe('function');
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'adapters', 'sarvam-adapter.js'), 'utf8');
    expect(src).toContain('insertText');
  });
});
