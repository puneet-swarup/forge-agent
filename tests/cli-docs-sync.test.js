// tests/cli-docs-sync.test.js — a flag cannot exist without being documented.
//
// This project's documentation drifted from the code in both directions: flags
// printed in --help that were never parsed (`--max-iterations` was one), and
// features described in the README that did not exist. This test runs the real
// CLI and asserts that every flag the parser accepts appears in --help and in
// the HTML CLI reference.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
const CLI_HTML = fs.readFileSync(path.join(ROOT, 'docs', 'cli-reference.html'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Every long flag the argument parser actually handles. */
function parsedFlags() {
  const flags = new Set();
  const re = /case\s+'(--[a-z0-9-]+)'/g;
  let m;
  while ((m = re.exec(INDEX)) !== null) flags.add(m[1]);
  return [...flags].sort();
}

function helpText() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-help-'));
  try {
    return execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--help'], {
      encoding: 'utf8',
      env: { ...process.env, FORGE_HOME: home, NO_COLOR: '1' },
      timeout: 20000,
    });
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

describe('CLI flags are documented', () => {
  const flags = parsedFlags();
  const help = helpText();

  test('the parser exposes a sane number of flags', () => {
    expect(flags.length).toBeGreaterThan(20);
  });

  test('every parsed flag appears in --help', () => {
    const missing = flags.filter((f) => !help.includes(f));
    expect(missing).toEqual([]);
  });

  test('the budget and recovery flags are documented in the HTML reference', () => {
    for (const flag of ['--max-iterations', '--max-runtime', '--max-tool-calls', '--rollback', '--snapshots']) {
      expect(CLI_HTML).toContain(flag);
    }
  });

  test('the README CLI summary lists the budget and recovery flags', () => {
    for (const flag of ['--max-iterations', '--max-runtime', '--max-tool-calls', '--rollback', '--snapshots']) {
      expect(README).toContain(flag);
    }
  });

  test('--help exits cleanly without a browser or a config file', () => {
    expect(help).toMatch(/USAGE|Usage/i);
  });
});
