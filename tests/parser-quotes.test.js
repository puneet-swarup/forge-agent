// tests/parser-quotes.test.js — typographic (curly) quotes must not defeat
// tool-call parsing.
//
// Web chat UIs routinely render straight quotes as curly ones (“ ”), and a model
// echoing JSON through such a surface can emit them. A tool call wrapped in
// curly quotes has to parse, or the agent silently sees "plain text" and retries
// forever — the exact symptom a live run showed.
//
// Restored from the loom branch, where it was written with node:test and so
// never ran under jest (and therefore never ran in CI at all).
'use strict';

const { parseResponse, hasToolCall } = require('../src/parser');

const straight = '{"tool": "read_file", "args": {"path": "a.js", "start_line": 2}}';
const curly    = straight.replace(/"/g, '\u201c');

describe('parser and typographic quotes', () => {
  test('parses a straight-quoted tool call', () => {
    const p = parseResponse('<tool_call>' + straight + '</tool_call>');
    expect(p.type).toBe('tool_call');
    expect(p.name).toBe('read_file');
    expect(p.args.start_line).toBe(2);
  });

  test('parses a curly-quoted tool call inside tags', () => {
    const p = parseResponse('<tool_call>' + curly + '</tool_call>');
    expect(p.type).toBe('tool_call');
    expect(p.name).toBe('read_file');
    expect(p.args.start_line).toBe(2);
  });

  test('hasToolCall sees through curly quotes', () => {
    expect(hasToolCall(curly)).toBe(true);
  });

  test('hasToolCall accepts a fenced tool_call block', () => {
    expect(hasToolCall('```tool_call\n' + straight + '\n```')).toBe(true);
  });

  test('empty input is empty, not plain text', () => {
    expect(parseResponse('').type).toBe('empty');
  });
});
