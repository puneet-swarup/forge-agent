// tests/session-context.test.js — Phase 1: durable session working memory
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  SessionContext,
  getSessionContext,
  resetSessionContext,
  ensureGitignored,
  contextPath,
  FILENAME,
} = require('../src/session-context');

// Each test gets its own throwaway project directory.
let TMP;
function freshDir() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sctx-'));
  return TMP;
}

afterEach(() => {
  resetSessionContext();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  TMP = null;
});

describe('session-context', () => {
  test('contextPath points at SESSION_CONTEXT.md in the project dir', () => {
    const d = freshDir();
    expect(contextPath(d)).toBe(path.join(d, FILENAME));
  });

  test('create() writes the file with header and sections', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 'brave-otter-9f3a', task: 'fix failing tests' });
    const res = c.create();
    expect(res.ok).toBe(true);
    expect(c.exists()).toBe(true);

    const raw = fs.readFileSync(path.join(d, FILENAME), 'utf8');
    expect(raw).toContain('# SESSION_CONTEXT - brave-otter-9f3a');
    expect(raw).toContain('DO NOT COMMIT');
    expect(raw).toContain('## Goal');
    expect(raw).toContain('## Decisions');
    expect(raw).toContain('## Progress');
    expect(raw).toContain('## Current State');
    expect(raw).toContain('## Open Questions');
  });

  test('records decisions, progress and open questions', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 's', task: 't' });
    c.create();
    c.addDecision('mock the network layer');
    c.addProgress('read the test file', true);
    c.addProgress('apply the fix', false);
    c.addOpenQuestion('keep legacy shim?');
    c.update();

    const r = c.read();
    expect(r.data.decisions).toEqual([{ time: expect.any(String), text: 'mock the network layer' }]);
    expect(r.data.progress).toEqual([
      { done: true,  text: 'read the test file' },
      { done: false, text: 'apply the fix' },
    ]);
    expect(r.data.open).toEqual(['keep legacy shim?']);
  });

  test('completeProgress() marks an item done by substring', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 's', task: 't' });
    c.create();
    c.addProgress('apply the fix', false);
    expect(c.completeProgress('apply')).toBe(true);
    expect(c.data.progress[0].done).toBe(true);
    expect(c.completeProgress('nonexistent')).toBe(false);
  });

  test('asContextString() returns the file contents', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 's', task: 't' });
    c.create();
    expect(c.asContextString()).toContain('# SESSION_CONTEXT');
  });

  test('destroy() removes the file', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 's', task: 't' });
    c.create();
    expect(c.exists()).toBe(true);
    const res = c.destroy();
    expect(res.ok).toBe(true);
    expect(c.exists()).toBe(false);
  });

  test('create() on an existing file preserves prior decisions', () => {
    const d = freshDir();
    const c1 = new SessionContext({ projectDir: d, sessionName: 's', task: 'first' });
    c1.create();
    c1.addDecision('kept from run 1');
    c1.update();

    const c2 = new SessionContext({ projectDir: d, sessionName: 's', task: 'second' });
    c2.create();
    expect(c2.data.decisions.some(x => x.text === 'kept from run 1')).toBe(true);
  });

  test('ensureGitignored creates .gitignore when missing', () => {
    const d = freshDir();
    const res = ensureGitignored(d);
    expect(res.status).toBe('created');
    expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).toContain(FILENAME);
  });

  test('ensureGitignored appends when entry missing, present when exists', () => {
    const d = freshDir();
    fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/\
', 'utf8');
    const r1 = ensureGitignored(d);
    expect(r1.status).toBe('added');
    expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).toContain(FILENAME);
    const r2 = ensureGitignored(d);
    expect(r2.status).toBe('present');
    // No duplicate entries.
    const giText = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
    const count = giText.split('\n').filter(l => l.trim() === FILENAME).length;
    expect(count).toBe(1);
  });

  test('create() auto-adds the gitignore entry by default', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 's', task: 't' });
    c.create();
    expect(fs.existsSync(path.join(d, '.gitignore'))).toBe(true);
  });

  test('autoGitignore:false skips the gitignore guard', () => {
    const d = freshDir();
    const c = new SessionContext({ projectDir: d, sessionName: 's', task: 't', autoGitignore: false });
    c.create();
    expect(fs.existsSync(path.join(d, '.gitignore'))).toBe(false);
  });

  test('getSessionContext returns a singleton per project dir', () => {
    const d = freshDir();
    const a = getSessionContext(d);
    const b = getSessionContext(d);
    expect(a).toBe(b);
  });
});
