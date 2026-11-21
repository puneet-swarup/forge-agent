// tests/logger-surface.test.js — every logger method that is called must exist.
//
// Five adapters called `logger.debug(...)` and the method did not exist. Inside
// a try/catch that meant a silent TypeError: the message vanished and everything
// after it in the block was skipped. On a live run it surfaced as
// "[Sarvam] Navigation fallback: TypeError: logger.debug is not a function".
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...jsFiles(full)); continue; }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('logger surface', () => {
  const logger = require('../src/logger');

  test('every logger.<method>() called in src/ exists', () => {
    const missing = new Set();

    for (const file of jsFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/logger\.([a-zA-Z_]\w*)\s*\(/g)) {
        const method = match[1];
        if (typeof logger[method] !== 'function') missing.add(method);
      }
    }

    expect([...missing]).toEqual([]);
  });

  test('debug exists and is silent unless DEBUG is on', () => {
    expect(typeof logger.debug).toBe('function');

    const { TUI } = require('../src/tui');
    const printed = [];
    const original = TUI.prototype.dim;
    TUI.prototype.dim = (m) => printed.push(String(m));

    try {
      logger.updateTUIConfig({ DEBUG: false });
      logger.debug('should not appear');
      expect(printed).toEqual([]);

      logger.updateTUIConfig({ DEBUG: true });
      logger.debug('should appear');
      expect(printed.join(' ')).toContain('should appear');
    } finally {
      TUI.prototype.dim = original;
      logger.updateTUIConfig({ DEBUG: false });
    }
  });

  test('debug keeps extra arguments, like warn', () => {
    expect(typeof logger.debug).toBe('function');
    const { TUI } = require('../src/tui');
    const printed = [];
    const original = TUI.prototype.dim;
    TUI.prototype.dim = (m) => printed.push(String(m));

    try {
      logger.updateTUIConfig({ DEBUG: true });
      logger.debug('[Gemini] fallback:', 'reason');
      expect(printed.join(' ')).toContain('reason');
    } finally {
      TUI.prototype.dim = original;
      logger.updateTUIConfig({ DEBUG: false });
    }
  });
});
