// tests/adapter-upload.test.js - Gated read_file upload (ARCHITECTURE.md §11).
//
// Exercises the opt-in upload path end-to-end against a REAL headless Chromium
// driving the mock chat page (which now exposes an input[type=file]). Covers:
//   - adapter.supportsUpload() probes the mock page correctly
//   - adapter.uploadFile() attaches a real file (chip rendered in the DOM)
//   - the base adapter advertises NO upload by default (safe fallback)
//   - read_file falls back to inline text when READ_FILE_UPLOAD is off
//   - the tryUploadRead gate returns null (=> text) for small files
//
// Skipped automatically when Chromium isn't installed (e.g. CI with
// SKIP_PLAYWRIGHT_INSTALL=1), matching integration-browser.test.js.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { startMockChatServer } = require('./helpers/mock-chat-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  chromium = null;
}

// Detect a usable real browser once, at collection time.
let browserAvailable = false;
let probeError = null;
try {
  if (chromium) {
    const { execFileSync } = require('child_process');
    const probe = 'const {chromium}=require("playwright");chromium.launch({headless:true,args:["--no-sandbox"]}).then(b=>b.close()).then(()=>process.exit(0)).catch(()=>process.exit(1));';
    execFileSync(process.execPath, ['-e', probe], { stdio: 'ignore', timeout: 60000 });
    browserAvailable = true;
  } else {
    probeError = 'playwright not installed';
  }
} catch (_) {
  probeError = 'browser launch failed';
}

// A temp file big enough to clear READ_FILE_UPLOAD_MIN_BYTES if needed.
const TMP_DIR = path.join(os.tmpdir(), 'forge-upload-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });
const BIG_FILE = path.join(TMP_DIR, 'big.txt');
fs.writeFileSync(BIG_FILE, 'x'.repeat(8192), 'utf8');

const adapterConfig = (server) => ({
  DEEPSEEK_URL     : server.url,
  HEALTH_CHECK_TIMEOUT: 5000,
  SEND_DELAY       : 100,
  GENERATION_POLL  : 50,
  STABLE_DELAY     : 150,
  RESPONSE_TIMEOUT : 15000,
  APPEAR_TIMEOUT   : 8000,
  ACTIVE_PROFILE   : 'default',
  PLANNING_MODE    : false,
  WORKING_DIR      : process.cwd(),
  READ_FILE_UPLOAD_TIMEOUT_MS: 5000,
});

describe('adapter upload (mock chat)', () => {
  let server, browser, context, page;

  beforeAll(async () => {
    if (!browserAvailable) return;
    server  = await startMockChatServer();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 60000);

  afterAll(async () => {
    try { await browser.close(); } catch (_) {}
    try { await server.close(); } catch (_) {}
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
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

  const itBrowser = (name, fn, timeout) => {
    if (browserAvailable) it(name, fn, timeout);
    else it.skip(name + ' [no browser: ' + (probeError || 'n/a') + ']', fn, timeout);
  };

  itBrowser('deepseek adapter probes supportsUpload() true on the mock page', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const adapter = getAdapter('deepseek', page, adapterConfig(server));
    expect(await adapter.supportsUpload()).toBe(true);
    expect(await adapter.detectUploadSelector()).toMatch(/input\[type="file"\]/);
  }, 30000);

  itBrowser('deepseek adapter uploads a file and the UI shows a chip', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const adapter = getAdapter('deepseek', page, adapterConfig(server));

    const res = await adapter.uploadFile(BIG_FILE, { timeoutMs: 5000 });
    expect(res.ok).toBe(true);
    expect(['setInputFiles', 'filechooser']).toContain(res.method);

    // The mock page records uploads on window.__uploads and renders a chip.
    const uploaded = await page.evaluate(() => window.__uploads || []);
    expect(uploaded).toContain(path.basename(BIG_FILE));
    const count = await page.getAttribute('#attachments', 'data-upload-count');
    expect(count).toBe('1');
  }, 30000);

  itBrowser('uploadFile throws for a missing file (caller falls back)', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const adapter = getAdapter('deepseek', page, adapterConfig(server));
    await expect(adapter.uploadFile(path.join(TMP_DIR, 'nope.bin'))).rejects.toThrow(/not found/i);
  }, 30000);

  itBrowser('gemini adapter probes supportsUpload() true on the mock page', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const adapter = getAdapter('gemini', page, adapterConfig(server));
    expect(await adapter.supportsUpload()).toBe(true);
    expect(await adapter.detectUploadSelector()).toMatch(/input\[type="file"\]/);
  }, 30000);

  itBrowser('gemini adapter uploads a file and the UI shows a chip', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const adapter = getAdapter('gemini', page, adapterConfig(server));

    const res = await adapter.uploadFile(BIG_FILE, { timeoutMs: 5000 });
    expect(res.ok).toBe(true);
    expect(['setInputFiles', 'filechooser']).toContain(res.method);

    const uploaded = await page.evaluate(() => window.__uploads || []);
    expect(uploaded).toContain(path.basename(BIG_FILE));
    const count = await page.getAttribute('#attachments', 'data-upload-count');
    expect(count).toBe('1');
  }, 30000);

  itBrowser('gemini uploadFile throws for a missing file (caller falls back)', async () => {
    const { getAdapter } = require('../src/adapter-factory');
    const adapter = getAdapter('gemini', page, adapterConfig(server));
    await expect(adapter.uploadFile(path.join(TMP_DIR, 'nope.bin'))).rejects.toThrow(/not found/i);
  }, 30000);
});

// ── Base adapter default: no upload capability ──────────────────────────────

describe('base adapter upload defaults', () => {
  const BaseAdapter = require('../src/adapters/base-adapter');

  test('default adapter has empty upload selectors', () => {
    const a = new BaseAdapter(null, {});
    expect(a._getUploadSelectors()).toEqual([]);
  });

  test('default uploadFile() throws (never silently no-ops)', async () => {
    const a = new BaseAdapter(null, {});
    await expect(a.uploadFile('/tmp/x')).rejects.toThrow(/not implemented/i);
  });
});

// ── read_file gating (no browser needed) ─────────────────────────────────────
//
describe('read_file upload gate', () => {
  const path = require('path');
  const os   = require('os');
  const fs   = require('fs');
  const TMP  = path.join(os.tmpdir(), 'forge-readfile-gate-' + Date.now());
  fs.mkdirSync(TMP, { recursive: true });

  afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

  function freshTools(overrides) {
    jest.resetModules();
    jest.doMock('../src/config', () => Object.assign({
      WORKING_DIR: TMP,
      MAX_OUTPUT_LENGTH: 8000,
      DEBUG: false,
    }, overrides || {}));
    return require('../src/tools');
  }

  test('READ_FILE_UPLOAD off => read_file returns inline text (no adapter)', async () => {
    const tools = freshTools({ READ_FILE_UPLOAD: false });
    const f = path.join(TMP, 'inline.txt');
    fs.writeFileSync(f, 'line1\nline2', 'utf8');
    const out = await tools.executeTool('read_file', { path: f });
    expect(out).toContain('line1');
    expect(out).not.toMatch(/uploaded/);
  });

  test('READ_FILE_UPLOAD on but no adapter provider => inline text fallback', async () => {
    const tools = freshTools({ READ_FILE_UPLOAD: true, READ_FILE_UPLOAD_MIN_BYTES: 1 });
    // No setAdapterProvider call => getAdapter() is null => fallback.
    const f = path.join(TMP, 'noadapter.txt');
    fs.writeFileSync(f, 'abc\ndef', 'utf8');
    const out = await tools.executeTool('read_file', { path: f });
    expect(out).toContain('abc');
    expect(out).not.toMatch(/uploaded/);
  });

  test('READ_FILE_UPLOAD on + supporting adapter => uploads instead of inlining', async () => {
    const tools = freshTools({ READ_FILE_UPLOAD: true, READ_FILE_UPLOAD_MIN_BYTES: 1 });
    let uploadedPath = null;
    tools.setAdapterProvider(() => ({
      async supportsUpload() { return true; },
      async uploadFile(abs) { uploadedPath = abs; return { ok: true, method: 'setInputFiles' }; },
    }));
    const f = path.join(TMP, 'upload-me.txt');
    fs.writeFileSync(f, 'payload-content', 'utf8');
    const out = await tools.executeTool('read_file', { path: f });
    expect(uploadedPath).toBe(f);
    expect(out).toMatch(/uploaded/);
    expect(out).toContain('upload-me.txt');
  });

  test('upload failure falls back to inline text', async () => {
    const tools = freshTools({ READ_FILE_UPLOAD: true, READ_FILE_UPLOAD_MIN_BYTES: 1 });
    tools.setAdapterProvider(() => ({
      async supportsUpload() { return true; },
      async uploadFile() { throw new Error('boom'); },
    }));
    const f = path.join(TMP, 'fail.txt');
    fs.writeFileSync(f, 'still-here', 'utf8');
    const out = await tools.executeTool('read_file', { path: f });
    expect(out).toContain('still-here');
    expect(out).not.toMatch(/uploaded/);
  });

  test('line-range reads never attempt upload', async () => {
    const tools = freshTools({ READ_FILE_UPLOAD: true, READ_FILE_UPLOAD_MIN_BYTES: 1 });
    let called = false;
    tools.setAdapterProvider(() => ({
      async supportsUpload() { return true; },
      async uploadFile() { called = true; return { ok: true, method: 'x' }; },
    }));
    const f = path.join(TMP, 'range.txt');
    fs.writeFileSync(f, 'a\nb\nc', 'utf8');
    const out = await tools.executeTool('read_file', { path: f, start_line: 2, end_line: 2 });
    expect(called).toBe(false);
    expect(out).toContain('b');
  });
});
