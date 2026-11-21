// tests/adapter-turn-contract.test.js — drives the REAL DeepSeekAdapter
// through sendMessage() -> waitForResponse() against an in-memory fake DOM.
//
// Why: tests/integration-browser.test.js covers this with real Chromium, but
// it is skipped wherever a browser cannot launch (CI containers, sandboxes).
// This suite needs no browser and still exercises the production class, so the
// send/baseline/scrape wiring cannot regress unnoticed.
'use strict';

const DeepSeekAdapter = require('../src/adapters/deepseek-adapter');

// ── a very small fake DOM ──────────────────────────────────────────────────

class FakeDom {
  constructor() {
    this.assistant = [];      // rendered assistant replies
    this.composer = '';
    this.generating = false;
    this.pending = null;      // { full, i } while "streaming"
    this.deliver = true;      // false = the UI silently drops the submit
    this.sends = 0;
  }

  matches(selector) {
    if (/assistant/i.test(selector)) return 'assistant';
    if (/textarea/i.test(selector)) return 'composer';
    if (/send/i.test(selector)) return 'send';
    return null;
  }

  nodes(selector) {
    const kind = this.matches(selector);
    if (kind === 'assistant') return this.assistant;
    if (kind === 'composer') return ['composer'];
    if (kind === 'send') return ['send'];
    return [];
  }

  // ── Playwright surface used by the adapter ───────────────────────────────
  locator(selector) {
    const self = this;
    const kind = this.matches(selector);
    const present = kind === 'assistant' ? this.assistant.length > 0 : kind !== null;
    const el = {
      async count() { return present ? 1 : 0; },
      async isVisible() { return present; },
      async isEnabled() { return present; },
      async innerText() {
        if (kind === 'assistant') return self.assistant[self.assistant.length - 1] || '';
        return '';
      },
      async click() {
        if (kind === 'send') self.send();
      },
      async fill(text) {
        if (kind === 'composer') self.composer = text;
      },
      async evaluate() {
        return kind === 'composer' ? self.composer : self.generating;
      },
      last() { return el; },
    };
    return el;
  }

  async $$(selector) {
    return this.nodes(selector).map((text) => ({
      async isVisible() { return true; },
      async innerText() { return text; },
    }));
  }

  keyboard = { press: async () => this.send() };

  // _isGenerating() evaluates a function in the page; the fake only needs to
  // report the streaming flag.
  async evaluate() { return this.generating; }

  async waitForTimeout(ms) {
    this.tick(ms);
    await Promise.resolve();
  }

  // ── simulation ───────────────────────────────────────────────────────────
  send() {
    this.sends++;
    if (!this.deliver) return;          // dropped submit: no bubble appears
    const full = 'Echo: ' + this.composer;
    this.assistant.push('');
    this.pending = { full, i: 0 };
    this.generating = true;
  }

  tick() {
    if (!this.pending) return;
    const step = 6;
    this.pending.i = Math.min(this.pending.i + step, this.pending.full.length);
    this.assistant[this.assistant.length - 1] = this.pending.full.slice(0, this.pending.i);
    if (this.pending.i >= this.pending.full.length) {
      this.pending = null;
      this.generating = false;
    }
  }
}

function makeAdapter(dom, overrides = {}) {
  return new DeepSeekAdapter(dom, {
    DEEPSEEK_URL: 'about:blank',
    SEND_DELAY: 0,
    GENERATION_POLL: 1,
    STABLE_DELAY: 5,
    APPEAR_TIMEOUT: 500,
    RESPONSE_TIMEOUT: 3000,
    ...overrides,
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('DeepSeekAdapter turn contract (fake DOM)', () => {
  test('sendMessage then waitForResponse returns the new reply', async () => {
    const dom = new FakeDom();
    const a = makeAdapter(dom);

    await a.sendMessage('hello');
    const reply = await a.waitForResponse();

    expect(reply).toBe('Echo: hello');
    expect(dom.sends).toBe(1);
    expect(a._lastCompletionSignal).toBe('idle');
  });

  test('consecutive turns each return their own reply', async () => {
    const dom = new FakeDom();
    const a = makeAdapter(dom);

    await a.sendMessage('one');
    expect(await a.waitForResponse()).toBe('Echo: one');

    await a.sendMessage('two');
    expect(await a.waitForResponse()).toBe('Echo: two');

    await a.sendMessage('three');
    expect(await a.waitForResponse()).toBe('Echo: three');
  });

  test('a dropped submit fails at the turn boundary instead of repeating the last reply', async () => {
    const dom = new FakeDom();
    const a = makeAdapter(dom);

    await a.sendMessage('first');
    expect(await a.waitForResponse()).toBe('Echo: first');

    dom.deliver = false;                 // the UI now silently drops submits
    await a.sendMessage('second');

    await expect(a.waitForResponse()).rejects.toMatchObject({ turnBoundary: 'appear' });
  });

  test('the baseline is captured before the send and consumed once', async () => {
    const dom = new FakeDom();
    const a = makeAdapter(dom);

    expect(a._pendingTurn).toBe(null);
    await a.sendMessage('x');
    expect(a._pendingTurn).not.toBe(null);   // captured by sendMessage
    await a.waitForResponse();
    expect(a._pendingTurn).toBe(null);       // consumed by waitForResponse
  });

  test('marker-terminated replies complete without waiting for the stable delay', async () => {
    const dom = new FakeDom();
    const a = makeAdapter(dom, { STABLE_DELAY: 10_000 });

    // Stream a marker-terminated reply.
    const origSend = dom.send.bind(dom);
    dom.send = function () {
      this.sends++;
      this.assistant.push('<<<FORGE_START>>>\ndone\n<<<FORGE_END>>>');
      this.generating = false;
      this.pending = null;
    };

    await a.sendMessage('marker please');
    const reply = await a.waitForResponse();

    expect(reply).toContain('done');
    expect(a._lastCompletionSignal).toBe('marker');
    dom.send = origSend;
  });
});
