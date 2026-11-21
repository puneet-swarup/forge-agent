// tests/naming.test.js — names must describe what the code is.
//
// The agent was called `DeepSeekAgent` and its browser `DeepSeekBrowser`, a
// leftover from when DeepSeek was the only provider. By 2.3.0 there are eight
// adapters and the default is configurable, so the name was actively misleading:
// reading `new DeepSeekAgent()` while running against Gemini is a false signal
// about what the class does.
//
// `DeepSeekAdapter` keeps its name — it really is the DeepSeek adapter.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('class names describe the provider they belong to', () => {
  test('the agent class is provider-neutral', () => {
    const Agent = require('../src/agent');
    expect(Agent.name).toBe('ForgeAgent');
  });

  test('the browser class is provider-neutral', () => {
    const Browser = require('../src/browser');
    expect(Browser.name).toBe('ForgeBrowser');
  });

  test('the DeepSeek adapter keeps its name', () => {
    const DeepSeekAdapter = require('../src/adapters/deepseek-adapter');
    expect(DeepSeekAdapter.name).toBe('DeepSeekAdapter');
  });

  test('no source file still calls the agent or browser DeepSeek*', () => {
    const offenders = [];

    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      if (/DeepSeekAgent|DeepSeekBrowser/.test(src)) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every adapter is named after its provider, not after the default', () => {
    const dir = path.join(SRC, 'adapters');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('-adapter.js'));

    // Providers whose class name is not a mechanical title-case of the file
    // name, because the brand capitalises differently.
    const BRANDED = { chatgpt: 'ChatGPTAdapter', deepseek: 'DeepSeekAdapter' };

    for (const file of files) {
      const Adapter = require(path.join(dir, file));
      const stem = file.replace('-adapter.js', '');

      const expected = BRANDED[stem] || stem
        .split('-')
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join('') + 'Adapter';

      expect(Adapter.name).toBe(expected);
    }
  });
});
