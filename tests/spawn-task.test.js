// tests/spawn-task.test.js — SESSION_TASK.md generation / parsing / marking.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const spawnTask = require('../src/spawn-task');

let TMP;
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-task-')); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

describe('spawn-task renderTaskFile', () => {
  test('renders header, task, subtasks, and progress log', () => {
    const md = spawnTask.renderTaskFile({
      identifier: 'forge-w-123',
      session: 'w',
      parentId: 'p',
      parentPid: 42,
      role: 'worker',
      cwd: '/proj',
      task: 'fix the thing',
      subtasks: ['step a', 'step b'],
      context: 'some context',
    });
    expect(md).toMatch(/# SESSION_TASK — forge-w-123/);
    expect(md).toMatch(/- Parent    : p \(pid 42\)/);
    expect(md).toMatch(/## Assigned task/);
    expect(md).toMatch(/fix the thing/);
    expect(md).toMatch(/- \[ \] step a/);
    expect(md).toMatch(/- \[ \] step b/);
    expect(md).toMatch(/## Handed-off context/);
    expect(md).toMatch(/some context/);
    expect(md).toMatch(/## Progress log/);
    expect(md).toMatch(/- \[\d\d:\d\d\] spawned/);
  });

  test('derives default subtasks when none given', () => {
    const md = spawnTask.renderTaskFile({ identifier: 'x', task: 't' });
    expect(md).toMatch(/- \[ \] Read the assigned task/);
    expect(md).toMatch(/- \[ \] Verify \/ test the change/);
  });

  test('shows (none) context when empty', () => {
    const md = spawnTask.renderTaskFile({ identifier: 'x', task: 't' });
    expect(md).toMatch(/\(none\)/);
  });
});

describe('spawn-task write/read/parse', () => {
  test('writeTaskFile creates the file and gitignores it', () => {
    const res = spawnTask.writeTaskFile({ dir: TMP, identifier: 'forge-x-1', task: 'do it' });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(res.path)).toBe(true);
    const gi = fs.readFileSync(path.join(TMP, '.gitignore'), 'utf8');
    expect(gi).toMatch(/SESSION_TASK\.md/);
  });

  test('parseTaskFile counts subtasks and detects completion', () => {
    const md = [
      '## Subtasks',
      '- [x] a',
      '- [ ] b',
      '## Progress log',
      '- [10:00] spawned',
    ].join('\n');
    const p = spawnTask.parseTaskFile(md);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
    expect(p.complete).toBe(false);
    expect(p.progress.length).toBe(1);
  });

  test('parseTaskFile marks complete when all subtasks done', () => {
    const md = '## Subtasks\n- [x] a\n- [x] b\n';
    const p = spawnTask.parseTaskFile(md);
    expect(p.complete).toBe(true);
  });

  test('parseTaskFile detects TASK_COMPLETE marker', () => {
    const md = '## Progress log\n- [10:00] TASK_COMPLETE\n';
    expect(spawnTask.parseTaskFile(md).complete).toBe(true);
  });

  test('markSubtaskDone flips the matching checkbox', () => {
    const res = spawnTask.writeTaskFile({
      dir: TMP, identifier: 'x', task: 't', subtasks: ['alpha', 'beta'],
    });
    const m = spawnTask.markSubtaskDone(res.path, 'alpha');
    expect(m.changed).toBe(true);
    const content = fs.readFileSync(res.path, 'utf8');
    expect(content).toMatch(/- \[x\] alpha/);
    expect(content).toMatch(/- \[ \] beta/);
  });

  test('markSubtaskDone reports no change for an unknown subtask', () => {
    const res = spawnTask.writeTaskFile({ dir: TMP, identifier: 'x', task: 't', subtasks: ['a'] });
    const m = spawnTask.markSubtaskDone(res.path, 'zzz');
    expect(m.changed).toBe(false);
  });

  test('appendProgress adds a timestamped line', () => {
    const res = spawnTask.writeTaskFile({ dir: TMP, identifier: 'x', task: 't' });
    const ap = spawnTask.appendProgress(res.path, 'did a thing');
    expect(ap.ok).toBe(true);
    const content = fs.readFileSync(res.path, 'utf8');
    expect(content).toMatch(/- \[\d\d:\d\d\] did a thing/);
  });
});
