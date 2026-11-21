// tests/protocol-validation.test.js — prose is not a program.
//
// The parser used to accept the first JSON object containing a "name" or
// "tool" key, anywhere in the reply. Measured before this change:
//
//   'Here is a package.json: {"name": "my-app", ...}'  -> tool_call "my-app"
//   'def f(): return {"name": "test"}'                 -> tool_call "test"
//   a fenced ```json EXAMPLE of a run_command call     -> executed for real
//
// An explanation of a write could therefore become a write. Unknown tool names
// also passed parsing and were rejected only at execution, with an error that
// dumped all 45 tool names into the context.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const { parseResponse } = require('../src/parser');
const { TOOLS } = require('../src/tools');

const NAMES = Object.keys(TOOLS);
const parse = (text) => parseResponse(text, { toolNames: NAMES });

describe('illustrations are not executed', () => {
  const illustrations = [
    ['a package.json in prose', 'Here is a package.json:\n{"name": "my-app", "version": "1.0.0"}\nThat is all.'],
    ['a python dict', 'def f():\n    return {"name": "test"}'],
    ['a fenced json example with prose around it', 'Run this:\n```json\n{"tool": "run_command", "args": {"command": "npm test"}}\n```\nThen wait.'],
    ['a fenced js example', 'For example:\n```js\nconst x = {"name": "y"};\n```'],
  ];

  test.each(illustrations)('%s is plain text', (_label, input) => {
    const r = parse(input);
    expect(r.type).toBe('text');
  });

  test('a fence that is the whole response IS a call', () => {
    const r = parse('```json\n{"tool": "read_file", "args": {"path": "a.js"}}\n```');
    expect(r.type).toBe('tool_call');
    expect(r.name).toBe('read_file');
  });

  test('a <tool_call> block is a call regardless of surrounding prose', () => {
    const r = parse('Let me read that.\n<tool_call>{"tool":"read_file","args":{"path":"a.js"}}</tool_call>');
    expect(r.type).toBe('tool_call');
  });

  test('without a registry the legacy behaviour is unchanged', () => {
    // parseResponse(text) with no opts must not change for existing callers.
    const r = parseResponse('Here is a package.json:\n{"name": "my-app"}');
    expect(r.type).toBe('tool_call');
  });
});

describe('unknown tool names', () => {
  test('a typo becomes invalid_tool with a suggestion', () => {
    const r = parse('<tool_call>{"tool":"read_fle","args":{"path":"x"}}</tool_call>');
    expect(r.type).toBe('invalid_tool');
    expect(r.name).toBe('read_fle');
    expect(r.suggestion).toBe('read_file');
  });

  test('a truncated name is repaired by prefix', () => {
    const r = parse('<tool_call>{"tool":"list_dir","args":{}}</tool_call>');
    expect(r.type).toBe('invalid_tool');
    expect(r.suggestion).toBe('list_directory');
  });

  test('a wildly different name gets no suggestion', () => {
    const r = parse('<tool_call>{"tool":"deploy_to_prod","args":{}}</tool_call>');
    expect(r.type).toBe('invalid_tool');
    expect(r.suggestion).toBe(null);
  });

  test('a batch containing one unknown name executes nothing', () => {
    const r = parse(
      '<tool_call>{"tool":"read_file","args":{"path":"a"}}</tool_call>' +
      '<tool_call>{"tool":"nope_nope","args":{}}</tool_call>'
    );
    expect(r.type).toBe('invalid_tool');
    expect(r.name).toBe('nope_nope');
  });

  test('a fully valid batch still parses as a batch', () => {
    const r = parse(
      '<tool_call>{"tool":"read_file","args":{"path":"a"}}</tool_call>' +
      '<tool_call>{"tool":"list_directory","args":{}}</tool_call>'
    );
    expect(r.type).toBe('tool_batch');
    expect(r.calls).toHaveLength(2);
  });

  test('every real tool name is accepted', () => {
    for (const name of NAMES) {
      const r = parse(`<tool_call>{"tool":"${name}","args":{}}</tool_call>`);
      expect(r.type).toBe('tool_call');
    }
  });
});

describe('the agent loop handles an unknown tool with one targeted repair', () => {
  let workdir;
  let orig;

  beforeEach(() => {
    const config = require('../src/config');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proto-'));
    orig = { ...config };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
  });

  afterEach(() => {
    Object.assign(require('../src/config'), orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('sends a short suggestion instead of executing or dumping the registry', async () => {
    const DeepSeekAgent = require('../src/agent');
    const sent = [];
    const queue = [
      '<tool_call>{"tool":"read_fle","args":{"path":"a.txt"}}</tool_call>',
      'ok\nTASK_COMPLETE',
    ];

    const agent = new DeepSeekAgent({});
    agent.browser = {
      async launch() {}, async close() {}, async newChat() {},
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() { return queue.shift(); },
    };

    await agent.run('read a.txt');

    const repair = sent.find((m) => m.includes('There is no tool called'));
    expect(repair).toBeTruthy();
    expect(repair).toContain('read_fle');
    expect(repair).toContain('Did you mean "read_file"?');
    // No registry dump: the repair must stay short.
    expect(repair.length).toBeLessThan(600);
  }, 30000);
});
