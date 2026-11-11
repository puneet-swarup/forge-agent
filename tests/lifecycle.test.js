// tests/lifecycle.test.js - mandatory artifact protocol (src/lifecycle + scripts/lifecycle)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ARTIFACTS,
  getArtifact,
  requiredAtStart,
  requiredCompleteAtEnd,
  renderArtifactTable,
} = require('../src/lifecycle');
const { checkStart, checkEnd, parseCheckboxItems, PLAN_FILE } = require('../scripts/lifecycle');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lifecycle-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
});

function write(file, content) {
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
}

const PLAN_DONE = ['# FORGE_PLAN', '', '- [x] step one', '- [x] step two'].join('\n');
const PLAN_OPEN = ['# FORGE_PLAN', '', '- [x] step one', '- [ ] step two'].join('\n');

describe('lifecycle: artifact contract', () => {
  test('every artifact has file, owner, purpose and lifecycle', () => {
    expect(ARTIFACTS.length).toBeGreaterThanOrEqual(5);
    ARTIFACTS.forEach(a => {
      expect(typeof a.file).toBe('string');
      expect(a.file.endsWith('.md')).toBe(true);
      expect(['agent', 'human']).toContain(a.owner);
      expect(a.purpose.length).toBeGreaterThan(10);
      expect(a.lifecycle.length).toBeGreaterThan(10);
    });
  });

  test('FORGE_PLAN.md is agent-owned, required at start and complete at end', () => {
    const plan = getArtifact('FORGE_PLAN.md');
    expect(plan).not.toBeNull();
    expect(plan.owner).toBe('agent');
    expect(plan.requiredAtStart).toBe(true);
    expect(plan.mustBeCompleteAtEnd).toBe(true);
  });

  test('human-owned artifacts are never required at start', () => {
    ARTIFACTS.filter(a => a.owner === 'human').forEach(a => {
      expect(a.requiredAtStart).toBe(false);
    });
  });

  test('requiredAtStart includes FORGE_PLAN.md', () => {
    expect(requiredAtStart()).toContain('FORGE_PLAN.md');
  });

  test('requiredCompleteAtEnd includes FORGE_PLAN.md', () => {
    expect(requiredCompleteAtEnd()).toContain('FORGE_PLAN.md');
  });

  test('renderArtifactTable mentions every artifact', () => {
    const table = renderArtifactTable();
    ARTIFACTS.forEach(a => expect(table).toContain(a.file));
  });

  test('getArtifact returns null for unknown file', () => {
    expect(getArtifact('NOPE.md')).toBeNull();
  });
});

describe('lifecycle: parseCheckboxItems', () => {
  test('parses only checkbox lines', () => {
    const items = parseCheckboxItems('# header\n- plain\n- [ ] a\n- [x] b');
    expect(items).toHaveLength(2);
    expect(items[0].done).toBe(false);
    expect(items[1].done).toBe(true);
  });
});

describe('lifecycle: check-start', () => {
  test('fails when FORGE_PLAN.md is missing', () => {
    const errors = checkStart(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('FORGE_PLAN.md');
  });

  test('fails when FORGE_PLAN.md has no checkbox steps', () => {
    write(PLAN_FILE, '# FORGE_PLAN\nno steps here');
    const errors = checkStart(dir);
    expect(errors.join(' ')).toContain('no "- [ ]" steps');
  });

  test('passes when FORGE_PLAN.md has at least one step', () => {
    write(PLAN_FILE, PLAN_OPEN);
    expect(checkStart(dir)).toHaveLength(0);
  });
});

describe('lifecycle: check-end', () => {
  test('fails when plan is missing at sign-off', () => {
    expect(checkEnd(dir).join(' ')).toContain('FORGE_PLAN.md');
  });

  test('fails when plan has unchecked steps', () => {
    write(PLAN_FILE, PLAN_OPEN);
    const errors = checkEnd(dir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('unchecked step');
    expect(errors[0]).toContain('step two');
  });

  test('passes when every step is ticked', () => {
    write(PLAN_FILE, PLAN_DONE);
    expect(checkEnd(dir)).toHaveLength(0);
  });
});
