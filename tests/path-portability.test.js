// tests/path-portability.test.js — the code must not assume a POSIX filesystem.
//
// T5 of the handoff: "make Forge Agent OS path-agnostic". The audit found one
// hardcoded POSIX path left in src/ (the calibration screenshot) and
// Unix-only advice in the permission error hints. This suite locks both down
// and guards against new ones appearing.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('no hardcoded POSIX paths in src/', () => {
  test('nothing writes to a literal /tmp path', () => {
    const offenders = [];

    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      // A string literal starting with /tmp or /var/tmp — a path, not a regex
      // or a comment mentioning one.
      if (/['"`]\/(?:var\/)?tmp\//.test(src)) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  test('calibrate uses the forge paths helper for its screenshot', () => {
    const src = fs.readFileSync(path.join(SRC, 'calibrate.js'), 'utf8');
    expect(src).toMatch(/forgePath\('logs',\s*'calibrate\.png'\)/);
  });
});

describe('platform-aware advice', () => {
  test('permission hints offer a Windows command on win32', () => {
    const src = fs.readFileSync(path.join(SRC, 'errors.js'), 'utf8');
    expect(src).toMatch(/process\.platform === 'win32'/);
    expect(src).toMatch(/icacls/);
    expect(src).toMatch(/chmod 644/);
  });

  test('the error module loads on this platform', () => {
    expect(() => require('../src/errors')).not.toThrow();
  });
});

describe('paths helper is platform-neutral', () => {
  test('forgePath builds under the forge home, not a fixed root', () => {
    const paths = require('../src/paths');
    const p = paths.forgePath('logs', 'x.png');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith(path.join('logs', 'x.png'))).toBe(true);
    expect(p).not.toMatch(/^\/tmp\//);
  });

  test('a path built from a temp dir round-trips through path.relative', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-path-'));
    const file = path.join(dir, 'sub', 'a.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');

    const rel = path.relative(dir, file);
    expect(rel).toBe(path.join('sub', 'a.js'));
    expect(path.resolve(dir, rel)).toBe(file);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
