// tests/recovery.test.js — a stalled chat must restart WITH its contract.
//
// The bug this locks down: recovery opened a new chat and sent only
// "you are a coding agent, continue with this task". A fresh chat has no
// system prompt, no tool list and no call format, so the next reply was prose,
// which tripped the correction counter and aborted the run. Recovery converted
// a temporary stall into a terminal failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const ForgeAgent = require('../src/agent');
const config = require('../src/config');
const { ProgressTracker } = require('../src/progress');

const THROW = Symbol('throw');

function makeFakeBrowser(responses) {
  const queue = [...responses];
  return {
    sent: [],
    newChats: 0,
    async launch() {},
    async close() {},
    async newChat() { this.newChats++; },
    async sendMessage(text) { this.sent.push(text); },
    async waitForResponse() {
      if (queue.length === 0) throw new Error('fake browser: no scripted response left');
      const next = queue.shift();
      if (next === THROW) throw new Error('simulated stall');
      return next;
    },
  };
}

describe('chat recovery', () => {
  let workdir;
  let orig;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rec-'));
    orig = { ...config };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.PLANNING_MODE = false;
    config.EMPTY_RESPONSE_THRESHOLD = 2;
    config.PARTIAL_RESULT_THRESHOLD = 6;
  });

  afterEach(() => {
    Object.assign(config, orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('_recoverWithNewChat re-sends the system prompt, not just "continue"', async () => {
    fs.writeFileSync(
      path.join(workdir, 'FORGE_PLAN.md'),
      '- [x] create the file\n- [ ] add the route\n',
      'utf8'
    );

    const agent = new ForgeAgent({});
    const browser = makeFakeBrowser([]);
    agent.browser = browser;

    const progress = new ProgressTracker('add a route');
    progress.recordToolCall('write_file', { path: 'src/a.js' });
    progress.recordError('ENOENT: no such file src/a.js');

    await agent._recoverWithNewChat('add a route', progress);

    expect(browser.newChats).toBe(1);
    expect(browser.sent).toHaveLength(1);

    const msg = browser.sent[0];

    // The contract must be present in full.
    expect(msg).toContain('<<<FORGE_START>>>');
    expect(msg).toContain('<tool_call>');
    expect(msg).toContain('TASK_COMPLETE');
    expect(msg).toContain('AVAILABLE TOOLS');
    expect(msg).toContain('run_command(');

    // And the state the model needs to resume.
    expect(msg).toContain('add a route');
    expect(msg).toContain('- [ ] add the route');
    expect(msg).toContain('ENOENT: no such file src/a.js');
    expect(msg).toMatch(/CONTEXT RESET/);
  });

  test('_readPlanState returns null when there is no plan, and truncates a huge one', () => {
    const agent = new ForgeAgent({});
    expect(agent._readPlanState()).toBe(null);

    fs.writeFileSync(path.join(workdir, 'FORGE_PLAN.md'), 'x'.repeat(5000), 'utf8');
    const state = agent._readPlanState();
    expect(state.length).toBeLessThan(2100);
    expect(state).toMatch(/truncated/);
  });

  test('the loop restarts the chat when the model stalls, then continues', async () => {
    fs.writeFileSync(path.join(workdir, 'b.txt'), 'BBB', 'utf8');

    const browser = makeFakeBrowser([
      THROW,                                                        // streak 1 -> nudge
      THROW,                                                        // streak 2 -> restart chat
      '<tool_call>{"tool":"read_file","args":{"path":"b.txt"}}</tool_call>',
      'All done.\nTASK_COMPLETE',
    ]);

    const agent = new ForgeAgent({});
    agent.browser = browser;

    const spy = jest.fn(async () => {});
    agent._recoverWithNewChat = spy;

    const result = await agent.run('read b.txt');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toContain('TASK_COMPLETE');
  }, 30000);

  test('gives up with a partial result once the restart budget is spent', async () => {
    const browser = makeFakeBrowser([THROW, THROW, THROW, THROW, THROW]);

    const agent = new ForgeAgent({});
    agent.browser = browser;

    const spy = jest.fn(async () => {});
    agent._recoverWithNewChat = spy;

    const result = await agent.run('never answers');

    // MAX_CHAT_RECOVERIES defaults to 2: nudge, recover, recover, then give up.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toMatch(/did not complete/);
    expect(result).toMatch(/empty response loop/);
  }, 30000);

  test('the stall counters reset between runs on the same agent', async () => {
    const agent = new ForgeAgent({});
    agent._recoveries = 5;
    agent._emptyStreak = 9;

    const browser = makeFakeBrowser(['ok\nTASK_COMPLETE']);
    agent.browser = browser;

    await agent.run('trivial');

    expect(agent._recoveries).toBe(0);
    expect(agent._emptyStreak).toBe(0);
  }, 30000);
});
