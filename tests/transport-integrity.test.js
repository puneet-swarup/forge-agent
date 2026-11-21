// tests/transport-integrity.test.js — a payload that arrives altered never
// reaches the disk.
//
// Tool arguments cross a lossy channel: the model writes text, the browser
// renders it, the scraper extracts it, the parser unescapes it. Any step can
// drop a character. A truncated write is worse than a failed write, because the
// tool reports success — so a supplied hash is verified and a mismatch throws
// before anything is written.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const {
  decodeTransportArg, encodeTransportArg, md5hex, isMd5,
} = require('../src/transport');

describe('md5hex / isMd5', () => {
  test('matches the known digest of a string', () => {
    expect(md5hex('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  test('hashes a Buffer byte-for-byte', () => {
    expect(md5hex(Buffer.from([0x00, 0xff]))).toBe(md5hex(Buffer.from([0x00, 0xff])));
  });

  test('recognises a well-formed digest', () => {
    expect(isMd5('5d41402abc4b2a76b9719d911017c592')).toBe(true);
    expect(isMd5('5D41402ABC4B2A76B9719D911017C592')).toBe(true);
    expect(isMd5('nope')).toBe(false);
    expect(isMd5('')).toBe(false);
    expect(isMd5(null)).toBe(false);
  });
});

describe('encodeTransportArg', () => {
  test('base64 round-trips byte-exactly', () => {
    const original = 'const x = 1;\n// $var {braces} `ticks`\n';
    const enc = encodeTransportArg(original);

    expect(enc.is_base64).toBe(true);
    expect(enc.is_hex).toBe(false);

    const dec = decodeTransportArg(enc.value, {
      isBase64: true, md5: enc.md5, label: 'content',
    });

    expect(dec.text).toBe(original);
    expect(dec.verified).toBe(true);
  });

  test('hex round-trips byte-exactly', () => {
    const original = 'line one\nline two\n';
    const enc = encodeTransportArg(original, 'hex');

    expect(enc.is_hex).toBe(true);
    expect(enc.value).toMatch(/^[0-9a-f]+$/);

    const dec = decodeTransportArg(enc.value, {
      isHex: true, md5: enc.md5, label: 'content',
    });

    expect(dec.text).toBe(original);
  });

  test('rejects an unknown encoding', () => {
    expect(() => encodeTransportArg('x', 'rot13')).toThrow(/unknown encoding/);
  });

  test('10 KB of random bytes survive base64 and hex', () => {
    const buf = require('crypto').randomBytes(10 * 1024);

    const b64 = encodeTransportArg(buf);
    const viaB64 = decodeTransportArg(b64.value, { isBase64: true, md5: b64.md5, label: 'content' });
    expect(Buffer.compare(viaB64.buffer, buf)).toBe(0);

    const hex = encodeTransportArg(buf, 'hex');
    const viaHex = decodeTransportArg(hex.value, { isHex: true, md5: hex.md5, label: 'content' });
    expect(Buffer.compare(viaHex.buffer, buf)).toBe(0);
  });
});

describe('decodeTransportArg — integrity', () => {
  test('a tampered payload is refused', () => {
    const enc = encodeTransportArg('the real content');
    const tampered = Buffer.from('the fake content').toString('base64');

    expect(() => decodeTransportArg(tampered, {
      isBase64: true, md5: enc.md5, label: 'content',
    })).toThrow(/failed its MD5 integrity check/);
  });

  test('a malformed hash is refused rather than ignored', () => {
    const enc = encodeTransportArg('x');
    expect(() => decodeTransportArg(enc.value, {
      isBase64: true, md5: 'not-a-hash', label: 'content',
    })).toThrow(/md5 must be 32 hex characters/);
  });

  test('no hash means legacy behaviour: decode, do not verify', () => {
    const enc = encodeTransportArg('plain');
    const dec = decodeTransportArg(enc.value, { isBase64: true, label: 'content' });
    expect(dec.text).toBe('plain');
    expect(dec.verified).toBe(false);
  });

  test('the legacy positional signature still works', () => {
    const enc = encodeTransportArg('legacy call');
    const dec = decodeTransportArg(enc.value, true, 'content');
    expect(dec.text).toBe('legacy call');
    expect(dec.verified).toBe(false);
  });

  test('invalid base64 and invalid hex both fail loudly', () => {
    expect(() => decodeTransportArg('!!not base64!!', { isBase64: true, label: 'x' }))
      .toThrow(/not valid base64/);
    expect(() => decodeTransportArg('abc', { isHex: true, label: 'x' }))
      .toThrow(/odd number of digits/);
    expect(() => decodeTransportArg('zz', { isHex: true, label: 'x' }))
      .toThrow(/not valid hex/);
  });
});

describe('tools honour the hash', () => {
  let workdir;
  let orig;
  let executeTool;

  beforeEach(() => {
    const config = require('../src/config');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tr-'));
    orig = { WORKING_DIR: config.WORKING_DIR, MEMORY_ENABLED: config.MEMORY_ENABLED };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    ({ executeTool } = require('../src/tools'));
  });

  afterEach(() => {
    Object.assign(require('../src/config'), orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('write_file with a matching md5 writes and reports verification', async () => {
    const content = 'const a = "$x";\nconst b = `y`;\n';
    const enc = encodeTransportArg(content);

    const res = await executeTool('write_file', {
      path: 'a.js',
      content: enc.value,
      is_base64: true,
      content_md5: enc.md5,
    });

    expect(fs.readFileSync(path.join(workdir, 'a.js'), 'utf8')).toBe(content);
    expect(res).toContain('integrity verified');
  });

  test('write_file with a mismatched md5 writes nothing', async () => {
    const enc = encodeTransportArg('good content');

    await expect(executeTool('write_file', {
      path: 'b.js',
      content: Buffer.from('corrupted content').toString('base64'),
      is_base64: true,
      content_md5: enc.md5,
    })).rejects.toThrow(/integrity check/);

    expect(fs.existsSync(path.join(workdir, 'b.js'))).toBe(false);
  });

  test('write_file accepts hex with a hash', async () => {
    const content = 'hex payload\n';
    const enc = encodeTransportArg(content, 'hex');

    await executeTool('write_file', {
      path: 'c.txt', content: enc.value, is_hex: true, content_md5: enc.md5,
    });

    expect(fs.readFileSync(path.join(workdir, 'c.txt'), 'utf8')).toBe(content);
  });

  test('append_to_file verifies the appended chunk', async () => {
    fs.writeFileSync(path.join(workdir, 'd.txt'), 'first\n', 'utf8');
    const enc = encodeTransportArg('second\n');

    await executeTool('append_to_file', {
      path: 'd.txt', content: enc.value, is_base64: true, content_md5: enc.md5,
    });

    expect(fs.readFileSync(path.join(workdir, 'd.txt'), 'utf8')).toBe('first\nsecond\n');
  });

  test('replace_in_file verifies find and replace independently', async () => {
    fs.writeFileSync(path.join(workdir, 'e.js'), 'const A = 1;\n', 'utf8');
    const find = encodeTransportArg('const A = 1;');
    const repl = encodeTransportArg('const A = 2;');

    await executeTool('replace_in_file', {
      path: 'e.js',
      find: find.value,
      replace: repl.value,
      is_base64: true,
      find_md5: find.md5,
      replace_md5: repl.md5,
    });

    expect(fs.readFileSync(path.join(workdir, 'e.js'), 'utf8')).toBe('const A = 2;\n');
  });

  test('a bad replace hash leaves the file untouched', async () => {
    fs.writeFileSync(path.join(workdir, 'f.js'), 'const A = 1;\n', 'utf8');
    const find = encodeTransportArg('const A = 1;');
    const repl = encodeTransportArg('const A = 2;');

    await expect(executeTool('replace_in_file', {
      path: 'f.js',
      find: find.value,
      replace: repl.value,
      is_base64: true,
      find_md5: find.md5,
      replace_md5: md5hex('something else'),
    })).rejects.toThrow(/integrity check/);

    expect(fs.readFileSync(path.join(workdir, 'f.js'), 'utf8')).toBe('const A = 1;\n');
  });

  test('write_files verifies each item', async () => {
    const a = encodeTransportArg('AAA');
    const b = encodeTransportArg('BBB');

    await executeTool('write_files', {
      files: [
        { path: 'g1.txt', content: a.value, is_base64: true, content_md5: a.md5 },
        { path: 'g2.txt', content: b.value, is_base64: true, content_md5: b.md5 },
      ],
    });

    expect(fs.readFileSync(path.join(workdir, 'g1.txt'), 'utf8')).toBe('AAA');
    expect(fs.readFileSync(path.join(workdir, 'g2.txt'), 'utf8')).toBe('BBB');
  });
});
