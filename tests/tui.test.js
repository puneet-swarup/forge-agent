'use strict';

const { TUI, color, colors, stripAnsi, truncate, padEnd, formatMs, formatClock, getWidth, supportsColor } = require('../src/tui');
const logger = require('../src/logger');

describe('TUI Utility Functions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NO_COLOR: '1' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('stripAnsi removes ANSI escape codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
  });

  test('stripAnsi handles string with no ANSI codes', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });

  test('stripAnsi handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  test('stripAnsi handles null/undefined gracefully', () => {
    expect(() => stripAnsi(null)).toThrow();
  });

  test('truncate returns unchanged string when under max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('truncate truncates and adds ellipsis when over max', () => {
    expect(truncate('this is too long', 10)).toBe('this is t…');
  });

  test('truncate result length equals max', () => {
    expect(stripAnsi(truncate('too long string', 10)).length).toBe(10);
  });

  test('truncate handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  test('truncate replaces newlines with spaces', () => {
    expect(truncate('line1\nline2', 20)).toBe('line1 line2');
  });

  test('padEnd pads string to specified length', () => {
    expect(padEnd('test', 10)).toBe('test      ');
  });

  test('padEnd does not shorten strings already at length', () => {
    expect(padEnd('too long string', 5)).toBe('too long string');
  });

  test('padEnd works with ANSI-colored strings', () => {
    const colored = '\x1b[31mred\x1b[0m';
    const padded = padEnd(colored, 10);
    expect(stripAnsi(padded).length).toBe(10);
    expect(padded).toContain('\x1b[31m');
  });

  test('formatMs shows ms for values under 1000', () => {
    expect(formatMs(500)).toBe('500ms');
  });

  test('formatMs shows s for values 1000-59999', () => {
    expect(formatMs(1500)).toBe('1.5s');
    expect(formatMs(59000)).toBe('59.0s');
  });

  test('formatClock returns zero-padded HH:MM:SS local time', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5); // 03:04:05 local
    expect(formatClock(d)).toBe('03:04:05');
    expect(formatClock(d.getTime())).toBe('03:04:05');
  });

  test('formatClock tolerates an invalid input with a placeholder', () => {
    expect(formatClock(new Date('not-a-date'))).toBe('--:--:--');
    expect(formatClock(NaN)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('formatMs shows m for values >= 60000', () => {
    expect(formatMs(65000)).toBe('1m5s');
    expect(formatMs(125000)).toBe('2m5s');
  });

  test('formatMs handles 0', () => {
    expect(formatMs(0)).toBe('0ms');
  });
});

describe('TUI Class', () => {
  let tui;

  beforeEach(() => {
    tui = new TUI({ noColor: true });
  });

  test('TUI instantiates with no options', () => {
    const t = new TUI();
    expect(t).toBeDefined();
  });

  test('TUI accepts compact option', () => {
    const t = new TUI({ compact: true });
    expect(t.compact).toBe(true);
  });

  test('TUI accepts debug option', () => {
    const t = new TUI({ debug: true });
    expect(t.debug).toBe(true);
  });

  test('renderTaskHeader does not throw and sets state', () => {
    expect(() => tui.renderTaskHeader('task', { model: 'm', profile: 'p' })).not.toThrow();
    expect(tui.model).toBe('m');
    expect(tui.profile).toBe('p');
    expect(tui.startTime).toBeLessThanOrEqual(Date.now());
  });

  test('renderStepLine does not throw', () => {
    expect(() => tui.renderStepLine(1, 1000, { filesWritten: new Set() })).not.toThrow();
  });

  test('renderStepLine shows simple step number', () => {
    let output = '';
    const originalPrint = tui._print;
    tui._print = (s) => { output = s; };
    tui.renderStepLine(5, 0, null);
    tui._print = originalPrint;
    expect(output).toContain('Step 5');
    expect(output).not.toContain('/100');
    // Every step line carries a [HH:MM:SS] wall-clock timestamp.
    expect(stripAnsi(output)).toMatch(/\[\d{2}:\d{2}:\d{2}\] Step 5/);
  });

  test('renderToolCall does not throw', () => {
    expect(() => tui.renderToolCall('test_tool', { arg: 'val' })).not.toThrow();
  });

  test('renderToolResult does not throw for success', () => {
    expect(() => tui.renderToolResult('test_tool', 'ok', false)).not.toThrow();
  });

  test('renderToolResult does not throw for error', () => {
    expect(() => tui.renderToolResult('test_tool', 'fail', true)).not.toThrow();
  });

  test('renderCompletion does not throw for various statuses', () => {
    expect(() => tui.renderCompletion(null, 'completed')).not.toThrow();
    expect(() => tui.renderCompletion(null, 'partial')).not.toThrow();
    expect(() => tui.renderCompletion(null, 'failed')).not.toThrow();
  });

  test('renderError does not throw', () => {
    expect(() => tui.renderError(new Error('test'))).not.toThrow();
    expect(() => tui.renderError('string error')).not.toThrow();
    expect(() => tui.renderError(null)).not.toThrow();
  });

  test('renderHealthCheck does not throw', () => {
    expect(() => tui.renderHealthCheck([])).not.toThrow();
    expect(() => tui.renderHealthCheck([{ name: 'c', status: 'pass', message: 'ok' }])).not.toThrow();
  });

  test('renderThinking does not throw', () => {
    expect(() => tui.renderThinking('')).not.toThrow();
    expect(() => tui.renderThinking('reasoning')).not.toThrow();
  });

  test('renderContextMeter does not throw', () => {
    expect(() => tui.renderContextMeter(5000, 10000)).not.toThrow();
  });

  test('renderWaiting and clearWaiting do not throw', () => {
    const originalTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    expect(() => tui.renderWaiting(1000, 100, 'model')).not.toThrow();
    expect(() => tui.clearWaiting()).not.toThrow();
    process.stdout.isTTY = originalTTY;
  });
});

describe('TUI Argument Extraction', () => {
  let tui;
  beforeEach(() => { tui = new TUI(); });

  test('extracts path from args', () => {
    expect(tui._extractArgPreview('t', { path: 'p' })).toBe('p');
  });

  test('extracts command from args', () => {
    expect(tui._extractArgPreview('t', { command: 'cmd' })).toBe('cmd');
  });

  test('extracts query from args', () => {
    expect(tui._extractArgPreview('t', { query: 'q' })).toBe('q');
  });

  test('returns empty string for null/empty args', () => {
    expect(tui._extractArgPreview('t', null)).toBe('');
    expect(tui._extractArgPreview('t', {})).toBe('');
  });
});

describe('Logger Integration', () => {
  test('logger.initTUI returns TUI instance', () => {
    const instance = logger.initTUI({});
    expect(instance instanceof TUI).toBe(true);
  });

  test('logger.getTUI returns same instance', () => {
    const i1 = logger.getTUI();
    const i2 = logger.getTUI();
    expect(i1).toBe(i2);
  });

  test('core logger methods do not throw', () => {
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
    expect(() => logger.dim('test')).not.toThrow();
    expect(() => logger.banner()).not.toThrow();
  });
});
  test('renderToolResult shows the outcome WITHOUT repeating the tool name', () => {
    const tui = new TUI({ noColor: true });
    let output = '';
    const originalPrint = tui._print;
    tui._print = (s) => { output += s + '\n'; };
    tui.renderToolResult('write_file', 'Wrote 2.1 KB', false);
    tui._print = originalPrint;
    const clean = stripAnsi(output);
    expect(clean).toContain('✓');
    expect(clean).toContain('Wrote 2.1 KB');
    // The tool name must NOT be repeated on the result line.
    expect(clean).not.toContain('write_file');
  });

  test('renderToolResult error shows ✗ and outcome only', () => {
    const tui = new TUI({ noColor: true });
    let output = '';
    const originalPrint = tui._print;
    tui._print = (s) => { output += s + '\n'; };
    tui.renderToolResult('run_command', 'command not found', true);
    tui._print = originalPrint;
    const clean = stripAnsi(output);
    expect(clean).toContain('✗');
    expect(clean).toContain('command not found');
    expect(clean).not.toContain('run_command');
  });

// ─────────────────────────────────────────────
//  Completion panel — aligned, honest, and free of width-ambiguous glyphs
// ─────────────────────────────────────────────

describe('renderCompletion panel', () => {
  function render(status, progress, opts) {
    const t = new TUI({ noColor: true });
    const out = [];
    t._print = (s) => out.push(s);
    t.startTime = Date.now() - 94_000;
    t.stepNum = 7;
    t.renderCompletion(progress, status, opts);
    return stripAnsi(out.join(''));
  }

  test('every line is the same width, so the box closes', () => {
    const out = render('completed', { filesWritten: new Map([['a', 'src/a.js']]) }, { verification: 'verified: npm test passed' });
    const widths = [...new Set(out.split('\n').filter(Boolean).map((l) => l.length))];
    expect(widths).toEqual([80]);
  });

  test('shows the verification result when given one', () => {
    const out = render('completed', null, { verification: 'verified: `npm test` passed' });
    expect(out).toContain('Verified');
    expect(out).toContain('npm test');
  });

  test('says "unverified" rather than implying success', () => {
    const out = render('completed', null, { verification: 'no project checks found — completion is unverified' });
    expect(out).toMatch(/unverified/i);
  });

  test('each status is labelled in words, not only in colour', () => {
    expect(render('completed', null)).toContain('Task complete');
    expect(render('partial', null)).toContain('Partial result');
    expect(render('timeout', null)).toContain('Timed out');
    expect(render('failed', null)).toContain('Failed');
  });

  test('carries no double-width glyph in the title', () => {
    // A ✓ or ✗ is double-width in some terminal fonts and pushes the right
    // border out by a column; the box must stay closed everywhere.
    const out = render('completed', null);
    const titleLine = out.split('\n').find((l) => l.includes('Task complete'));
    expect(titleLine).toBeTruthy();
    expect(titleLine).not.toMatch(/[✓✗✔✘]/);
  });

  test('lists at most six files and counts the rest', () => {
    const files = new Map();
    for (let i = 0; i < 9; i++) files.set(`f${i}`, `src/file${i}.js`);
    const out = render('completed', { filesWritten: files });

    expect(out).toContain('src/file0.js');
    expect(out).toContain('and 3 more');
    expect(out).not.toContain('src/file8.js');
  });
});
