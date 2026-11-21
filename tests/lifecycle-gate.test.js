// tests/lifecycle-gate.test.js — the plan gate, and the loop that enforces it.
//
// The contract (FORGE_PLAN.md created at start, ticked per step, kept until
// sign-off) was declared in src/lifecycle.js and checked by scripts/lifecycle.js
// — but the agent loop never called either. These tests pin the two decisions
// the loop now makes: before the first mutating tool, and at TASK_COMPLETE.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const {
  looksMultiStep,
  isPlanWrite,
  pathsOf,
  decideStart,
  decideEnd,
  formatStartFeedback,
  formatEndFeedback,
} = require('../src/lifecycle-gate');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plangate-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

function write(file, content) {
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
}

const PLAN_OPEN = ['# FORGE_PLAN', '', '- [x] step one', '- [ ] step two'].join('\n');
const PLAN_DONE = ['# FORGE_PLAN', '', '- [x] step one', '- [x] step two'].join('\n');

describe('looksMultiStep', () => {
  test('a one-clause instruction is a single step', () => {
    expect(looksMultiStep('create hello.js')).toBe(false);
    expect(looksMultiStep('rename src/a.js to src/b.js')).toBe(false);
    expect(looksMultiStep('')).toBe(false);
    expect(looksMultiStep(null)).toBe(false);
  });

  test('sequence markers make it multi-step', () => {
    expect(looksMultiStep('write the parser then the tests')).toBe(true);
    expect(looksMultiStep('first audit, after that rewrite')).toBe(true);
    expect(looksMultiStep('refactor the module; keep tests green')).toBe(true);
    expect(looksMultiStep('1. read the file 2. change it')).toBe(true);
  });

  test('a long instruction counts as multi-step', () => {
    expect(looksMultiStep('x'.repeat(161))).toBe(true);
  });
});

describe('isPlanWrite / pathsOf', () => {
  test('recognises a write to the plan, on any platform separator', () => {
    expect(isPlanWrite('write_file', { path: 'FORGE_PLAN.md' })).toBe(true);
    expect(isPlanWrite('write_file', { path: './FORGE_PLAN.md' })).toBe(true);
    expect(isPlanWrite('append_to_file', { path: 'C:\\proj\\FORGE_PLAN.md' })).toBe(true);
    expect(isPlanWrite('write_files', { files: [{ path: 'FORGE_PLAN.md', content: 'x' }] })).toBe(true);
  });

  test('an ordinary file is not the plan', () => {
    expect(isPlanWrite('write_file', { path: 'src/agent.js' })).toBe(false);
    expect(isPlanWrite('write_file', { path: 'notes/FORGE_PLAN.md.bak' })).toBe(false);
    expect(isPlanWrite('write_file', {})).toBe(false);
    expect(isPlanWrite('write_file', null)).toBe(false);
  });

  test('pathsOf reads every path-shaped argument', () => {
    expect(pathsOf({ path: 'a', file: 'b', filename: 'c' })).toEqual(['a', 'b', 'c']);
    expect(pathsOf({ files: [{ path: 'd' }, {}] })).toEqual(['d']);
    expect(pathsOf(undefined)).toEqual([]);
  });
});

describe('decideStart', () => {
  test('refuses a multi-step task with no plan, and says how to fix it', () => {
    const d = decideStart({ dir, task: 'write the parser then the tests' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('refused');
    expect(d.errors.join(' ')).toContain('FORGE_PLAN.md');
    expect(d.feedback).toContain('FORGE_PLAN.md');
    expect(d.feedback).toContain('- [ ]');
  });

  test('a plan with steps satisfies the gate', () => {
    write('FORGE_PLAN.md', PLAN_OPEN);
    expect(decideStart({ dir, task: 'write the parser then the tests' })).toMatchObject({
      allow: true, reason: 'plan-present',
    });
  });

  test('a plan with no steps does not satisfy the gate', () => {
    write('FORGE_PLAN.md', '# FORGE_PLAN\n\njust prose\n');
    const d = decideStart({ dir, task: 'write the parser then the tests' });
    expect(d.allow).toBe(false);
    expect(d.errors.join(' ')).toContain('no "- [ ]" steps');
  });

  test('a single-step task is not asked for a plan', () => {
    const d = decideStart({ dir, task: 'create hello.js' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('single-step');
  });

  test('multistepOnly=false gates single-step tasks too', () => {
    const d = decideStart({ dir, task: 'create hello.js', multistepOnly: false });
    expect(d.allow).toBe(false);
  });

  test('the gate steps aside once attempts are exhausted', () => {
    const d = decideStart({ dir, task: 'write the parser then the tests', attempt: 2, maxAttempts: 2 });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('exhausted');
    expect(d.exhausted).toBe(true);
  });

  test('disabled means no I/O and no refusal', () => {
    expect(decideStart({ dir, task: 'write the parser then the tests', enabled: false })).toMatchObject({
      allow: true, reason: 'disabled',
    });
  });
});

describe('decideEnd', () => {
  test('refuses completion while a step is open', () => {
    write('FORGE_PLAN.md', PLAN_OPEN);
    const d = decideEnd({ dir });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('open-steps');
    expect(d.errors.join(' ')).toContain('unchecked step');
    expect(d.feedback).toContain('TASK_COMPLETE');
  });

  test('a fully ticked plan allows completion', () => {
    write('FORGE_PLAN.md', PLAN_DONE);
    expect(decideEnd({ dir })).toMatchObject({ allow: true, reason: 'complete' });
  });

  test('no plan file is reported, never refused (no deadlock)', () => {
    const d = decideEnd({ dir });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('no-plan-file');
  });

  test('a plan with no steps is refused once, then the gate steps aside', () => {
    write('FORGE_PLAN.md', '# FORGE_PLAN\n\nprose only\n');
    expect(decideEnd({ dir }).allow).toBe(false);
    const d = decideEnd({ dir, attempt: 2, maxAttempts: 2 });
    expect(d.allow).toBe(true);
    expect(d.exhausted).toBe(true);
  });

  test('disabled means no refusal', () => {
    write('FORGE_PLAN.md', PLAN_OPEN);
    expect(decideEnd({ dir, enabled: false })).toMatchObject({ allow: true, reason: 'disabled' });
  });
});

describe('feedback wording', () => {
  test('start feedback names the file and the checkbox format', () => {
    const msg = formatStartFeedback(['missing FORGE_PLAN.md']);
    expect(msg).toContain('missing FORGE_PLAN.md');
    expect(msg).toContain('- [ ]');
  });

  test('end feedback lists the open steps', () => {
    const msg = formatEndFeedback(['FORGE_PLAN.md still has 1 unchecked step(s): #4 write tests']);
    expect(msg).toContain('#4 write tests');
  });
});

// ── the loop actually calls the gates ──────────────────────────────────────

describe('plan gate in the agent loop', () => {
  let workdir;
  let config;
  let orig;

  beforeEach(() => {
    config = require('../src/config');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-planloop-'));
    orig = { ...config };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.VERIFY_BEFORE_COMPLETE = false;
    config.PLAN_GATE = true;
    config.PLAN_GATE_MULTISTEP_ONLY = true;
    config.MAX_PLAN_GATE_ATTEMPTS = 2;
  });

  afterEach(() => {
    Object.assign(config, orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  function makeAgent(responses) {
    const queue = [...responses];
    const ForgeAgent = require('../src/agent');
    const agent = new ForgeAgent({});
    const sent = [];
    agent.browser = {
      async launch() {}, async close() {},
      async newChat() {},
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() {
        if (!queue.length) throw new Error('no scripted response left');
        return queue.shift();
      },
    };
    return { agent, sent };
  }

  const call = (tool, args) => '<tool_call>' + JSON.stringify({ tool, args }) + '</tool_call>';

  test('a mutating tool is refused until FORGE_PLAN.md exists', async () => {
    const { agent, sent } = makeAgent([
      call('write_file', { path: 'out.txt', content: 'x' }),      // refused
      call('write_file', { path: 'FORGE_PLAN.md', content: PLAN_DONE }), // allowed
      call('write_file', { path: 'out.txt', content: 'x' }),      // now allowed
      'done\nTASK_COMPLETE',
    ]);

    await agent.run('write the parser then the tests');

    const refusal = sent.find((m) => m.includes('Plan gate'));
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('FORGE_PLAN.md');
    expect(fs.existsSync(path.join(workdir, 'out.txt'))).toBe(true);
  }, 60000);

  test('a read-only tool is never gated', async () => {
    const { agent, sent } = makeAgent([
      call('list_directory', {}),
      'done\nTASK_COMPLETE',
    ]);

    await agent.run('read the tree then report');

    expect(sent.some((m) => m.includes('Plan gate'))).toBe(false);
  }, 60000);

  test('a single-step task is not gated', async () => {
    const { agent, sent } = makeAgent([
      call('write_file', { path: 'hello.js', content: 'console.log(1)' }),
      'done\nTASK_COMPLETE',
    ]);

    await agent.run('create hello.js');

    expect(sent.some((m) => m.includes('Plan gate'))).toBe(false);
    expect(fs.existsSync(path.join(workdir, 'hello.js'))).toBe(true);
  }, 60000);

  test('TASK_COMPLETE is refused while the plan has open steps', async () => {
    fs.writeFileSync(path.join(workdir, 'FORGE_PLAN.md'), PLAN_OPEN, 'utf8');

    const { agent, sent } = makeAgent([
      'done\nTASK_COMPLETE',                                    // refused
      call('replace_in_file', { path: 'FORGE_PLAN.md', find: '- [ ] step two', replace: '- [x] step two' }),
      'done\nTASK_COMPLETE',                                    // accepted
    ]);

    const result = await agent.run('write the parser then the tests');

    const refusal = sent.find((m) => m.includes('TASK_COMPLETE') && m.includes('plan is not finished'));
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('step two');
    expect(result).toContain('TASK_COMPLETE');
  }, 60000);

  test('the gate is bounded, so a stubborn plan cannot loop forever', async () => {
    fs.writeFileSync(path.join(workdir, 'FORGE_PLAN.md'), PLAN_OPEN, 'utf8');

    const { agent } = makeAgent([
      'done\nTASK_COMPLETE',   // refused (1)
      'done\nTASK_COMPLETE',   // refused (2)
      'done\nTASK_COMPLETE',   // accepted — gate exhausted
    ]);

    const result = await agent.run('write the parser then the tests');
    expect(result).toContain('TASK_COMPLETE');
    expect(agent._planGate.endAttempts).toBe(2);
  }, 60000);

  test('PLAN_GATE=false disables both gates', async () => {
    config.PLAN_GATE = false;
    fs.writeFileSync(path.join(workdir, 'FORGE_PLAN.md'), PLAN_OPEN, 'utf8');

    const { agent, sent } = makeAgent([
      call('write_file', { path: 'a.txt', content: 'x' }),
      'done\nTASK_COMPLETE',
    ]);

    await agent.run('write the parser then the tests');
    expect(sent.some((m) => m.includes('Plan gate'))).toBe(false);
  }, 60000);

  test('counters reset between runs on the same agent', async () => {
    const { agent } = makeAgent([
      'done\nTASK_COMPLETE', 'done\nTASK_COMPLETE', 'done\nTASK_COMPLETE',
      'done\nTASK_COMPLETE', 'done\nTASK_COMPLETE', 'done\nTASK_COMPLETE',
    ]);
    fs.writeFileSync(path.join(workdir, 'FORGE_PLAN.md'), PLAN_OPEN, 'utf8');
    await agent.run('write the parser then the tests');

    fs.writeFileSync(path.join(workdir, 'FORGE_PLAN.md'), PLAN_OPEN, 'utf8');
    await agent.run('write the parser then the tests');
    expect(agent._planGate.endAttempts).toBe(2);
  }, 60000);
});
