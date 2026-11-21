// tests/prompt-pause.test.js - anti-block prompt pause (PROMPT_PAUSE)
'use strict';

const config = require('../src/config');
const DeepSeekBrowser = require('../src/browser');

describe('prompt pause (anti-block)', () => {
  let saved;

  beforeEach(() => {
    saved = {
      PROMPT_PAUSE: config.PROMPT_PAUSE,
      PROMPT_PAUSE_MIN_MS: config.PROMPT_PAUSE_MIN_MS,
      PROMPT_PAUSE_MAX_MS: config.PROMPT_PAUSE_MAX_MS,
    };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.assign(config, saved);
  });

  // Changed in 2.2.0: the fixed pause is opt-in. Paying 10-20 s before every
  // prompt cost minutes per task and did nothing for real throttling, which is
  // now handled reactively (src/throttle.js, tests/throttle.test.js).
  test('config default: OFF, with the 10s-20s bounds kept for opt-in', () => {
    expect(saved.PROMPT_PAUSE).toBe(false);
    expect(saved.PROMPT_PAUSE_MIN_MS).toBe(10000);
    expect(saved.PROMPT_PAUSE_MAX_MS).toBe(20000);
  });

  test('enabling it restores the pause', async () => {
    const b = new DeepSeekBrowser();
    config.PROMPT_PAUSE = true;
    await b._promptPause();                 // first prompt: never pauses
    expect(jest.getTimerCount()).toBe(0);

    b._promptPause();                       // second prompt: schedules one
    expect(jest.getTimerCount()).toBe(1);
  });

  test('first prompt does NOT pause', async () => {
    const b = new DeepSeekBrowser();
    config.PROMPT_PAUSE = true;
    const p = b._promptPause();
    // Resolves immediately (no timer scheduled).
    await expect(p).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('second prompt pauses within [MIN,MAX]', async () => {
    const b = new DeepSeekBrowser();
    config.PROMPT_PAUSE = true;
    config.PROMPT_PAUSE_MIN_MS = 10000;
    config.PROMPT_PAUSE_MAX_MS = 20000;

    await b._promptPause(); // first -> no pause
    expect(jest.getTimerCount()).toBe(0);

    let resolved = false;
    const p = b._promptPause().then(() => { resolved = true; });
    expect(jest.getTimerCount()).toBe(1);
    expect(resolved).toBe(false);

    jest.runAllTimers();
    await p;
    expect(resolved).toBe(true);
  });

  test('disabled: PROMPT_PAUSE=false means no timer on any prompt', async () => {
    const b = new DeepSeekBrowser();
    config.PROMPT_PAUSE = false;
    await b._promptPause(); // 1
    await b._promptPause(); // 2
    await b._promptPause(); // 3
    expect(jest.getTimerCount()).toBe(0);
  });

  test('bad bounds fall back to 10s-20s (never negative/zero)', async () => {
    const b = new DeepSeekBrowser();
    config.PROMPT_PAUSE = true;
    config.PROMPT_PAUSE_MIN_MS = -5;
    config.PROMPT_PAUSE_MAX_MS = 'oops';
    await b._promptPause(); // first
    const p = b._promptPause(); // second -> must schedule a positive timer
    expect(jest.getTimerCount()).toBe(1);
    jest.runAllTimers();
    await p;
  });
});
