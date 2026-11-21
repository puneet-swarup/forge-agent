// tests/adapter-factory-urls.test.js — no endpoint is guessed for the user.
//
// The registry shipped a personal ngrok tunnel as the `colab` default, so any
// user who ran `--model=colab` without --model-url sent their prompts, their
// system prompt and their file contents to one individual's development
// endpoint.
'use strict';

const { getModelUrl, getModelInfo, SUPPORTED_MODELS } = require('../src/adapter-factory');

describe('model endpoints', () => {
  test('no registry entry carries a personal or tunnel host', () => {
    for (const name of SUPPORTED_MODELS) {
      const info = getModelInfo(name);
      if (!info.url) continue;
      expect(info.url).not.toMatch(/ngrok/i);
      expect(info.url).not.toMatch(/trycloudflare|localtunnel|loca\.lt/i);
    }
  });

  test('colab has no default endpoint and says so clearly', () => {
    expect(getModelInfo('colab').url).toBe(null);
    expect(() => getModelUrl('colab')).toThrow(/no default endpoint/i);
    expect(() => getModelUrl('colab')).toThrow(/--model-url/);
  });

  test('public models still resolve to their documented URLs', () => {
    expect(getModelUrl('deepseek')).toBe('https://chat.deepseek.com');
    expect(getModelUrl('chatgpt')).toBe('https://chatgpt.com');
  });

  test('an unknown model is rejected', () => {
    expect(() => getModelUrl('nope')).toThrow();
  });
});
