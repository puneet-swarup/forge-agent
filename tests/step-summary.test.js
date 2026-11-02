// tests/step-summary.test.js - deterministic step-line descriptors.
// NOTE: this file deliberately contains NO backslashes and NO literal
// tab/newline characters inside strings. Whitespace is built at runtime with
// String.fromCharCode so the file survives the agent write transport intact.
'use strict';

const { describeStep, summariseTarget, VERBS, _clamp, _squeeze } = require('../src/step-summary');

const C = String.fromCharCode;
const TAB = C(9);
const LF = C(10);
const ELLIPSIS = C(8230);

describe('step-summary: describeStep states', () => {
  test('waiting state is explicit', () => {
    expect(describeStep({ state: 'waiting' })).toBe('waiting for model response');
  });

  test('answering state', () => {
    expect(describeStep({ state: 'answering' })).toBe('rendering answer');
  });

  test('starting state', () => {
    expect(describeStep({ state: 'starting' })).toContain('starting');
  });

  test('defaults to working', () => {
    expect(describeStep({})).toBe('working');
  });
});

describe('step-summary: describeStep current intent', () => {
  test('uses the current tool', () => {
    expect(describeStep({ tool: 'read_file', args: { path: 'src/tools.js' } })).toBe('reading tools.js');
  });

  test('run_command shows only the first clause', () => {
    const s = describeStep({ tool: 'run_command', args: { command: 'npm test && echo done' } });
    expect(s).toBe('running npm test');
    expect(s).not.toContain('echo done');
  });

  test('write_files summarises the count', () => {
    const s = describeStep({ tool: 'write_files', args: { files: [{ path: 'a' }, { path: 'b' }] } });
    expect(s).toBe('writing 2 files');
  });

  test('falls back to lastTool', () => {
    expect(describeStep({ lastTool: 'read_file', lastTarget: 'b.txt' })).toBe('reading b.txt');
  });

  test('unknown tool degrades gracefully', () => {
    expect(describeStep({ tool: 'mystery_tool', args: {} })).toBe('using mystery_tool');
  });
});

describe('step-summary: width clamping', () => {
  test('long command is clamped with ellipsis', () => {
    const s = describeStep({ tool: 'run_command', args: { command: 'a'.repeat(200) }, maxLen: 60 });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith(ELLIPSIS)).toBe(true);
  });

  test('short descriptor is not clamped', () => {
    const s = describeStep({ tool: 'read_file', args: { path: 'a.js' }, maxLen: 60 });
    expect(s).toBe('reading a.js');
    expect(s).not.toContain(ELLIPSIS);
  });

  test('custom maxLen is respected', () => {
    const s = describeStep({ tool: 'run_command', args: { command: 'x'.repeat(100) }, maxLen: 20 });
    expect(s.length).toBeLessThanOrEqual(20);
  });

  test('_clamp collapses whitespace runs', () => {
    const messy = 'a' + ' ' + ' ' + ' ' + ' ' + 'b' + LF + TAB + 'c';
    expect(_clamp(messy, 40)).toBe('a b c');
  });
});

describe('step-summary: _squeeze', () => {
  test('collapses spaces, tabs and newlines', () => {
    const messy = 'a' + ' ' + ' ' + TAB + LF + ' b';
    expect(_squeeze(messy)).toBe('a b');
  });

  test('trims edges', () => {
    expect(_squeeze('   hi   ')).toBe('hi');
  });

  test('handles null', () => {
    expect(_squeeze(null)).toBe('');
  });
});

describe('step-summary: summariseTarget', () => {
  test('basename for file paths', () => {
    expect(summariseTarget('read_file', { path: 'a/b/c.js' })).toBe('c.js');
  });

  test('move shows source to destination', () => {
    expect(summariseTarget('move_file', { source: 'x/a.js', destination: 'y/b.js' })).toBe('a.js -> b.js');
  });

  test('install_package lists up to three', () => {
    const r = summariseTarget('install_package', { packages: ['a', 'b', 'c', 'd'] });
    expect(r).toContain('a, b, c');
    expect(r).toContain('+1');
  });

  test('read_url shows hostname', () => {
    expect(summariseTarget('read_url', { url: 'https://example.com/docs/page' })).toBe('example.com');
  });

  test('search_in_files combines pattern and dir', () => {
    expect(summariseTarget('search_in_files', { pattern: 'TODO', directory: 'src/lib' })).toBe('TODO in src/lib');
  });

  test('empty for unusable args', () => {
    expect(summariseTarget('git_status', {})).toBe('');
    expect(summariseTarget('read_file', null)).toBe('');
  });

  test('VERBS covers wired tools', () => {
    ['read_file', 'write_file', 'run_command', 'install_package', 'spawn_agent'].forEach(function (t) {
      expect(typeof VERBS[t]).toBe('string');
      expect(VERBS[t].length).toBeGreaterThan(0);
    });
  });
});
