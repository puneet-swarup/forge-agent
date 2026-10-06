// tests/integration-browser.test.js - End-to-end adapter test against a local
// mock chat page, using a REAL headless Chromium (Playwright).
//
// This closes the "no real browser E2E" gap WITHOUT needing a DeepSeek login
// or network: we serve a local page that implements the same selectors the
// adapter looks for, then drive the real adapter through send -> scrape.
//
// Skipped automatically when Chromium isn't installed (e.g. CI with
// SKIP_PLAYWRIGHT_INSTALL=1).
'use strict';

const { startMockChatServer } = require('./helpers/mock-chat-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  chromium = null;
}

// Detect whether a real browser is available.
let browserAvailable = false;
let probeError = null;

// Probe synchronously at collection time so itBrowser() can decide.
try {
  if (chromium) {
    const { execFileSync } = require('child_process');
    const probe = 'const {chromium}=require("playwright");chromium.launch({headless:true,args:["--no-sandbox"]}).then(b=>b.close()).then(()=>process.exit(0)).catch(()=>process.exit(1));';
    execFileSync(process.execPath, ['-e', probe], { stdio: 'ignore', timeout: 60000 });
    browserAvailable = true;
  } else {
    probeError = 'playwright not installed';
  }
} catch (e) {
  probeError = 'browser launch failed';
}

describe('browser integration (mock chat)', () => {
  let server, browser, context, page;

  beforeAll(async () => {
    if (!browserAvailable) return;
    server  = await startMockChatServer();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 60000);

  afterAll(async () => {
    try { await browser.close(); } catch (_) {}
    try { await server.close(); } catch (_) {}
  });

  beforeEach(async () => {
    if (!browserAvailable) return;
    context = await browser.newContext();
    page    = await context.newPage();
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  });

  afterEach(async () => {
    try { if (context) await context.close(); } catch (_) {}
  });

  // Skip cleanly when no browser is available (CI without Chromium).
  const itBrowser = (name, fn, timeout) => {
    if (browserAvailable) it(name, fn, timeout);
    else it.skip(name + ' [no browser: ' + (probeError || 'n/a') + ']', fn, timeout);
  };

  itBrowser('adapter finds the input and send button', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const config = { DEEPSEEK_URL: server.url, HEALTH_CHECK_TIMEOUT: 5000, SEND_DELAY: 100, GENERATION_POLL: 50, STABLE_DELAY: 150, RESPONSE_TIMEOUT: 15000, APPEAR_TIMEOUT: 8000, ACTIVE_PROFILE: 'default', PLANNING_MODE: false, WORKING_DIR: process.cwd() };
    const adapter = getAdapter('deepseek', page, config);
    expect(await adapter.isReady()).toBe(true);
  }, 30000);

  itBrowser('adapter sends a message and scrapes the streamed reply', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const config = {
      DEEPSEEK_URL: server.url,
      HEALTH_CHECK_TIMEOUT: 5000,
      SEND_DELAY: 100,
      GENERATION_POLL: 40,
      STABLE_DELAY: 150,
      APPEAR_TIMEOUT: 8000,
      RESPONSE_TIMEOUT: 15000,
      ACTIVE_PROFILE: 'default',
      PLANNING_MODE: false,
      WORKING_DIR: process.cwd(),
    };
    const adapter = getAdapter('deepseek', page, config);

    await adapter.sendMessage('hello world');
    const reply = await adapter.waitForResponse();

    expect(reply).toContain('Echo: hello world');
  }, 30000);

  itBrowser('scraped reply preserves a fenced tool_call block', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const config = {
      DEEPSEEK_URL: server.url,
      HEALTH_CHECK_TIMEOUT: 5000,
      SEND_DELAY: 100,
      GENERATION_POLL: 40,
      STABLE_DELAY: 150,
      APPEAR_TIMEOUT: 8000,
      RESPONSE_TIMEOUT: 15000,
      ACTIVE_PROFILE: 'default',
      PLANNING_MODE: false,
      WORKING_DIR: process.cwd(),
    };
    const adapter = getAdapter('deepseek', page, config);

    await adapter.sendMessage('please TOOLCALL now');
    const reply = await adapter.waitForResponse();

    // The parser must be able to see a tool_call fence in the scraped text.
    expect(reply).toContain('tool_call');
    const { parseResponse } = require('../src/parser');
    const parsed = parseResponse(reply);
    // parseResponse returns {type:'tool_call', name, args} for a single call,
    // or {type:'tool_batch', calls:[...]} for a batch.
    const names = parsed.type === 'tool_batch'
      ? parsed.calls.map(c => c.name)
      : [parsed.name];
    expect(names).toContain('show_info');
  }, 30000);

  itBrowser('uses the MutationObserver fast path and resolves quickly', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const config = {
      DEEPSEEK_URL: server.url,
      HEALTH_CHECK_TIMEOUT: 5000,
      SEND_DELAY: 200,
      GENERATION_POLL: 800,   // deliberately slow fallback poll
      STABLE_DELAY: 200,
      APPEAR_TIMEOUT: 8000,
      RESPONSE_TIMEOUT: 15000,
      ACTIVE_PROFILE: 'default',
      PLANNING_MODE: false,
      WORKING_DIR: process.cwd(),
    };
    const adapter = getAdapter('deepseek', page, config);

    await adapter.sendMessage('speed test');

    // The quiet watcher must be installed after waitForResponse starts.
    const t0 = Date.now();
    const reply = await adapter.waitForResponse();
    const elapsed = Date.now() - t0;

    expect(reply).toContain('Echo: speed test');

    // The observer flag should exist on the page.
    const installed = await page.evaluate(() => !!window.__forgeQuiet);
    expect(installed).toBe(true);

    // With the 800ms fallback poll, an un-optimized loop would take at least
    // ~800ms to resolve. The observer path should beat that comfortably.
    expect(elapsed).toBeLessThan(800);
  }, 30000);
});
