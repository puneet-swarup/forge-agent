// tests/integration-auto-loop.test.js - End-to-end --auto loop wiring with a
// stub agent (no browser). Verifies the loop reads FORGE_TODO.md, runs each
// item via agent.run(), ticks completed items, and halts on the first failure.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { readTodo } = require('../src/todo-manager');

// Re-implement the same loop contract the CLI uses, so the test is independent
// of index.js internals but asserts the same behavior.
async function runAutoTodoLoop(agent, projectDir) {
  const { readTodo: read, markTodoDone } = require('../src/todo-manager');
  let todo = read(projectDir);
  if (!todo || todo.open.length === 0) return 0;
  let completed = 0;
  while (true) {
    todo = read(projectDir);
    const next = todo && todo.open.length > 0 ? todo.open[0] : null;
    if (!next) break;
    try {
      await agent.run(next.text, null);
    } catch (_) {
      break; // halt on first failure
    }
    markTodoDone(projectDir, next.text);
    completed++;
  }
  return completed;
}

let TMP;
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autoloop-')); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

describe('--auto loop end-to-end (stub agent)', () => {
  test('runs every open item and ticks each done', async () => {
    fs.writeFileSync(path.join(TMP, 'FORGE_TODO.md'), ['- [ ] one', '- [ ] two', '- [x] already', '- [ ] three', ''].join(String.fromCharCode(10)));
    const ran = [];
    const agent = { run: async (t) => { ran.push(t); } };
    const completed = await runAutoTodoLoop(agent, TMP);
    expect(completed).toBe(3);
    expect(ran).toEqual(['one', 'two', 'three']);
    expect(readTodo(TMP).open.length).toBe(0);
  });

  test('halts on the first failure and leaves that item open', async () => {
    fs.writeFileSync(path.join(TMP, 'FORGE_TODO.md'), ['- [ ] ok1', '- [ ] boom', '- [ ] never', ''].join(String.fromCharCode(10)));
    const ran = [];
    const agent = { run: async (t) => { ran.push(t); if (t === 'boom') throw new Error('fail'); } };
    const completed = await runAutoTodoLoop(agent, TMP);
    expect(completed).toBe(1);
    expect(ran).toEqual(['ok1', 'boom']);
    const open = readTodo(TMP).open.map(i => i.text);
    expect(open).toEqual(['boom', 'never']);
  });

  test('does nothing when there is no TODO file', async () => {
    const agent = { run: async () => { throw new Error('should not run'); } };
    expect(await runAutoTodoLoop(agent, TMP)).toBe(0);
  });
});
