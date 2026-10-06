// tests/work-startup.test.js - Phase 2/3 startup orchestration
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { preparePendingWork } = require('../src/work-startup');
const { TODO_FILE, CONTEXT_FILE } = require('../src/todo-manager');

const NL = String.fromCharCode(10);

let TMP;
function freshDir() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ws-'));
  return TMP;
}
afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  TMP = null;
});

function quietLogger() {
  return { info() {}, warn() {}, dim() {}, error() {} };
}

describe('work-startup: preparePendingWork', () => {
  test('no pending work -> mode normal', async () => {
    const d = freshDir();
    const args = {};
    const res = await preparePendingWork({ args, config: { WORKING_DIR: d }, logger: quietLogger() });
    expect(res.mode).toBe('normal');
    expect(res.proceed).toBe(true);
  });

  test('--auto runs the first open TODO item', async () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [ ] alpha', '- [ ] beta', ''].join(NL));
    const args = { auto: true };
    const res = await preparePendingWork({ args, config: { WORKING_DIR: d }, logger: quietLogger() });
    expect(res.mode).toBe('auto');
    expect(args.autoTask).toBe('alpha');
    expect(args.todoFile).toBe(path.join(d, TODO_FILE));
  });

  test('--auto with no open items and no task -> auto-empty (stop)', async () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [x] already done', ''].join(NL));
    const args = { auto: true };
    const res = await preparePendingWork({ args, config: { WORKING_DIR: d }, logger: quietLogger() });
    expect(res.mode).toBe('auto-empty');
    expect(res.proceed).toBe(false);
  });

  test('--auto with no open items but an explicit task -> auto-noop (proceed)', async () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [x] done', ''].join(NL));
    const args = { auto: true, task: 'do something' };
    const res = await preparePendingWork({ args, config: { WORKING_DIR: d }, logger: quietLogger() });
    expect(res.mode).toBe('auto-noop');
    expect(res.proceed).toBe(true);
  });

  test('--auto never auto-acts on SESSION_CONTEXT.md alone', async () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, CONTEXT_FILE), '# SESSION_CONTEXT - x' + NL);
    const args = { auto: true };
    const res = await preparePendingWork({ args, config: { WORKING_DIR: d }, logger: quietLogger() });
    // No TODO -> nothing for auto to do.
    expect(res.mode).toBe('auto-empty');
    expect(args.autoTask).toBeUndefined();
  });

  test('--auto exposes advisory context file when present', async () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [ ] work', ''].join(NL));
    fs.writeFileSync(path.join(d, CONTEXT_FILE), '# SESSION_CONTEXT - x' + NL);
    const args = { auto: true };
    const res = await preparePendingWork({ args, config: { WORKING_DIR: d }, logger: quietLogger() });
    expect(res.mode).toBe('auto');
    expect(args.contextFile).toBe(path.join(d, CONTEXT_FILE));
  });
});
