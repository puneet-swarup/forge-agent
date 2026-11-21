// tests/tool-format.test.js — refusing a non-canonical tool call.
//
// The parser accepts a fenced block, bare JSON and function-call style because
// models drift. Executing those silently makes a non-compliant model look
// identical to a compliant one. Strict mode asks for the canonical form instead,
// a bounded number of times, then fails naming what the model kept using.
'use strict';

const { verdictFor, buildCorrection, isToleratedToolCall } = require('../src/tool-format');

const canonical = { type: 'tool_call', name: 'read_file', args: {}, strategy: 'xml' };
const fenced    = { type: 'tool_call', name: 'read_file', args: {}, strategy: 'fence' };
const bareJson  = { type: 'tool_call', name: 'read_file', args: {}, strategy: 'json' };
const funcStyle = { type: 'tool_call', name: 'read_file', args: {}, strategy: 'function' };
const answer    = { type: 'task_complete', strategy: 'complete' };
const prose     = { type: 'text', content: 'hello', strategy: 'text' };

describe('what counts as tolerated', () => {
  test('the canonical format is not tolerated — it is correct', () => {
    expect(isToleratedToolCall(canonical)).toBe(false);
  });

  test('fence, bare JSON and function style are tolerated shapes', () => {
    for (const p of [fenced, bareJson, funcStyle]) {
      expect(isToleratedToolCall(p)).toBe(true);
    }
  });

  test('answers are not tool calls', () => {
    expect(isToleratedToolCall(answer)).toBe(false);
    expect(isToleratedToolCall(prose)).toBe(false);
  });
});

describe('verdicts', () => {
  test('canonical executes', () => {
    expect(verdictFor(canonical, { strict: true }).action).toBe('execute');
  });

  test('an answer is accepted as an answer, never corrected', () => {
    expect(verdictFor(answer, { strict: true }).action).toBe('answer');
    expect(verdictFor(prose, { strict: true }).action).toBe('answer');
  });

  test('a tolerated shape is refused once, with a correction', () => {
    const v = verdictFor(fenced, { strict: true, refusals: 0 });
    expect(v.action).toBe('correct');
    expect(v.strategy).toBe('fence');
    expect(v.message).toContain('<tool_call>');
  });

  test('the second refusal fails, naming the format', () => {
    const v = verdictFor(funcStyle, { strict: true, refusals: 2, maxRefusals: 2 });
    expect(v.action).toBe('fail');
    expect(v.message).toContain('non-canonical format');
    expect(v.message).toContain('function');
    expect(v.message).toContain('STRICT_TOOL_FORMAT=false');
  });

  test('strict:false restores the old silent tolerance', () => {
    expect(verdictFor(fenced, { strict: false }).action).toBe('execute');
    expect(verdictFor(bareJson, { strict: false }).action).toBe('execute');
  });

  test('a null or malformed parse does not crash the gate', () => {
    expect(() => verdictFor(null, {})).not.toThrow();
    expect(verdictFor(null, {}).action).toBe('execute');
  });
});

describe('the correction message', () => {
  test('names the format the model used', () => {
    expect(buildCorrection('fence', fenced)).toContain('code fence');
    expect(buildCorrection('json', bareJson)).toContain('bare JSON');
    expect(buildCorrection('function', funcStyle)).toContain('function-call');
  });

  test('shows the exact target, with the tool name preserved', () => {
    const msg = buildCorrection('fence', fenced);
    expect(msg).toContain('<tool_call>');
    expect(msg).toContain('"tool": "read_file"');
    expect(msg).toContain('</tool_call>');
  });

  test('says what not to add', () => {
    expect(buildCorrection('fence', fenced)).toMatch(/no prose, no code fence/i);
  });
});

describe('the gate is wired into the loop', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'agent.js'), 'utf8');

  test('the agent consults the verdict before executing', () => {
    expect(src).toContain("require('./tool-format').verdictFor");
    expect(src).toContain('STRICT_TOOL_FORMAT');
  });

  test('a compliant turn resets the refusal counter', () => {
    expect(src).toContain('this._formatRefusals = 0');
  });
});
