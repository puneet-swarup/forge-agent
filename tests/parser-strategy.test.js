// tests/parser-strategy.test.js — the parser tolerates several shapes; it must
// also say which one it used.
//
// The canonical reply is `<<<FORGE_START>>> <tool_call>{json}</tool_call>
// <<<FORGE_END>>>`. The parser also accepts fenced blocks, bare JSON and
// function-call style, because models drift. Tolerance is right; tolerance
// without measurement is not — a model that never follows the contract looks
// identical to one that always does.
'use strict';

const { parseResponse } = require('../src/parser');

describe('parse strategy is reported', () => {
  test('the canonical <tool_call> block is "xml"', () => {
    const r = parseResponse('<tool_call>{"tool":"read_file","args":{"path":"a"}}</tool_call>');
    expect(r.type).toBe('tool_call');
    expect(r.strategy).toBe('xml');
  });

  test('the canonical form inside the response envelope is still "xml"', () => {
    const r = parseResponse('<<<FORGE_START>>>\n<tool_call>{"tool":"read_file","args":{"path":"a"}}</tool_call>\n<<<FORGE_END>>>');
    expect(r.strategy).toBe('xml');
  });

  test('a ```tool_call fence is "fence"', () => {
    const r = parseResponse('```tool_call\n{"tool":"read_file","args":{"path":"a"}}\n```');
    expect(r.strategy).toBe('fence');
  });

  test('function-call style is "function"', () => {
    expect(parseResponse('read_file(path="a")').strategy).toBe('function');
  });

  test('TASK_COMPLETE is "complete"', () => {
    expect(parseResponse('done TASK_COMPLETE').strategy).toBe('complete');
  });

  test('plain prose is "text"', () => {
    expect(parseResponse('just talking').strategy).toBe('text');
  });

  test('the agent records the strategy for every turn', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'agent.js'), 'utf8');
    expect(src).toContain('_lastParseStrategy');
  });
});

describe('tolerance does not become execution', () => {
  test('a function-call shape inside prose is not executed', () => {
    // Strategy 3 is anchored to the whole reply for exactly this reason.
    for (const text of [
      'I will call read_file(path="a.js") now.',
      'To fix this you would run run_command(command="rm -rf build") on the server.',
      'The function read_file(path="x") reads a file.',
    ]) {
      const r = parseResponse(text);
      expect(r.type).toBe('text');
    }
  });

  test('an illustration in a data-language fence is not executed', () => {
    const text = 'Here is an example:\n```json\n{"tool":"write_file","args":{"path":"x"}}\n```\nDone.';
    expect(parseResponse(text).type).toBe('text');
  });
});
