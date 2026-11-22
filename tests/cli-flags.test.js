// tests/cli-flags.test.js — the CLI parser, tested directly.
//
// The parser now runs behind `require.main === module`, so it can be exercised
// without launching the agent. That matters because three bugs this session
// lived in it: `--model=<name>` was never parsed, `--diagnose` read the saved
// config instead of `--model`, and eleven documented `--flag=value` forms were
// silently ignored.
//
// The rule this file enforces: a flag the CLI does not understand must be
// REPORTED, not absorbed.
'use strict';

const { parseArgs, closestFlags, KNOWN_FLAGS } = require('../src/index');

const parse = (...argv) => parseArgs(['node', 'forge-agent', ...argv]);

describe('both flag forms parse', () => {
  test('--model value and --model=value agree', () => {
    expect(parse('--model', 'sarvam').model).toBe('sarvam');
    expect(parse('--model=sarvam').model).toBe('sarvam');
  });

  test('the diagnostic commands accept their own model', () => {
    expect(parse('--diagnose=sarvam').diagnose).toBe('sarvam');
    expect(parse('--test-model=qwen').testModel).toBe('qwen');
  });

  test('a bare flag is boolean, a valued one carries its string', () => {
    expect(parse('--diagnose').diagnose).toBe(true);
    expect(parse('--headed').headed).toBe(true);
    expect(parse('--no-loom').noLoom).toBe(true);
  });
});

describe('the positional task survives flags around it', () => {
  test('a task after flags is captured whole', () => {
    expect(parse('--model=sarvam', 'read', 'package.json').task).toBe('read package.json');
  });

  test('a task before flags is not overwritten by them', () => {
    const args = parse('do the thing', '--model=gemini');
    expect(args.task).toBe('do the thing');
  });
});

describe('unknown flags are reported, never silent', () => {
  test('an unknown long flag is recorded', () => {
    expect(parse('--bogus')._unknown).toEqual(['--bogus']);
  });

  test('an unknown --flag=value is recorded without its value', () => {
    expect(parse('--other=1')._unknown).toEqual(['--other']);
  });

  test('a known flag is never reported', () => {
    expect(parse('--model=sarvam', '--debug')._unknown).toEqual([]);
  });

  test('an unknown flag does not become the task', () => {
    const args = parse('--bogus', 'real task');
    expect(args._unknown).toEqual(['--bogus']);
    expect(args.task).toBe('real task');
  });
});

describe('did-you-mean', () => {
  test('a transposition suggests the intended flag', () => {
    expect(closestFlags(['--modle'])).toContain('--model');
  });

  test('a missing letter suggests the intended flag', () => {
    expect(closestFlags(['--diagonse'])).toContain('--diagnose');
    expect(closestFlags(['--no-lom'])).toContain('--no-loom');
  });

  test('nonsense suggests nothing rather than something wrong', () => {
    expect(closestFlags(['--zzzzz'])).toEqual([]);
  });

  test('a suggestion is always a known flag', () => {
    for (const typo of ['--modle', '--diagonse', '--provile', '--no-lom']) {
      for (const suggestion of closestFlags([typo])) {
        expect(KNOWN_FLAGS.has(suggestion)).toBe(true);
      }
    }
  });
});

describe('the known-flag set keeps up with the parser', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  test('every flag documented in --help is known', () => {
    // The help is the promise; an unknown flag is a broken promise.
    const documented = [...src.matchAll(/^\s{6}(--[a-z][a-z-]*)/gm)].map((m) => m[1]);
    const missing = [...new Set(documented)].filter((f) => !KNOWN_FLAGS.has(f));
    expect(missing).toEqual([]);
  });

  test('every flag the parser handles is known', () => {
    const cases = [...src.matchAll(/case '(--[a-z][a-z-]*)':/g)].map((m) => m[1]);
    const missing = [...new Set(cases)].filter((f) => !KNOWN_FLAGS.has(f));
    expect(missing).toEqual([]);
  });
});
