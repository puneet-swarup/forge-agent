// tests/todo-manager.test.js - Phase 2/3: FORGE_TODO.md + startup detection
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  parseTodo,
  readTodo,
  detectPendingWork,
  formatNotice,
  formatAge,
  markTodoDone,
  TODO_FILE,
  CONTEXT_FILE,
} = require('../src/todo-manager');

const NL = String.fromCharCode(10);

let TMP;
function freshDir() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-todo-'));
  return TMP;
}
afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  TMP = null;
});

describe('todo-manager: parseTodo', () => {
  test('parses checked and unchecked task lines', () => {
    const items = parseTodo(['# T', '- [ ] one', '- [x] two', '* [ ] three', ''].join(NL));
    expect(items).toEqual([
      { text: 'one',   done: false, line: 2 },
      { text: 'two',   done: true,  line: 3 },
      { text: 'three', done: false, line: 4 },
    ]);
  });

  test('treats a bare bullet as an open item', () => {
    const items = parseTodo(['- just a note', ''].join(NL));
    expect(items).toEqual([{ text: 'just a note', done: false, line: 1 }]);
  });

  test('ignores headings and blank lines', () => {
    expect(parseTodo(['# Heading', '', 'Text', ''].join(NL))).toEqual([]);
  });
});

describe('todo-manager: readTodo + detectPendingWork', () => {
  test('readTodo returns null when the file is absent', () => {
    const d = freshDir();
    expect(readTodo(d)).toBeNull();
  });

  test('readTodo splits open and done items', () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [ ] a', '- [x] b', '- [ ] c', ''].join(NL));
    const t = readTodo(d);
    expect(t.open.map(i => i.text)).toEqual(['a', 'c']);
    expect(t.done.map(i => i.text)).toEqual(['b']);
  });

  test('detectPendingWork reports todo and context', () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [ ] a', ''].join(NL));
    fs.writeFileSync(path.join(d, CONTEXT_FILE), '# SESSION_CONTEXT - brave-otter-9f3a' + NL);
    const p = detectPendingWork(d);
    expect(p.hasAny).toBe(true);
    expect(p.todo.open.length).toBe(1);
    expect(p.context.sessionName).toBe('brave-otter-9f3a');
  });

  test('detectPendingWork on an empty dir is a no-op', () => {
    const d = freshDir();
    const p = detectPendingWork(d);
    expect(p.hasAny).toBe(false);
    expect(p.todo).toBeNull();
    expect(p.context).toBeNull();
  });
});

describe('todo-manager: markTodoDone', () => {
  test('ticks the matching open item and rewrites the file', () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [ ] first', '- [ ] second', ''].join(NL));
    expect(markTodoDone(d, 'first')).toBe(true);
    const raw = fs.readFileSync(path.join(d, TODO_FILE), 'utf8');
    expect(raw).toContain('- [x] first');
    expect(raw).toContain('- [ ] second');
  });

  test('returns false when no item matches', () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, TODO_FILE), ['- [ ] only', ''].join(NL));
    expect(markTodoDone(d, 'nope')).toBe(false);
  });
});

describe('todo-manager: formatting', () => {
  test('formatAge renders human-friendly ages', () => {
    expect(formatAge(5 * 1000)).toBe('5s ago');
    expect(formatAge(2 * 60 * 1000)).toBe('2m ago');
    expect(formatAge(3 * 60 * 60 * 1000)).toBe('3h ago');
    expect(formatAge(null)).toBe('unknown');
  });

  test('formatNotice lists todo and context', () => {
    const notice = formatNotice({
      todo: { open: [{ text: 'a' }, { text: 'b' }] },
      context: { sessionName: 'x', ageMs: 60000 },
    });
    expect(notice).toContain('FORGE_TODO.md');
    expect(notice).toContain('2 open item');
    expect(notice).toContain('SESSION_CONTEXT.md');
  });
});
