'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeRawResponse } = require('../src/raw-log');

describe('raw response log (--debug)', () => {
  let tmpDir;
  let fakePaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-raw-'));
    fakePaths = {
      forgePath: (...parts) => path.join(tmpDir, ...parts),
    };
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('writes the raw text to logs/last-raw-response.txt', () => {
    const raw = 'tool_call\n{"name":"show_info"}\n';
    const file = writeRawResponse(raw, { paths: fakePaths });
    expect(file).toBe(path.join(tmpDir, 'logs', 'last-raw-response.txt'));
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  test('creates the logs dir if missing', () => {
    const file = writeRawResponse('hi', { paths: fakePaths });
    expect(fs.existsSync(path.dirname(file))).toBe(true);
  });

  test('overwrites on each call (keeps only the last response)', () => {
    writeRawResponse('first', { paths: fakePaths });
    const file = writeRawResponse('second', { paths: fakePaths });
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });

  test('non-string input is a no-op returning null', () => {
    expect(writeRawResponse(null, { paths: fakePaths })).toBeNull();
    expect(writeRawResponse({ a: 1 }, { paths: fakePaths })).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'logs'))).toBe(false);
  });

  test('never throws when forgePath throws (best-effort)', () => {
    const badPaths = {
      forgePath: () => { throw new Error('boom'); },
    };
    expect(() => writeRawResponse('x', { paths: badPaths })).not.toThrow();
    expect(writeRawResponse('x', { paths: badPaths })).toBeNull();
  });
});
