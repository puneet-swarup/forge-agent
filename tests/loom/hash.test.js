// tests/loom/hash.test.js — spec §5.1–§5.2: hashing and the stat fast path.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const hash = require('../../src/loom/hash');

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-hash-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loom/hash.sha256Text', () => {
  it('matches the known vector for "abc"', () => {
    expect(hash.sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the empty string', () => {
    expect(hash.sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is stable across calls', () => {
    expect(hash.sha256Text('same')).toBe(hash.sha256Text('same'));
    expect(hash.sha256Text('a')).not.toBe(hash.sha256Text('b'));
  });
});

describe('loom/hash.sha256File', () => {
  it('hashes file bytes, not the path', () => {
    const a = path.join(tmp, 'a.txt');
    const b = path.join(tmp, 'b.txt');
    fs.writeFileSync(a, 'abc');
    fs.writeFileSync(b, 'abc');
    expect(hash.sha256File(a)).toBe(hash.sha256Text('abc'));
    expect(hash.sha256File(b)).toBe(hash.sha256File(a));
  });

  it('hashes multi-byte content correctly', () => {
    const file = path.join(tmp, 'u.txt');
    fs.writeFileSync(file, 'नमस्ते');
    expect(hash.sha256File(file)).toBe(hash.sha256Text('नमस्ते'));
  });

  it('throws on a missing file', () => {
    expect(() => hash.sha256File(path.join(tmp, 'nope.txt'))).toThrow();
  });
});

describe('loom/hash.safeSha256File', () => {
  it('returns null instead of throwing', () => {
    expect(hash.safeSha256File(path.join(tmp, 'nope.txt'))).toBeNull();
  });

  it('returns the hash when the file exists', () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'abc');
    expect(hash.safeSha256File(file)).toBe(hash.sha256Text('abc'));
  });
});

describe('loom/hash.statFile', () => {
  it('returns bytes and a truncated mtime', () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'hello');
    const stat = hash.statFile(file);
    expect(stat.bytes).toBe(5);
    expect(Number.isInteger(stat.mtimeMs)).toBe(true);
  });

  it('returns null for a missing path', () => {
    expect(hash.statFile(path.join(tmp, 'nope'))).toBeNull();
  });

  it('returns null for a directory', () => {
    expect(hash.statFile(tmp)).toBeNull();
  });
});

describe('loom/hash.statMatches', () => {
  it('is the fast negative: equal size and mtime means unchanged', () => {
    expect(hash.statMatches({ bytes: 10, mtimeMs: 5 }, { bytes: 10, mtime_ms: 5 })).toBe(true);
  });

  it('is false when the size differs', () => {
    expect(hash.statMatches({ bytes: 11, mtimeMs: 5 }, { bytes: 10, mtime_ms: 5 })).toBe(false);
  });

  it('is false when the mtime differs', () => {
    expect(hash.statMatches({ bytes: 10, mtimeMs: 6 }, { bytes: 10, mtime_ms: 5 })).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(hash.statMatches(null, { bytes: 1, mtime_ms: 1 })).toBe(false);
    expect(hash.statMatches({ bytes: 1, mtimeMs: 1 }, null)).toBe(false);
  });
});
