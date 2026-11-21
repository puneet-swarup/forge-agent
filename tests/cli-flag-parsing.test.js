// tests/cli-flag-parsing.test.js — `--flag=value` must work for every flag the
// help documents with an `=`.
//
// `--model=gemini` was never parsed: only `--model gemini` was. Every example in
// the README and the help text uses `=`, so the flag was silently ignored and the
// run used whatever the config file held — which is how `--model=sarvam
// --diagnose` ended up diagnosing ChatGPT.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

/** Flags the code handles in the two-token form. */
function twoTokenFlags() {
  return [...SRC.matchAll(/case '(--[a-z][a-z-]*)':\s*\n?\s*opts\.\w+\s*=\s*args\[\+\+i\]/g)]
    .map((m) => m[1]);
}

describe('CLI flag parsing', () => {
  test('every flag documented as --flag=<x> is parsed with an equals sign', () => {
    // The help text is the promise; the parser must keep it.
    // `--flag=<value>` inside a comment is prose, not a documented flag.
    const documented = [...SRC.matchAll(/--([a-z][a-z-]+)=</g)]
      .map((m) => `--${m[1]}`)
      .filter((flag) => flag !== '--flag');
    const unique = [...new Set(documented)];

    // A flag is parsed either by a bespoke startsWith branch or by the generic
    // --flag=value table.
    const missing = unique.filter((flag) =>
      !SRC.includes(`startsWith('${flag}=')`) && !SRC.includes(`'${flag}': `)
    );
    expect(missing).toEqual([]);
  });

  test('--model= is handled, not just --model', () => {
    expect(SRC).toContain("startsWith('--model=')");
  });

  test('the two-token form still works', () => {
    expect(SRC).toMatch(/case '--model':\s*\n\s*opts\.model = args\[\+\+i\]/);
  });

  test('the diagnostic commands prefer the explicit model over the saved default', () => {
    expect(SRC).toContain('(typeof args.diagnose === \'string\' && args.diagnose)');
    expect(SRC).toContain('(typeof args.testModel === \'string\' && args.testModel)');
  });
});
