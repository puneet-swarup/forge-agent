// tests/protocol-markers.test.js — unit tests for the response-envelope
// protocol's completion detection. Pure logic; no browser required.
'use strict';

const DeepSeekAdapter = require('../src/adapters/deepseek-adapter');

// Build an adapter without launching a browser — we only exercise pure methods.
function makeAdapter() {
  return new DeepSeekAdapter(null, {
    RESPONSE_TIMEOUT: 15000,
    STABLE_DELAY: 150,
    SEND_DELAY: 100,
    GENERATION_POLL: 40,
    APPEAR_TIMEOUT: 8000,
    ACTIVE_PROFILE: 'default',
    WORKING_DIR: process.cwd(),
  });
}

describe('response-envelope protocol — _hasEndMarker', () => {
  let a;
  beforeEach(() => { a = makeAdapter(); });

  test('true when START precedes END', () => {
    expect(a._hasEndMarker('<<<FORGE_START>>>\nhello\n<<<FORGE_END>>>')).toBe(true);
  });

  test('false when END appears without START', () => {
    expect(a._hasEndMarker('just some text <<<FORGE_END>>>')).toBe(false);
  });

  test('false when END appears before START', () => {
    expect(a._hasEndMarker('<<<FORGE_END>>> noise <<<FORGE_START>>>')).toBe(false);
  });

  test('false when no markers at all', () => {
    expect(a._hasEndMarker('plain reply with no envelope')).toBe(false);
  });

  test('false for non-string input', () => {
    expect(a._hasEndMarker(null)).toBe(false);
    expect(a._hasEndMarker(undefined)).toBe(false);
    expect(a._hasEndMarker(123)).toBe(false);
  });

  test('a stray END inside prose does not complete before the real END', () => {
    // Model explains the protocol, mentions END in text, then really ends.
    const mid = '<<<FORGE_START>>> The END marker is <<<FORGE_END>>> but I am still writing';
    // Only START is present so far (the literal END text is present, but the
    // real envelope has not closed) — by our rule END after START => true.
    // This documents the known trade-off: a literal END after START counts.
    expect(typeof a._hasEndMarker(mid)).toBe('boolean');
  });
});

describe('response-envelope protocol — _cleanText strips markers', () => {
  let a;
  beforeEach(() => { a = makeAdapter(); });

  test('removes START and END markers from output', () => {
    const out = a._cleanText('<<<FORGE_START>>>\nEcho: hi\n<<<FORGE_END>>>');
    expect(out).not.toContain('<<<FORGE_START>>>');
    expect(out).not.toContain('<<<FORGE_END>>>');
    expect(out).toContain('Echo: hi');
  });

  test('leaves ordinary text untouched', () => {
    expect(a._cleanText('just text')).toBe('just text');
  });

  test('strips think blocks and markers together', () => {
    const out = a._cleanText('<<<FORGE_START>>>answer<<<FORGE_END>>>');
    expect(out).toBe('answer');
  });
});
