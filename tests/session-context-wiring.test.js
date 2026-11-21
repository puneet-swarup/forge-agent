// tests/session-context-wiring.test.js — SESSION_CONTEXT.md is real.
//
// The feature was half-wired: _sessionCtxStart() was called twice and defined
// nowhere, _sessionCtxUpdate() was declared twice, SessionContext.create() was
// never called, and nothing ever read the file back. It was written by
// accident, gitignored, and deleted at the end of the run.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const DeepSeekAgent = require('../src/agent');
const config = require('../src/config');

describe('session context wiring', () => {
  let workdir;
  let orig;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ctx-'));
    orig = { WORKING_DIR: config.WORKING_DIR, MEMORY_ENABLED: config.MEMORY_ENABLED };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
  });

  afterEach(() => {
    Object.assign(config, orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('the helper that was called but never defined now exists', () => {
    const agent = new DeepSeekAgent({});
    expect(typeof agent._sessionCtxStart).toBe('function');
    expect(typeof agent._sessionCtxUpdate).toBe('function');
    expect(typeof agent._sessionCtxSnapshot).toBe('function');
  });

  test('_sessionCtxStart creates SESSION_CONTEXT.md on disk', () => {
    const agent = new DeepSeekAgent({});
    expect(agent.sessionContext).toBeTruthy();

    agent._sessionCtxStart('add a health endpoint');

    const file = path.join(workdir, 'SESSION_CONTEXT.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('health endpoint');
  });

  test('the file is added to .gitignore, never committed', () => {
    const agent = new DeepSeekAgent({});
    agent._sessionCtxStart('anything');

    const gi = path.join(workdir, '.gitignore');
    expect(fs.existsSync(gi)).toBe(true);
    expect(fs.readFileSync(gi, 'utf8')).toContain('SESSION_CONTEXT.md');
  });

  test('_sessionCtxSnapshot returns bounded text for a restart', () => {
    const agent = new DeepSeekAgent({});
    agent._sessionCtxStart('task');
    const snap = agent._sessionCtxSnapshot();

    expect(typeof snap).toBe('string');
    expect(snap.length).toBeGreaterThan(0);
    expect(snap.length).toBeLessThan(2100);
  });

  test('_sessionCtxSnapshot is empty (not throwing) when the feature is off', () => {
    const agent = new DeepSeekAgent({});
    agent.sessionContext = null;
    expect(agent._sessionCtxSnapshot()).toBe('');
    expect(() => agent._sessionCtxStart('x')).not.toThrow();
  });

  test('recovery carries the session notes into the new chat', async () => {
    const agent = new DeepSeekAgent({});
    agent._sessionCtxStart('RESUME-TASK');

    const sent = [];
    agent.browser = {
      async newChat() {},
      async sendMessage(t) { sent.push(t); },
    };

    const { ProgressTracker } = require('../src/progress');
    await agent._recoverWithNewChat('RESUME-TASK', new ProgressTracker('RESUME-TASK'));

    expect(sent[0]).toContain('SESSION NOTES');
    expect(sent[0]).toContain('<<<FORGE_START>>>');
  }, 30000);

  test('the run path creates the context file (no missing-method crash)', async () => {
    const agent = new DeepSeekAgent({});
    const sent = [];
    agent.browser = {
      async launch() {}, async close() {}, async newChat() {},
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() { return 'ok\nTASK_COMPLETE'; },
    };

    await agent.run('a short task');

    expect(fs.existsSync(path.join(workdir, 'SESSION_CONTEXT.md'))).toBe(true);
  }, 30000);
});
