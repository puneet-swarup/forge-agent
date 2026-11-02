// tests/failure-capture.test.js — P3.1 diagnostic bundle
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { captureFailure, sanitizeLabel } = require('../src/failure-capture');

function makePage() {
  return {
    url: jest.fn().mockReturnValue('https://chat.deepseek.com/x'),
    // Mirror Playwright: when given { path }, the file is written to disk.
    screenshot: jest.fn().mockImplementation(({ path: p } = {}) => {
      if (p) fs.writeFileSync(p, 'PNG');
      return Promise.resolve(null);
    }),
    content: jest.fn().mockResolvedValue('<html><body>dom</body></html>'),
  };
}

describe('captureFailure (P3.1)', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  test('writes the four bundle files', async () => {
    const page = makePage();
    const dir = await captureFailure(page, 'send', { root, adapterName: 'DeepSeekAdapter' });
    expect(dir).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dom.html'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'url.txt'), 'utf8')).toContain('deepseek');
    expect(fs.readFileSync(path.join(dir, 'adapter.txt'), 'utf8')).toBe('DeepSeekAdapter');
  });

  test('creates the root dir if missing', async () => {
    const nested = path.join(root, 'a', 'b');
    const dir = await captureFailure(makePage(), 'x', { root: nested });
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('never throws when page is null', async () => {
    const dir = await captureFailure(null, 'noload', { root });
    expect(dir).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'url.txt'))).toBe(true);
  });

  test('swallows screenshot/content errors (best-effort)', async () => {
    const page = {
      url: () => { throw new Error('url boom'); },
      screenshot: jest.fn().mockRejectedValue(new Error('shot boom')),
      content: jest.fn().mockRejectedValue(new Error('dom boom')),
    };
    const dir = await captureFailure(page, 'boom', { root });
    expect(dir).toBeTruthy();
  });

  test('sanitizeLabel strips path separators and traversal', () => {
    expect(sanitizeLabel('../../etc/passwd')).not.toMatch(/[\/]/);
    expect(sanitizeLabel('a/b\\c')).toBe('a_b_c');
    expect(sanitizeLabel('')).toBe('failure');
    expect(sanitizeLabel(null)).toBe('failure');
  });

  test('label is used in the dir name (sanitised)', async () => {
    const dir = await captureFailure(makePage(), 'empty/streak', { root });
    expect(path.basename(dir)).toContain('empty_streak');
    expect(dir.startsWith(root)).toBe(true);
  });
});
