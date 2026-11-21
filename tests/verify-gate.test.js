// tests/verify-gate.test.js — "done" must mean done.
//
// TASK_COMPLETE used to mean "the model said so". The gate runs the project's
// own cheapest check before accepting completion, and refuses it when the check
// fails — bounded, so a broken project cannot loop forever.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const { detectChecks, runCheck, verifyProject, describeVerification } = require('../src/verify');

// A project whose `npm run typecheck` fails and whose test script passes.
function makeProject({ failing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    scripts: {
      typecheck: failing ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));

  return dir;
}

describe('detectChecks', () => {
  test('finds package.json scripts, cheapest first', () => {
    const dir = makeProject();
    const checks = detectChecks(dir);
    expect(checks.map((c) => c.name)).toEqual(['typecheck', 'test']);
    expect(checks[0].source).toBe('package.json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ignores the npm default "no test specified"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }));
    expect(detectChecks(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds a Makefile target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
    fs.writeFileSync(path.join(dir, 'Makefile'), 'check:\n\ttrue\n');
    expect(detectChecks(dir).map((c) => c.name)).toEqual(['check']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds pytest via pyproject.toml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(detectChecks(dir)[0].name).toBe('pytest');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an empty directory declares nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
    expect(detectChecks(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a malformed package.json is not fatal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(() => detectChecks(dir)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runCheck / verifyProject', () => {
  test('reports success and failure with output', async () => {
    const ok = await runCheck({ name: 'x', command: process.execPath, args: ['-e', 'console.log("fine")'] });
    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain('fine');

    const bad = await runCheck({ name: 'y', command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] });
    expect(bad.ok).toBe(false);
    expect(bad.exitCode).toBe(3);
    expect(bad.output).toContain('boom');
  });

  test('a hung check times out instead of blocking', async () => {
    const res = await runCheck(
      { name: 'slow', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10000)'] },
      { timeoutMs: 300 }
    );
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(null);
  });

  test('verifyProject reports "did not run" when nothing is declared', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
    const v = await verifyProject({ cwd: dir });
    expect(v.ran).toBe(false);
    expect(v.available).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('describeVerification is honest about each outcome', () => {
    expect(describeVerification({ ran: false })).toMatch(/unverified/);
    expect(describeVerification({ ran: true, result: { ok: true, command: 'npm run test' } }))
      .toBe('verified: `npm run test` passed');
    expect(describeVerification({ ran: true, result: { ok: false, command: 'npm run test', exitCode: 1 } }))
      .toMatch(/NOT verified.*exited 1/);
    expect(describeVerification({ ran: true, result: { ok: false, timedOut: true, command: 'make test' } }))
      .toMatch(/timed out/);
  });
});

describe('the agent refuses completion when the check fails', () => {
  let dir;
  let config;
  let orig;

  beforeEach(() => {
    config = require('../src/config');
    orig = { ...config };
    dir = makeProject({ failing: true });
    config.WORKING_DIR = dir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.VERIFY_BEFORE_COMPLETE = true;
    config.MAX_VERIFICATION_ATTEMPTS = 2;
    config.VERIFY_TIMEOUT_MS = 20_000;
  });

  afterEach(() => {
    Object.assign(config, orig);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
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

  test('a failing check sends the failure back and keeps the loop running', async () => {
    // First completion is refused, second completion is accepted (the attempt
    // budget is spent, so the gate steps aside rather than looping).
    const { agent, sent } = makeAgent([
      'All done.\nTASK_COMPLETE',        // refused (attempt 1)
      'All done again.\nTASK_COMPLETE',  // refused (attempt 2)
      'Still done.\nTASK_COMPLETE',      // budget spent: the gate steps aside
    ]);

    const result = await agent.run('do the thing');

    const refusal = sent.find((m) => m.includes('the project\'s own check failed'));
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('Fix the failure');
    expect(result).toContain('TASK_COMPLETE');
    expect(agent._verifyAttempts).toBe(2);
  }, 60000);

  test('a passing check completes without complaint', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = makeProject({ failing: false });
    config.WORKING_DIR = dir;

    const { agent, sent } = makeAgent(['done\nTASK_COMPLETE']);
    await agent.run('do the thing');

    expect(sent.some((m) => m.includes('check failed'))).toBe(false);
    expect(agent._verifyAttempts).toBe(0);
    expect(describeVerification(agent._lastVerification)).toMatch(/^verified/);
  }, 60000);

  test('the gate can be switched off', async () => {
    config.VERIFY_BEFORE_COMPLETE = false;

    const { agent, sent } = makeAgent(['done\nTASK_COMPLETE']);
    await agent.run('do the thing');

    expect(sent.some((m) => m.includes('check failed'))).toBe(false);
    expect(agent._lastVerification).toBe(null);
  }, 60000);
});
