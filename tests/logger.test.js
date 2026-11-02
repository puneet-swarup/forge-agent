// tests/logger.test.js — logger.finalOutput signature hardening (P2.2)
'use strict';

// logger.js constructs `new TUI(...)` from ./tui, so the mock must provide a
// TUI class whose instance exposes renderCompletion (and the other methods
// finalOutput/other loggers may touch). The spy is exposed for assertions.
jest.mock('../src/tui', () => {
  const renderCompletion = jest.fn();
  class TUI {
    renderCompletion(p, s) { return renderCompletion(p, s); }
    renderError() {}
    renderWaiting() {}
    clearWaiting() {}
    renderStepLine() {}
    renderContextMeter() {}
    renderHealthCheck() {}
    banner() {}
    info() {}
    success() {}
    warn() {}
    error() {}
    dim() {}
    separator() {}
    renderAnswer() {}
  }
  return {
    __esModule: true,
    TUI,
    color: (s) => s,
    colors: {},
    stripAnsi: (s) => s,
    __renderCompletion: renderCompletion,
  };
});

const tuiModule = require('../src/tui');
const renderCompletion = tuiModule.__renderCompletion;
const logger = require('../src/logger');

describe('logger.finalOutput (P2.2 signature hardening)', () => {
  let logSpy;
  beforeEach(() => {
    renderCompletion.mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); });

  test('string signature prints text, does not call renderCompletion', () => {
    logger.finalOutput('done');
    expect(logSpy).toHaveBeenCalledWith('done');
    expect(renderCompletion).not.toHaveBeenCalled();
  });

  test('empty string prints nothing', () => {
    logger.finalOutput('');
    expect(logSpy).not.toHaveBeenCalled();
    expect(renderCompletion).not.toHaveBeenCalled();
  });

  test('null is a safe no-op', () => {
    expect(() => logger.finalOutput(null)).not.toThrow();
    expect(renderCompletion).not.toHaveBeenCalled();
  });

  test('undefined is a safe no-op', () => {
    expect(() => logger.finalOutput(undefined)).not.toThrow();
    expect(renderCompletion).not.toHaveBeenCalled();
  });

  test('tracker object routes to renderCompletion with status', () => {
    const tracker = { steps: 3, completed: () => {} };
    logger.finalOutput(tracker, 'completed');
    expect(renderCompletion).toHaveBeenCalledWith(tracker, 'completed');
  });
});
