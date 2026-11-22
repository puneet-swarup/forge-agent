// tests/prompt-pause.test.js — the anti-block pause, per model.
//
// The original design was a blanket 10-20 s wait before every prompt, to avoid
// being blocked by a cloud provider. That is the right idea aimed at the wrong
// target: a local daemon and a plain HTTP API are not going to block anyone, and
// 15 s per step costs 15 minutes on a 60-step task.
//
// The policy is now per model, and pure — testable without a browser or a clock.
'use strict';

const { resolvePromptPause } = require('../src/browser');

const base = {
  PROMPT_PAUSE: false,
  PROMPT_PAUSE_MIN_MS: 10_000,
  PROMPT_PAUSE_MAX_MS: 20_000,
  PROMPT_PAUSE_BY_MODEL: {},
  PROMPT_PAUSE_SKIP: ['local', 'ollama', 'colab', 'sarvam-api'],
};

describe('per-model pause', () => {
  test('an explicit figure wins over everything else', () => {
    const cfg = { ...base, PROMPT_PAUSE_BY_MODEL: { chatgpt: 2, deepseek: 15 } };
    expect(resolvePromptPause('chatgpt', cfg)).toBe(2000);
    expect(resolvePromptPause('deepseek', cfg)).toBe(15000);
  });

  test('the two models can differ, which is the point', () => {
    const cfg = { ...base, PROMPT_PAUSE_BY_MODEL: { chatgpt: 2, deepseek: 15 } };
    expect(resolvePromptPause('chatgpt', cfg)).not.toBe(resolvePromptPause('deepseek', cfg));
  });

  test('a model with no entry and no global pause does not wait', () => {
    expect(resolvePromptPause('gemini', { ...base, PROMPT_PAUSE_BY_MODEL: { deepseek: 15 } })).toBe(0);
  });

  test('model names are case-insensitive', () => {
    const cfg = { ...base, PROMPT_PAUSE_BY_MODEL: { deepseek: 15 } };
    expect(resolvePromptPause('DeepSeek', cfg)).toBe(15000);
  });

  test('zero is respected as "no pause", not treated as unset', () => {
    const cfg = { ...base, PROMPT_PAUSE: true, PROMPT_PAUSE_BY_MODEL: { deepseek: 0 } };
    expect(resolvePromptPause('deepseek', cfg)).toBe(0);
  });
});

describe('local and HTTP models never pause by default', () => {
  for (const model of ['local', 'ollama', 'colab', 'sarvam-api']) {
    test(`${model} skips the pause even when one is configured`, () => {
      const cfg = {
        ...base,
        PROMPT_PAUSE: true,
        PROMPT_PAUSE_BY_MODEL: { [model]: 15 },
      };
      expect(resolvePromptPause(model, cfg)).toBe(0);
    });
  }

  test('an HTTP model can still be forced to pause by removing it from the skip list', () => {
    const cfg = {
      ...base,
      PROMPT_PAUSE_SKIP: [],
      PROMPT_PAUSE_BY_MODEL: { ollama: 3 },
    };
    expect(resolvePromptPause('ollama', cfg)).toBe(3000);
  });
});

describe('the blanket pause still works', () => {
  test('PROMPT_PAUSE produces a value inside the configured range', () => {
    const cfg = { ...base, PROMPT_PAUSE: true };
    for (const r of [0, 0.5, 0.999]) {
      const ms = resolvePromptPause('deepseek', cfg, () => r);
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(20_000);
    }
  });

  test('off by default, so a run is not taxed', () => {
    expect(resolvePromptPause('deepseek', base)).toBe(0);
  });

  test('a malformed range falls back rather than producing NaN', () => {
    const cfg = { ...base, PROMPT_PAUSE: true, PROMPT_PAUSE_MIN_MS: 'x', PROMPT_PAUSE_MAX_MS: null };
    const ms = resolvePromptPause('deepseek', cfg, () => 0);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBe(10_000);
  });
});

describe('the CLI exposes it', () => {
  const { parseArgs } = require('../src/index');
  const parse = (...argv) => parseArgs(['node', 'forge-agent', ...argv]);

  test('--pause=<sec> sets the selected model', () => {
    expect(parse('--pause=15').pauseSeconds).toBe(15);
  });

  test('--pause=<model>:<sec> sets one model by name', () => {
    expect(parse('--pause=deepseek:15').pauseByModel).toEqual({ deepseek: 15 });
    expect(parse('--pause=chatgpt:2').pauseByModel).toEqual({ chatgpt: 2 });
  });

  test('two per-model pauses accumulate', () => {
    const args = parse('--pause=deepseek:15', '--pause=chatgpt:2');
    expect(args.pauseByModel).toEqual({ deepseek: 15, chatgpt: 2 });
  });

  test('--no-pause is a flag', () => {
    expect(parse('--no-pause').noPause).toBe(true);
  });

  test('a non-numeric pause is rejected rather than silently ignored', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(src).toContain('--pause needs a number of seconds');
  });
});
