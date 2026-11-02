// tests/plan.test.js - baby-step plan protocol (scripts/plan.js)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPlan, setDone, formatStatus, progressBar, PLAN_FILE } = require('../scripts/plan');

const NL = String.fromCharCode(10);

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
});

function writePlan(lines) {
  fs.writeFileSync(path.join(dir, PLAN_FILE), lines.join(NL), 'utf8');
}

const SAMPLE = [
  '# FORGE_PLAN',
  '',
  '## Task: demo',
  '',
  '- [ ] A1. first step',
  '- [x] A2. second step',
  '- [ ] A3. third step',
];

describe('plan: readPlan', () => {
  test('returns null when no plan file exists', () => {
    expect(readPlan(dir)).toBeNull();
  });

  test('parses open and done items', () => {
    writePlan(SAMPLE);
    const p = readPlan(dir);
    expect(p.items).toHaveLength(3);
    expect(p.open).toHaveLength(2);
    expect(p.done).toHaveLength(1);
    expect(p.open[0].text).toContain('first step');
    expect(p.done[0].text).toContain('second step');
  });

  test('handles nested indented items', () => {
    writePlan(['- [ ] top', '  - [ ] nested one', '  - [ ] nested two']);
    const p = readPlan(dir);
    expect(p.items).toHaveLength(3);
  });
});

describe('plan: setDone', () => {
  test('ticks the nth item', () => {
    writePlan(SAMPLE);
    setDone(dir, 1, true);
    const p = readPlan(dir);
    expect(p.items[0].done).toBe(true);
    expect(p.open).toHaveLength(1);
  });

  test('untick reverts an item', () => {
    writePlan(SAMPLE);
    setDone(dir, 2, false);
    const p = readPlan(dir);
    expect(p.items[1].done).toBe(false);
  });

  test('n is 1-based across all checkbox lines', () => {
    writePlan(SAMPLE);
    setDone(dir, 3, true);
    const p = readPlan(dir);
    expect(p.items[2].done).toBe(true);
    expect(p.items[0].done).toBe(false);
  });

  test('out-of-range n throws', () => {
    writePlan(SAMPLE);
    expect(() => setDone(dir, 9, true)).toThrow(/out of range/);
    expect(() => setDone(dir, 0, true)).toThrow(/out of range/);
  });

  test('missing plan file throws a clear error', () => {
    expect(() => setDone(dir, 1, true)).toThrow(/no plan file/);
  });

  test('preserves non-checkbox lines exactly', () => {
    writePlan(SAMPLE);
    setDone(dir, 1, true);
    const raw = fs.readFileSync(path.join(dir, PLAN_FILE), 'utf8');
    expect(raw).toContain('# FORGE_PLAN');
    expect(raw).toContain('## Task: demo');
  });

  test('is idempotent - ticking twice is safe', () => {
    writePlan(SAMPLE);
    setDone(dir, 1, true);
    setDone(dir, 1, true);
    const p = readPlan(dir);
    expect(p.done).toHaveLength(2);
  });
});

describe('plan: progress display', () => {
  test('progressBar fills proportionally', () => {
    expect(progressBar(0, 10, 10)).toBe('[..........]');
    expect(progressBar(5, 10, 10)).toBe('[#####.....]');
    expect(progressBar(10, 10, 10)).toBe('[##########]');
  });

  test('progressBar with zero total is empty', () => {
    expect(progressBar(0, 0, 10)).toBe('');
  });

  test('formatStatus reports counts and percent', () => {
    writePlan(SAMPLE);
    const s = formatStatus(readPlan(dir));
    expect(s).toContain('1/3');
    expect(s).toContain('33%');
  });

  test('formatStatus handles missing plan', () => {
    expect(formatStatus(null)).toContain('No FORGE_PLAN.md');
  });
});
