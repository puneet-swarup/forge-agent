// tests/workspace.test.js — the four guarantees of src/workspace.js.
//
//   1. atomic writes   — a killed process cannot leave a truncated file
//   2. snapshots       — every mutation is reversible from a later process
//   3. read-before-write — you may only overwrite content you have seen, as it
//                          is now (an external change invalidates the permission)
//   4. diffs           — every successful write returns what changed
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Workspace, WorkspaceError } = require('../src/workspace');

function makeWs(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ws-'));
  const ws = new Workspace({
    root,
    snapshotDir: path.join(root, '.snapshots'),
    ...opts,
  });
  return { ws, root };
}

describe('workspace — atomic writes', () => {
  test('creates a file and reports size, lines and no diff', () => {
    const { ws, root } = makeWs();
    const res = ws.write(path.join(root, 'a.txt'), 'one\ntwo\n');

    expect(res.created).toBe(true);
    expect(res.lines).toBe(3);
    expect(res.diff).toBe('');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  test('creates parent directories', () => {
    const { ws, root } = makeWs();
    ws.write(path.join(root, 'a', 'b', 'c.txt'), 'x');
    expect(fs.existsSync(path.join(root, 'a', 'b', 'c.txt'))).toBe(true);
  });

  test('leaves no temp file behind', () => {
    const { ws, root } = makeWs();
    ws.write(path.join(root, 'a.txt'), 'x');
    const leftovers = fs.readdirSync(root).filter((n) => n.includes('forge-tmp'));
    expect(leftovers).toEqual([]);
  });

  test('overwriting replaces content exactly (no append, no truncation)', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    ws.write(file, 'first version with a long body');
    ws.write(file, 'second');
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });

  test('appends to an existing file', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    ws.write(file, 'one\n');
    const res = ws.append(file, 'two\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    expect(res.created).toBe(false);
  });
});

describe('workspace — read before write', () => {
  test('refuses to overwrite a file it has never seen', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'existing.txt');
    fs.writeFileSync(file, 'precious');

    expect(() => ws.write(file, 'clobbered')).toThrow(WorkspaceError);
    expect(() => ws.write(file, 'clobbered')).toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(file, 'utf8')).toBe('precious');
  });

  test('allows the overwrite after the content has been seen', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'existing.txt');
    fs.writeFileSync(file, 'precious');

    ws.markSeen(file);
    ws.write(file, 'updated');

    expect(fs.readFileSync(file, 'utf8')).toBe('updated');
  });

  test('an external change invalidates a previous read', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    ws.write(file, 'v1');
    fs.writeFileSync(file, 'changed by a shell command');

    expect(() => ws.write(file, 'v3')).toThrow(/have not been read/);

    ws.markSeen(file);
    expect(() => ws.write(file, 'v3')).not.toThrow();
  });

  test('a file the agent wrote itself can be rewritten', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'new.txt');
    ws.write(file, 'one');
    expect(() => ws.write(file, 'two')).not.toThrow();
  });

  test('the guard can be disabled for callers that know better', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(() => ws.write(file, 'y', { allowUnread: true })).not.toThrow();
  });

  test('the guard can be switched off entirely', () => {
    const { ws, root } = makeWs({ requireReadBeforeWrite: false });
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(() => ws.write(file, 'y')).not.toThrow();
  });
});

describe('workspace — snapshots and rollback', () => {
  test('takes a snapshot of the pre-image and restores it', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'original');

    ws.markSeen(file);
    ws.write(file, 'agent version');
    expect(fs.readFileSync(file, 'utf8')).toBe('agent version');

    const res = ws.rollback(file);
    expect(res.restored).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });

  test('the snapshot survives in a new Workspace instance (a later process)', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'src', 'a.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'ORIGINAL');

    ws.markSeen(file);
    ws.write(file, 'MODIFIED');
    expect(ws.hasSnapshot(file)).toBe(true);

    const later = new Workspace({
      root,
      snapshotDir: path.join(root, '.snapshots'),
    });
    expect(later.hasSnapshot(file)).toBe(true);
    later.rollback(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('ORIGINAL');
  });

  test('no snapshot is taken for a brand-new file', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'brand-new.txt');
    const res = ws.write(file, 'x');
    expect(res.snapshot).toBe(null);
    expect(ws.hasSnapshot(file)).toBe(false);
  });

  test('rollback without a snapshot fails with a clear error', () => {
    const { ws, root } = makeWs();
    expect(() => ws.rollback(path.join(root, 'never-written.txt'))).toThrow(/No snapshot/);
  });

  test('remove() keeps a snapshot so a delete is reversible', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'gone.txt');
    fs.writeFileSync(file, 'bring me back');

    const res = ws.remove(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(res.snapshot).toBeTruthy();

    ws.rollback(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('bring me back');
  });

  test('listSnapshots reports what can be undone', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    ws.markSeen(file);
    ws.write(file, 'y');

    const list = ws.listSnapshots();
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe(file);
  });
});

describe('workspace — diffs', () => {
  test('reports a unified diff of the change', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    ws.write(file, 'one\ntwo\n');
    const res = ws.write(file, 'one\nTWO\n');

    expect(res.diff).toContain('--- a/a.txt');
    expect(res.diff).toContain('+++ b/a.txt');
    expect(res.diff).toContain('-two');
    expect(res.diff).toContain('+TWO');
  });

  test('caps a very large diff', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'big.txt');
    ws.write(file, 'start\n');
    const res = ws.write(file, Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n'));

    expect(res.diff).toContain('diff truncated');
    expect(res.diff.split('\n').length).toBeLessThan(60);
  });

  test('an unchanged rewrite produces no diff', () => {
    const { ws, root } = makeWs();
    const file = path.join(root, 'a.txt');
    ws.write(file, 'same');
    expect(ws.write(file, 'same').diff).toBe('');
  });
});
