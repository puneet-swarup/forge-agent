// tests/parallel-integration.test.js — End-to-end + randomized parallel stress
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Auto-approve all permissions so the batch path runs without a TTY menu.
jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const DeepSeekAgent = require('../src/agent');
const config = require('../src/config');
const { executeBatch, conflictKeys } = require('../src/parallel-executor');

// ─────────────────────────────────────────────
//  Fake browser that replays a scripted list of model responses
// ─────────────────────────────────────────────
function makeFakeBrowser(responses) {
  const queue = [...responses];
  return {
    sent: [],
    async launch() {},
    async close() {},
    async newChat() {},
    async sendMessage(text) { this.sent.push(text); },
    async waitForResponse() {
      if (queue.length === 0) throw new Error('fake browser: no scripted response left');
      return queue.shift();
    },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-par-'));
}

// ─────────────────────────────────────────────
//  Integration: real agent loop, batched tool calls
// ─────────────────────────────────────────────
describe('agent loop — parallel batch integration', () => {
  let origWorkingDir;
  let workdir;

  beforeEach(() => {
    workdir = tmpDir();
    origWorkingDir = config.WORKING_DIR;
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.PLANNING_MODE = false;
    config.PARALLEL_TOOL_CALLS = true;
    config.MAX_PARALLEL_TOOL_CALLS = 4;
  });

  afterEach(() => {
    config.WORKING_DIR = origWorkingDir;
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) {}
  });

  test('executes a batched write+read through the real loop and reports both', async () => {
    const fileA = path.join(workdir, 'a.txt');
    const fileB = path.join(workdir, 'b.txt');
    fs.writeFileSync(fileB, 'EXISTING_B_CONTENT', 'utf8');

    const batch = '<tool_call>{"tool":"write_file","args":{"path":"a.txt","content":"AAA"}}</tool_call>\n' +
                  '<tool_call>{"tool":"read_file","args":{"path":"b.txt"}}</tool_call>';

    const browser = makeFakeBrowser([batch, 'Done.\nTASK_COMPLETE']);
    const agent = new DeepSeekAgent({});
    agent.browser = browser;

    const result = await agent.run('do a batch');

    // Both operations actually happened on disk / in feedback:
    expect(fs.readFileSync(fileA, 'utf8')).toBe('AAA');

    const feedback = browser.sent.find(s => s.includes('BATCH'));
    expect(feedback).toBeTruthy();
    expect(feedback).toContain('write_file');
    expect(feedback).toContain('read_file');
    expect(feedback).toContain('EXISTING_B_CONTENT');
    expect(result).toContain('TASK_COMPLETE');
  });

  test('batch results preserve request order in feedback', async () => {
    const batch = '<tool_call>{"tool":"read_file","args":{"path":"b.txt"}}</tool_call>\n' +
                  '<tool_call>{"tool":"read_file","args":{"path":"c.txt"}}</tool_call>';
    fs.writeFileSync(path.join(workdir, 'b.txt'), 'BBB', 'utf8');
    fs.writeFileSync(path.join(workdir, 'c.txt'), 'CCC', 'utf8');

    const browser = makeFakeBrowser([batch, 'TASK_COMPLETE']);
    const agent = new DeepSeekAgent({});
    agent.browser = browser;
    await agent.run('two reads');

    const feedback = browser.sent.find(s => s.includes('BATCH'));
    expect(feedback.indexOf('b.txt') === -1 || feedback.indexOf('BBB') < feedback.indexOf('CCC')).toBe(true);
  });

  test('dependency ordering is enforced through the loop (write then read same file)', async () => {
    const batch = '<tool_call>{"tool":"write_file","args":{"path":"same.txt","content":"NEW"}}</tool_call>\n' +
                  '<tool_call>{"tool":"read_file","args":{"path":"same.txt"}}</tool_call>';

    const browser = makeFakeBrowser([batch, 'TASK_COMPLETE']);
    const agent = new DeepSeekAgent({});
    agent.browser = browser;
    await agent.run('write then read same file');

    // After the loop the file must contain NEW (write happened).
    expect(fs.readFileSync(path.join(workdir, 'same.txt'), 'utf8')).toBe('NEW');

    // The read result fed back must reflect the NEW content (it ran after the write).
    const feedback = browser.sent.find(s => s.includes('BATCH'));
    expect(feedback).toContain('NEW');
  });

  test('an error in one batched call does not abort the others', async () => {
    const batch = '<tool_call>{"tool":"read_file","args":{"path":"does-not-exist.txt"}}</tool_call>\n' +
                  '<tool_call>{"tool":"write_file","args":{"path":"ok.txt","content":"OK"}}</tool_call>';

    const browser = makeFakeBrowser([batch, 'TASK_COMPLETE']);
    const agent = new DeepSeekAgent({});
    agent.browser = browser;
    await agent.run('one bad one good');

    expect(fs.readFileSync(path.join(workdir, 'ok.txt'), 'utf8')).toBe('OK');
    const feedback = browser.sent.find(s => s.includes('BATCH'));
    expect(feedback).toContain('ok.txt');
    expect(feedback.toUpperCase()).toContain('ERROR');
  });
});

// ─────────────────────────────────────────────
//  Randomized stress: concurrency + serialization invariants
// ─────────────────────────────────────────────
describe('parallel-executor — randomized stress', () => {
  function rnd(n) { return Math.floor(Math.random() * n); }

  test('100 random batches: independent calls overlap, conflicting calls never do', async () => {
    for (let iter = 0; iter < 100; iter++) {
      const nCalls = 1 + rnd(6);
      const calls = [];
      for (let i = 0; i < nCalls; i++) {
        const isWrite = rnd(2) === 0;
        const file = 'f' + rnd(3) + '.txt'; // small pool => forces conflicts
        calls.push({
          name: isWrite ? 'write_file' : 'read_file',
          args: { path: file },
        });
      }

      // Track concurrency per conflict-key.
      let active = 0;
      let maxGlobalActive = 0;
      const perKeyActive = new Map();
      const perKeyMax = new Map();

      const exec = async (name, args) => {
        const key = conflictKeys(name, args, '.').join('|');
        active++; maxGlobalActive = Math.max(maxGlobalActive, active);
        perKeyActive.set(key, (perKeyActive.get(key) || 0) + 1);
        perKeyMax.set(key, Math.max(perKeyMax.get(key) || 0, perKeyActive.get(key)));

        await new Promise(r => setTimeout(r, 1 + rnd(5)));

        active--; perKeyActive.set(key, perKeyActive.get(key) - 1);
        return name + ':' + args.path;
      };

      const results = await executeBatch(calls, { executeTool: exec, cwd: '.', maxParallel: 4 });

      // 1. Results come back in the original order, all labelled.
      expect(results.length).toBe(calls.length);
      for (let i = 0; i < calls.length; i++) {
        expect(results[i].name).toBe(calls[i].name);
        expect(results[i].result).toBe(calls[i].name + ':' + calls[i].args.path);
      }

      // 2. INVARIANT: no two calls sharing a conflict-key ran concurrently.
      for (const [, mx] of perKeyMax) {
        expect(mx).toBe(1);
      }
    }
  });

  test('randomized shell commands with identical strings are serialised', async () => {
    for (let iter = 0; iter < 40; iter++) {
      const cmd = 'echo ' + rnd(3);
      const calls = [
        { name: 'run_command', args: { command: cmd } },
        { name: 'run_command', args: { command: cmd } },
        { name: 'run_command', args: { command: 'different-' + rnd(1000) } },
      ];
      let active = 0, maxActive = 0;
      const exec = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 3)); active--; return 'ok'; };
      await executeBatch(calls, { executeTool: exec, cwd: '.', maxParallel: 4 });
      expect(maxActive).toBeLessThanOrEqual(2);
    }
  });
});
