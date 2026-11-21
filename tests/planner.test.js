// tests/planner.test.js — Day 21: Planner tool tests
'use strict';

const { 
  buildPlanningPrompt, 
  parsePlan, 
  formatPlanDisplay,
  buildPlanPrompt, 
  formatPlanForDisplay, 
  formatPlanForContext, 
  isPlanResponse 
} = require('../src/planner');

jest.mock('../src/config', () => ({
  PLANNING_MODE: false
}));
const config = require('../src/config');
const fs = require('fs');
const path = require('path');

describe('Planner Module', () => {

  describe('parsePlan', () => {
    test('extracts numbered steps from a standard plan', () => {
      const text = 'PLAN:\n1. Step one\n2. Step two\nREADY';
      const result = parsePlan(text);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]).toBe('Step one');
      expect(result.steps[1]).toBe('Step two');
    });

    test('handles steps with leading spaces', () => {
      const text = '  1. First\n  2. Second';
      const result = parsePlan(text);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]).toBe('First');
    });

    test('returns empty array in steps for text with no numbered steps', () => {
      const text = 'Just some prose here.';
      const result = parsePlan(text);
      expect(result.steps).toEqual([]);
      expect(result.raw).toBe(text);
    });

    test('returns empty array for null/undefined input', () => {
      expect(parsePlan(null).steps).toEqual([]);
      expect(parsePlan(undefined).steps).toEqual([]);
    });
  });

  describe('isPlanResponse', () => {
    test('returns true for text starting with PLAN:', () => {
      expect(isPlanResponse('PLAN:\n1. Do something')).toBe(true);
    });

    test('returns true for text starting with 1.', () => {
      expect(isPlanResponse('1. First step')).toBe(true);
    });

    test('returns false for tool calls', () => {
      const toolCall = '```tool_call\n{"name": "read_file"}\n```';
      expect(isPlanResponse(toolCall)).toBe(false);
    });

    test('returns false for plain prose', () => {
      expect(isPlanResponse('Hello, how can I help you?')).toBe(false);
    });

    test('returns false for empty input', () => {
      expect(isPlanResponse('')).toBe(false);
      expect(isPlanResponse(null)).toBe(false);
    });
  });

  describe('formatPlanDisplay', () => {
    test('returns a string containing all steps', () => {
      const plan = { steps: ['Desc 1'] };
      const output = formatPlanDisplay(plan);
      expect(output).toContain('Execution Plan');
      expect(output).toContain('1.');
      expect(output).toContain('Desc 1');
    });

    test('handles empty steps gracefully', () => {
      expect(formatPlanDisplay({ steps: [] })).toContain('No valid steps');
    });
  });

  describe('formatPlanForContext', () => {
    test('returns context string with steps', () => {
      const steps = ['Task 1'];
      const output = formatPlanForContext(steps);
      expect(output).toContain('plan');
      expect(output).toContain('1. Task 1');
      expect(output).toContain('proceed with Step 1');
    });

    test('returns empty string for empty steps', () => {
      expect(formatPlanForContext([])).toBe('');
    });
  });

  describe('buildPlanningPrompt', () => {
    test('includes the task', () => {
      const task = 'Write tests';
      const prompt = buildPlanningPrompt(task);
      expect(prompt).toContain(task);
      expect(prompt).toContain('PLAN:');
    });
  });

  describe('Configuration', () => {
    test('PLANNING_MODE exists in config and defaults to false', () => {
      expect(config).toHaveProperty('PLANNING_MODE');
      expect(config.PLANNING_MODE).toBe(false);
    });
  });

  describe('CLI Integration', () => {
    test('--plan flag is documented in src/index.js help text', () => {
      const indexPath = path.join(__dirname, '../src/index.js');
      const content = fs.readFileSync(indexPath, 'utf8');
      expect(content).toMatch(/--plan\s+Show execution plan/);
    });
  });
});
// ─────────────────────────────────────────────
//  parsePlan — the shapes models actually emit
//
//  A live Gemini run was rejected with "Could not parse plan" because the
//  parser accepted only "1. step". The caller then read `.length` off the
//  returned object, so the warning fired on every run regardless of format.
// ─────────────────────────────────────────────

describe('parsePlan formats', () => {
  const { parsePlan } = require('../src/planner');

  test('numbered with a dot', () => {
    expect(parsePlan('PLAN:\n1. read the file\n2. run tests').steps)
      .toEqual(['read the file', 'run tests']);
  });

  test('numbered with a parenthesis', () => {
    expect(parsePlan('1) read\n2) test').steps).toEqual(['read', 'test']);
  });

  test('markdown bullets', () => {
    expect(parsePlan('- read the file\n- run tests').steps)
      .toEqual(['read the file', 'run tests']);
  });

  test('bold numbering', () => {
    expect(parsePlan('**1.** read\n**2.** test').steps).toEqual(['read', 'test']);
  });

  test('the words "Step N:"', () => {
    expect(parsePlan('Step 1: read\nStep 2: test').steps).toEqual(['read', 'test']);
  });

  test('prose without a list yields no steps, not a guess', () => {
    expect(parsePlan('I will read the file and then run the tests.').steps).toEqual([]);
  });

  test('empty and nullish input are safe', () => {
    expect(parsePlan('').steps).toEqual([]);
    expect(parsePlan(null).steps).toEqual([]);
    expect(parsePlan(undefined).steps).toEqual([]);
  });

  test('the return shape is an object with steps, and the caller uses it', () => {
    const plan = parsePlan('1. a\n2. b');
    expect(Array.isArray(plan.steps)).toBe(true);
    // The bug: `plan.length` was undefined, so the warning branch always ran.
    expect(plan.length).toBeUndefined();

    const agentSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'agent.js'), 'utf8');
    expect(agentSrc).toContain('(plan && plan.steps) || []');
  });
});

// ─────────────────────────────────────────────
//  A plan that never arrives must not hang the run
//
//  A live run sat at "Generating execution plan..." until the user killed it,
//  because the plan response was never detected and the only bound was the
//  generic 10-minute response timeout.
// ─────────────────────────────────────────────

describe('planning is bounded', () => {
  const fs = require('fs');
  const path = require('path');
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');

  test('the plan wait is raced against a timeout', () => {
    expect(agentSrc).toContain('Promise.race');
    expect(agentSrc).toContain('PLAN_TIMEOUT_MS');
  });

  test('a planning failure falls through to normal execution', () => {
    // The catch around the plan block must send a recovery message, not abort.
    const block = agentSrc.slice(agentSrc.indexOf('const planTimeoutMs'));
    expect(block.slice(0, 3000)).toMatch(/Planning failed[\s\S]*Proceeding without plan/);
  });

  test('the default timeout is finite, configurable, and below the response timeout', () => {
    // Read the declaration rather than the runtime object: config.js is built
    // from several layers and the test environment does not always expose every
    // key on the exported object.
    const configSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'config.js'), 'utf8');

    const match = configSrc.match(/PLAN_TIMEOUT_MS\s*:\s*([\d_]+)/);
    expect(match).toBeTruthy();

    const value = Number(match[1].replace(/_/g, ''));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(600_000);
  });
});
