// tests/log-arguments.test.js — a log call must not silently drop its reason.
//
// On a real run the operator saw:
//   ⚠  [Gemini] Navigation fallback:
// with nothing after the colon, because logger.warn(msg) took one argument and
// the call site passed two. The reason existed and was thrown away.
'use strict';

describe('logger argument handling', () => {
  let captured;
  let logger;
  let tui;

  const originals = {};

  beforeEach(() => {
    jest.resetModules();
    captured = [];

    // Capture what the TUI would print, without needing a setter: the logger
    // reads the same TUI prototype every call.
    const { TUI } = require('../src/tui');
    for (const method of ['warn', 'info', 'error', 'dim', 'success', 'renderThinking']) {
      if (!originals[method]) originals[method] = TUI.prototype[method];
      TUI.prototype[method] = function (a, b) { captured.push(b === undefined ? String(a) : `${a} ${b}`); };
    }
    logger = require('../src/logger');
  });

  afterEach(() => {
    const { TUI } = require('../src/tui');
    for (const [method, fn] of Object.entries(originals)) TUI.prototype[method] = fn;
  });

  test('warn keeps the second argument', () => {
    logger.warn('[Gemini] Navigation fallback:', 'timeout waiting for selector');
    expect(captured.join(' ')).toContain('timeout waiting for selector');
  });

  test('warn with one argument is unchanged', () => {
    logger.warn('plain message');
    expect(captured).toEqual(['plain message']);
  });

  test('undefined and empty extras are not appended', () => {
    logger.warn('msg', undefined, '', null);
    expect(captured).toEqual(['msg']);
  });
});

describe('thinking indicator', () => {
  test('a message string is rendered as a message, not as NaN', () => {
    const { TUI } = require('../src/tui');
    const tui = new TUI({ noColor: true });
    const writes = [];
    const original = process.stdout.write;
    const originalTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    process.stdout.write = (s) => { writes.push(String(s)); return true; };

    try {
      tui.renderThinking('Launching browser and loading page...');
    } finally {
      process.stdout.write = original;
      process.stdout.isTTY = originalTTY;
    }

    const out = writes.join('');
    expect(out).toContain('Launching browser');
    expect(out).not.toContain('NaN');
  });

  test('formatMs never renders NaN', () => {
    const { formatMs } = require('../src/tui');
    expect(formatMs(NaN)).toBe('0s');
    expect(formatMs(undefined)).toBe('0s');
    expect(formatMs(Infinity)).toBe('0s');
    expect(formatMs(1500)).toBe('1.5s');
  });
});
