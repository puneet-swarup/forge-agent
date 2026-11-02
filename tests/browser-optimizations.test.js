// tests/browser-optimizations.test.js — P3.2 image + telemetry blocking
'use strict';

const mockPage = {
  goto            : jest.fn().mockResolvedValue(undefined),
  waitForTimeout  : jest.fn().mockResolvedValue(undefined),
  waitForSelector : jest.fn().mockResolvedValue({}),
  evaluate        : jest.fn().mockResolvedValue(false),
  addInitScript   : jest.fn().mockResolvedValue(undefined),
  route           : jest.fn().mockResolvedValue(undefined),
  keyboard        : { press: jest.fn().mockResolvedValue(undefined) },
  screenshot      : jest.fn().mockResolvedValue(undefined),
  $               : jest.fn(),
};

const mockContext = {
  pages   : jest.fn().mockReturnValue([mockPage]),
  newPage : jest.fn().mockResolvedValue(mockPage),
  close   : jest.fn().mockResolvedValue(undefined),
};

jest.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: jest.fn().mockResolvedValue(mockContext),
  },
}));

// Config mock with the optimisation flags controllable per test.
let mockConfig;
jest.mock('../src/config', () => mockConfig);

jest.mock('../src/logger', () => ({
  info: jest.fn(), success: jest.fn(), warn: jest.fn(), error: jest.fn(),
  dim: jest.fn(), thinking: jest.fn(), clearLine: jest.fn(), banner: jest.fn(),
  separator: jest.fn(),
}));

jest.mock('../src/adapter-factory', () => ({
  getAdapter: jest.fn().mockReturnValue({ sendMessage: jest.fn(), waitForResponse: jest.fn(), newChat: jest.fn() }),
  getModelUrl: jest.fn().mockReturnValue('https://chat.deepseek.com'),
}));

jest.mock('../src/health', () => ({
  runHealthCheckWithReAuth: jest.fn().mockResolvedValue({ checks: [], passed: 6, warned: 0, failed: 0, healthy: true }),
}));

function setConfig(over) {
  mockConfig = Object.assign({
    MODEL: 'deepseek',
    SESSION_DIR: '/tmp/x',
    HEADLESS: false,
    RESPONSE_TIMEOUT: 5000,
    STABLE_DELAY: 500,
    SEND_DELAY: 50,
    DEBUG: false,
    BROWSER_BLOCK_IMAGES: false,
    BROWSER_BLOCK_TELEMETRY: false,
  }, over);
}

describe('browser optimisations (P3.2)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockContext.pages.mockReturnValue([mockPage]);
    mockContext.newPage.mockResolvedValue(mockPage);
    mockPage.addInitScript.mockResolvedValue(undefined);
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockResolvedValue(undefined);
    mockPage.waitForSelector.mockResolvedValue({});
    mockPage.evaluate.mockResolvedValue(false);
    mockPage.route.mockResolvedValue(undefined);
  });

  async function runLaunch() {
    const DeepSeekBrowser = require('../src/browser');
    const b = new DeepSeekBrowser();
    await b.launch();
    return b;
  }

  test('image flag off by default (no blink arg)', async () => {
    setConfig({});
    const { chromium } = require('playwright');
    await runLaunch();
    const opts = chromium.launchPersistentContext.mock.calls[0][1];
    expect(opts.args.some(a => a.includes('imagesEnabled=false'))).toBe(false);
  });

  test('image flag on adds blink arg', async () => {
    setConfig({ BROWSER_BLOCK_IMAGES: true });
    const { chromium } = require('playwright');
    await runLaunch();
    const opts = chromium.launchPersistentContext.mock.calls[0][1];
    expect(opts.args.some(a => a.includes('imagesEnabled=false'))).toBe(true);
  });

  test('telemetry off installs no route', async () => {
    setConfig({});
    await runLaunch();
    expect(mockPage.route).not.toHaveBeenCalled();
  });

  test('telemetry on installs a route that aborts analytics and continues others', async () => {
    setConfig({ BROWSER_BLOCK_TELEMETRY: true });
    await runLaunch();
    expect(mockPage.route).toHaveBeenCalledTimes(1);
    const handler = mockPage.route.mock.calls[0][1];

    const abortRoute = { request: () => ({ url: () => 'https://www.google-analytics.com/collect' }), abort: jest.fn(), continue: jest.fn() };
    handler(abortRoute);
    expect(abortRoute.abort).toHaveBeenCalled();
    expect(abortRoute.continue).not.toHaveBeenCalled();

    const okRoute = { request: () => ({ url: () => 'https://chat.deepseek.com/api' }), abort: jest.fn(), continue: jest.fn() };
    handler(okRoute);
    expect(okRoute.continue).toHaveBeenCalled();
    expect(okRoute.abort).not.toHaveBeenCalled();
  });
});
