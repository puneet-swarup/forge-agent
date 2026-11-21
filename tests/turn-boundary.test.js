// tests/turn-boundary.test.js — the measured turn boundary.
//
// Why these exist: completion used to be "the text stopped changing for
// STABLE_DELAY", which (a) cost 1.5-3 s per turn and (b) could return the
// PREVIOUS reply if the new bubble had not rendered yet. The adapter now
// baselines the transcript before sending, waits for it to change, and only
// then decides completion (END marker > idle + stopped generator > timeout).
//
// These are pure unit tests against a fake page: no Chromium, no network.
'use strict';

const BaseAdapter = require('../src/adapters/base-adapter');

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeElement {
  constructor(page, index) {
    this.page = page;
    this.index = index;
  }
  async isVisible() { return true; }
  async innerText() { return this.page.textAt(this.index); }
  async evaluate() { return this.page.textAt(this.index); }
}

class FakePage {
  /**
   * @param {string[]} script  successive texts of the last node
   * @param {object}   opts    { counts, generating }
   */
  constructor(script = [''], opts = {}) {
    this.script = script.slice();
    this.step = 0;
    this.counts = opts.counts || null;   // optional per-poll node counts
    this.generating = !!opts.generating;
    this.polls = 0;
    this.slept = 0;
  }
  textAt() {
    const i = Math.min(this.step, this.script.length - 1);
    return this.script[i];
  }
  nodeCount() {
    if (!this.counts) return 1;
    return this.counts[Math.min(this.polls, this.counts.length - 1)];
  }
  async $$() {
    this.polls++;
    if (this.counts) this.step = Math.min(this.step + 1, this.script.length - 1);
    const n = this.nodeCount();
    const out = [];
    for (let i = 0; i < n; i++) out.push(new FakeElement(this, i));
    return out;
  }
  async waitForTimeout(ms) {
    this.slept += ms;
    this.step = Math.min(this.step + 1, this.script.length - 1);
    await new Promise(r => setTimeout(r, 1));
  }
}

class TestAdapter extends BaseAdapter {
  _getInputSelectors() { return ['#in']; }
  _getSendSelectors() { return ['#send']; }
  _getStopSelectors() { return ['#stop']; }
  _getNewChatSelectors() { return ['#new']; }
  _getResponseSelectors() { return ['.msg']; }
  getModelUrl() { return 'about:blank'; }
  async getGenerationState() { return this.page.generating; }
}

function makeAdapter(page, config = {}) {
  return new TestAdapter(page, {
    STABLE_DELAY: 20,
    GENERATION_POLL: 2,
    RESPONSE_TIMEOUT: 3000,
    APPEAR_TIMEOUT: 500,
    SEND_DELAY: 0,
    ...config,
  });
}

const START = '<<<FORGE_START>>>';
const END   = '<<<FORGE_END>>>';

// ── tests ──────────────────────────────────────────────────────────────────

describe('turn boundary — baseline', () => {
  test('captures selector, count and a hash of the last reply', async () => {
    const page = new FakePage(['hello'], { counts: [1] });
    const a = makeAdapter(page);
    const b = await a._transcriptBaseline();
    expect(b.selector).toBe('.msg');
    expect(b.count).toBe(1);
    expect(b.lastHash).toBe(a._hashText('hello'));
  });

  test('an empty transcript baselines to count 0 with no selector', async () => {
    const page = new FakePage([''], { counts: [0] });
    const a = makeAdapter(page);
    const b = await a._transcriptBaseline();
    expect(b.count).toBe(0);
    expect(b.selector).toBe(null);
  });

  test('_hashText changes when the text changes and is stable otherwise', () => {
    const a = makeAdapter(new FakePage(['x']));
    expect(a._hashText('abc')).toBe(a._hashText('abc'));
    expect(a._hashText('abc')).not.toBe(a._hashText('abd'));
    expect(a._hashText('')).toBe(a._hashText(''));
  });
});

describe('turn boundary — wait for a NEW reply', () => {
  test('resolves when the node count grows', async () => {
    const page = new FakePage(['old', 'new'], { counts: [1, 1, 2] });
    const a = makeAdapter(page);
    const baseline = { selector: '.msg', count: 1, lastHash: a._hashText('old') };
    await expect(a._waitForNewBubble(baseline)).resolves.toBe(true);
  });

  test('resolves when the last node text changes in place', async () => {
    const page = new FakePage(['old', 'streaming'], { counts: [1] });
    const a = makeAdapter(page);
    const baseline = { selector: '.msg', count: 1, lastHash: a._hashText('old') };
    await expect(a._waitForNewBubble(baseline)).resolves.toBe(true);
  });

  test('a frozen transcript throws a retryable turn-boundary error instead of returning stale text', async () => {
    const page = new FakePage(['the previous answer'], { counts: [1] });
    const a = makeAdapter(page, { APPEAR_TIMEOUT: 40 });
    const baseline = { selector: '.msg', count: 1, lastHash: a._hashText('the previous answer') };

    await expect(a._waitForNewBubble(baseline)).rejects.toMatchObject({
      turnBoundary: 'appear',
      retryable: true,
    });
  });

  test('waitForResponse surfaces the turn-boundary error unwrapped (no misleading "after N seconds")', async () => {
    const page = new FakePage(['the previous answer'], { counts: [1] });
    const a = makeAdapter(page, { APPEAR_TIMEOUT: 40 });
    a._pendingTurn = { selector: '.msg', count: 1, lastHash: a._hashText('the previous answer') };

    await expect(a.waitForResponse()).rejects.toThrow(/no new reply appeared/);
    // The baseline is single-use.
    expect(a._pendingTurn).toBe(null);
  });
});

describe('turn boundary — completion signals', () => {
  test('the END marker completes the turn without waiting for the stable delay', async () => {
    const page = new FakePage([
      `${START}\nthinking`,
      `${START}\nfinal answer\n${END}`,
    ]);
    const a = makeAdapter(page, { STABLE_DELAY: 5000 });
    const t0 = Date.now();
    const text = await a._waitForTextStable({ containerSelectors: ['.msg'] });
    const elapsed = Date.now() - t0;

    expect(text).toContain('final answer');
    expect(a._lastCompletionSignal).toBe('marker');
    expect(elapsed).toBeLessThan(1000);   // far below STABLE_DELAY
  });

  test('without markers, idle text plus a stopped generator completes the turn', async () => {
    const page = new FakePage(['plain reply'], { counts: [1] });
    page.generating = false;
    const a = makeAdapter(page);
    const text = await a._waitForTextStable({ containerSelectors: ['.msg'] });

    expect(text).toBe('plain reply');
    expect(a._lastCompletionSignal).toBe('idle');
  });

  test('an END marker that arrives before START does not complete the turn', async () => {
    const page = new FakePage([`${END} noise`, `${END} noise`], { counts: [1] });
    page.generating = true;            // still streaming
    const a = makeAdapter(page, { RESPONSE_TIMEOUT: 60 });
    await expect(a._waitForTextStable({ containerSelectors: ['.msg'] })).rejects.toThrow(/timeout/i);
  });

  test('the adapter never returns the text it just sent', async () => {
    const page = new FakePage(['please fix the bug', 'Echo: please fix the bug'], { counts: [1] });
    const a = makeAdapter(page);
    a._lastSentText = 'please fix the bug';
    const text = await a._waitForTextStable({ containerSelectors: ['.msg'] });
    expect(text).toBe('Echo: please fix the bug');
  });
});
