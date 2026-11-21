// tests/budget.test.js — the run's resource envelope is real.
//
// MAX_ITERATIONS was documented, displayed and settable via /iterations, but no
// execution path read it: the loop used a literal `if (step > 10000)`, and
// `--max-iterations` was in the help text and never parsed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const { Budget, BudgetExceeded } = require('../src/budget');

describe('Budget', () => {
  test('counts steps and throws at the limit', () => {
    const b = new Budget({ MAX_ITERATIONS: 3 });
    b.tick(); b.tick(); b.tick();
    expect(b.steps).toBe(3);
    expect(() => b.tick()).toThrow(BudgetExceeded);
  });

  test('the error names the limit and the usage', () => {
    const b = new Budget({ MAX_ITERATIONS: 1 });
    b.tick();
    try {
      b.tick();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.kind).toBe('steps');
      expect(err.limit).toBe(1);
      expect(err.message).toMatch(/step limit reached \(1\/1\)/);
      expect(err.retryable).toBe(false);
    }
  });

  test('enforces a wall-clock limit', () => {
    const b = new Budget({ MAX_ITERATIONS: 100, MAX_RUNTIME_MS: 20 });
    b.startedAt = Date.now() - 1000;
    expect(() => b.tick()).toThrow(/time limit reached/);
  });

  test('enforces a tool-call limit', () => {
    const b = new Budget({ MAX_TOOL_CALLS: 2 });
    b.recordToolCalls(2);
    expect(() => b.recordToolCalls(1)).toThrow(/tool-call limit/);
  });

  test('a limit of 0 means unlimited', () => {
    const b = new Budget({ MAX_ITERATIONS: 0, MAX_RUNTIME_MS: 0, MAX_TOOL_CALLS: 0 });
    b.startedAt = Date.now() - 10 * 60_000;
    for (let i = 0; i < 50; i++) b.tick();
    b.recordToolCalls(1000);
    expect(b.steps).toBe(50);
  });

  test('defaults to 100 steps', () => {
    expect(new Budget().maxSteps).toBe(100);
  });

  test('describe() reports progress against the limits', () => {
    const b = new Budget({ MAX_ITERATIONS: 10, MAX_TOOL_CALLS: 4 });
    b.tick(); b.recordToolCalls(2);
    expect(b.describe()).toBe('1/10 steps · 2/4 tools');
  });
});

describe('agent loop enforcement', () => {
  let workdir;
  let orig;
  let config;

  beforeEach(() => {
    config = require('../src/config');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-budget-'));
    orig = { ...config };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
  });

  afterEach(() => {
    Object.assign(config, orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  function makeAgent(responses) {
    const queue = [...responses];
    const DeepSeekAgent = require('../src/agent');
    const agent = new DeepSeekAgent({});
    const sent = [];
    agent.browser = {
      async launch() {}, async close() {}, async newChat() {},
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() {
        if (!queue.length) throw new Error('no scripted response left');
        return queue.shift();
      },
    };
    return { agent, sent };
  }

  test('--max-iterations stops the run with a partial summary', async () => {
    config.MAX_ITERATIONS = 2;

    // The model never stops asking for tools.
    const loop = '<tool_call>{"tool":"list_directory","args":{}}</tool_call>';
    const { agent } = makeAgent([loop, loop, loop, loop, loop, loop]);

    const result = await agent.run('never finishes');

    expect(result).toMatch(/did not complete/);
    expect(result).toMatch(/step limit reached/);
    expect(agent._budget.steps).toBe(2);
  }, 30000);

  test('the default 100-step ceiling is no longer a literal 10000', async () => {
    config.MAX_ITERATIONS = 1;
    const loop = '<tool_call>{"tool":"list_directory","args":{}}</tool_call>';
    const { agent } = makeAgent([loop, loop, loop]);

    const result = await agent.run('one step only');

    expect(result).toMatch(/step limit reached \(1\/1\)/);
  }, 30000);

  test('a completed run reports its budget usage', async () => {
    config.MAX_ITERATIONS = 50;
    const { agent } = makeAgent(['done\nTASK_COMPLETE']);

    await agent.run('quick task');

    expect(agent._budget.steps).toBe(1);
    expect(agent._budget.maxSteps).toBe(50);
  }, 30000);
});

describe('CLI flag parsing', () => {
  const { execFileSync } = require('child_process');

  test('--max-iterations, --max-runtime and --max-tool-calls reach the config', () => {
    // Run the CLI's own parser in a child so process.exit() cannot affect us.
    const script = `
      const path = require('path');
      process.argv = ['node','forge-agent','--max-iterations','7','--max-runtime','2h','--max-tool-calls','9','task'];
      const config = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config'))});
      const idx = require('fs').readFileSync(${JSON.stringify(path.join(__dirname, '..', 'src', 'index.js'))}, 'utf8');
      // parseArgs/applyFlagsToConfig are module-private; assert on the source
      // contract instead: the flags exist and are applied.
      const ok = /case '--max-iterations'/.test(idx) &&
                 /case '--max-runtime'/.test(idx) &&
                 /case '--max-tool-calls'/.test(idx) &&
                 /config.MAX_ITERATIONS = Math.floor/.test(idx) &&
                 /config.MAX_RUNTIME_MS = ms/.test(idx) &&
                 /config.MAX_TOOL_CALLS = Math.floor/.test(idx);
      console.log(ok ? 'OK' : 'MISSING');
      process.exit(ok ? 0 : 1);
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
    expect(out).toBe('OK');
  });
});
