// tests/throttle.test.js — back off when the provider says so, not on a timer.
//
// The agent used to sleep a random 10-20 s before every prompt. On a 60-step
// task that is 10-20 minutes of pure waiting, paid whether or not anything was
// throttled. Rate limiting is now reactive: detect the signal, back off
// exponentially and briefly, and stop after a bounded number of attempts.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const { Throttle } = require('../src/throttle');

describe('Throttle.detect', () => {
  const throttles = [
    'Too many requests. Please try again later.',
    'Rate limit reached for this model.',
    "You're sending messages too quickly.",
    'You have reached the daily limit for free users.',
    'Usage limit exceeded — try again in a few minutes.',
    'Service temporarily unavailable.',
    '请求过于频繁，请稍后再试',
  ];

  test.each(throttles)('recognises: %s', (text) => {
    expect(new Throttle().detect(text)).toBe(true);
  });

  const answers = [
    'Here is the updated server.js with rate limit handling added.',
    'I added a retry with exponential backoff to the fetch call.',
    'Done. Tests pass: 12/12.\nTASK_COMPLETE',
    '',
    null,
    undefined,
  ];

  test.each(answers)('does not misfire on: %s', (text) => {
    expect(new Throttle().detect(text)).toBe(false);
  });

  test('only the head of a long answer is inspected', () => {
    const long = 'x'.repeat(2500) + ' rate limit reached';
    expect(new Throttle().detect(long)).toBe(false);
  });
});

describe('Throttle backoff', () => {
  test('grows exponentially and is capped', () => {
    const t = new Throttle({ baseMs: 1000, maxMs: 5000, factor: 2, maxAttempts: 6 });
    expect(t.nextDelayMs()).toBe(1000);
    expect(t.nextDelayMs()).toBe(2000);
    expect(t.nextDelayMs()).toBe(4000);
    expect(t.nextDelayMs()).toBe(5000);   // capped
  });

  test('returns -1 once the attempt budget is spent', () => {
    const t = new Throttle({ baseMs: 10, maxAttempts: 2 });
    expect(t.nextDelayMs()).toBe(10);
    expect(t.nextDelayMs()).toBe(20);
    expect(t.nextDelayMs()).toBe(-1);
    expect(t.nextDelayMs()).toBe(-1);
  });

  test('a normal reply resets the budget', () => {
    const t = new Throttle({ baseMs: 10, maxAttempts: 2 });
    t.nextDelayMs();
    t.nextDelayMs();
    expect(t.nextDelayMs()).toBe(-1);

    t.noteSuccess();
    expect(t.attempts).toBe(0);
    expect(t.nextDelayMs()).toBe(10);
  });

  test('describe() is human readable', () => {
    const t = new Throttle({ baseMs: 10, maxAttempts: 4 });
    t.nextDelayMs();
    expect(t.describe()).toBe('throttled, attempt 1/4');
  });
});

describe('the loop', () => {
  let workdir;
  let orig;
  let config;

  beforeEach(() => {
    config = require('../src/config');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-throttle-'));
    orig = { ...config };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.RATE_LIMIT_BASE_MS = 5;        // keep the test fast
    config.RATE_LIMIT_MAX_MS = 20;
    config.RATE_LIMIT_MAX_ATTEMPTS = 2;
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

  test('a throttled reply is retried, not parsed as an answer', async () => {
    const { agent, sent } = makeAgent([
      'Too many requests. Please slow down.',
      'done\nTASK_COMPLETE',
    ]);

    const result = await agent.run('do the thing');

    expect(result).toContain('TASK_COMPLETE');
    // The nudge, not a parse error.
    expect(sent.some((m) => m.includes('rate-limited'))).toBe(true);
    expect(agent._throttle.attempts).toBe(0);   // reset by the normal reply
  }, 30000);

  test('gives up with a partial summary after repeated throttling', async () => {
    const { agent } = makeAgent([
      'Too many requests.',
      'Rate limit reached.',
      'Rate limit reached.',
    ]);

    const result = await agent.run('do the thing');

    expect(result).toMatch(/did not complete/);
    expect(result).toMatch(/rate limited/);
  }, 30000);

  test('backoff can be switched off', async () => {
    config.RATE_LIMIT_BACKOFF = false;
    const { agent, sent } = makeAgent([
      'Too many requests.',
      'done\nTASK_COMPLETE',
    ]);

    await agent.run('do the thing');

    // With the feature off the text is treated like any other reply.
    expect(sent.some((m) => m.includes('rate-limited'))).toBe(false);
  }, 30000);

  test('the fixed inter-prompt pause is off by default', () => {
    // Assert the loaded default, not a regex over the source: the source also
    // mentions "PROMPT_PAUSE: true" inside a comment.
    const defaults = require('../src/config');
    expect(defaults.PROMPT_PAUSE).toBe(false);
  });

  test('an answer that merely mentions rate limiting is not a throttle', () => {
    // Regression: an earlier pattern matched any "rate limit", so an agent
    // writing about rate limiting would back off on its own answer.
    const t = new Throttle();
    expect(t.detect('Here is the updated server.js with rate limit handling added.')).toBe(false);
    expect(t.detect('Rate limit exceeded. Please wait.')).toBe(true);
  });
});
