// tests/agent-transport.test.js — step 4: the loop depends on the interface.
//
// The agent used to reach through to `this.browser` for 25 sends, 3 waits and 2
// new chats, which is what made the browser layer look universal. It now calls
// four transport methods. These tests hold that boundary: an HTTP model must not
// launch a browser, and a browser model must not lose its behaviour.
'use strict';

const fs = require('fs');
const path = require('path');

const AGENT = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');

describe('the loop talks to a transport, not to a browser', () => {
  test('it no longer calls browser.sendMessage / waitForResponse / newChat', () => {
    expect(AGENT).not.toContain('this.browser.sendMessage(');
    expect(AGENT).not.toContain('this.browser.waitForResponse(');
    expect(AGENT).not.toContain('this.browser.newChat(');
  });

  test('it calls the four transport methods instead', () => {
    expect(AGENT).toContain('this.transport.send(');
    expect(AGENT).toContain('this.transport.awaitReply(');
    expect(AGENT).toContain('this.transport.newChat(');
  });

  test('the browser is launched only when the model needs one', () => {
    expect(AGENT).toContain('needsBrowser(config.MODEL');
    expect(AGENT).toMatch(/if \(this\._needsBrowser\) \{/);
  });

  test('shutdown closes the browser only if it was launched', () => {
    expect(AGENT).toContain('if (this._needsBrowser !== false) await this.browser.close()');
  });
});

describe('the agent defaults to the browser transport', () => {
  const ForgeAgent = require('../src/agent');

  test('an agent with a stub browser works without the startup path', () => {
    const agent = new ForgeAgent({});
    agent.browser = {
      async sendMessage() { return { ok: true }; },
      async waitForResponse() { return 'reply'; },
      async newChat() {},
      adapter: { getGenerationState: async () => false },
      page: {},
    };

    // No run(), no transport set — the getter must still hand back something
    // usable, because browser is the default category.
    expect(agent.transport.constructor.name).toBe('BrowserChatTransport');
  });

  test('the fallback delegates to the browser that was set', async () => {
    const agent = new ForgeAgent({});
    const sent = [];
    agent.browser = {
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() { return 'ok'; },
      async newChat() {},
      adapter: {},
    };

    await agent.transport.send('hello');
    expect(sent).toEqual(['hello']);
  });

  test('an agent with no browser and no transport says so', () => {
    const agent = new ForgeAgent({});
    agent.browser = null;
    expect(() => agent.transport).toThrow(/neither a transport nor a browser/);
  });

  test('a transport can be injected', () => {
    const agent = new ForgeAgent({});
    const fake = { send: async () => {}, awaitReply: async () => 'x', newChat: async () => {}, isGenerating: async () => false };
    agent.transport = fake;
    expect(agent.transport).toBe(fake);
  });
});

describe('an HTTP model never launches a browser', () => {
  const { createTransport, needsBrowser } = require('../src/transport-factory');

  test('local is categorised as an endpoint', () => {
    expect(needsBrowser('local')).toBe(false);
  });

  test('the transport it gets has no page', () => {
    const t = createTransport({ model: 'local', config: { OLLAMA_BASE_URL: 'http://127.0.0.1:1' } });
    expect(t.constructor.name).toBe('HttpChatTransport');
    expect(t.browser).toBeUndefined();
  });

  test('every browser model is still a browser model', () => {
    for (const model of ['deepseek', 'gemini', 'qwen', 'chatgpt', 'sarvam', 'google']) {
      expect(needsBrowser(model)).toBe(true);
    }
  });
});
