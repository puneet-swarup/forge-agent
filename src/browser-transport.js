// src/browser-transport.js — the browser as a chat transport.
//
// Step 3 of the split. Everything that makes a scraped UI work stays where it
// is: the template-method discovery, the selector lists, the structural
// fallbacks, the completion heuristics. This class is the thin seam between that
// machinery and the four methods the loop actually calls.
//
// It is deliberately dull. If it ever needs to know about a composer or a send
// button, something has leaked.
'use strict';

const { ChatTransport, DEFAULT_CAPABILITIES } = require('./chat-transport');

class BrowserChatTransport extends ChatTransport {
  /**
   * @param {object} opts
   * @param {object} opts.browser a ForgeBrowser instance (launched or not)
   * @param {string} [opts.model]
   */
  constructor(opts = {}) {
    super(opts);
    this.browser = opts.browser || null;
  }

  /** The adapter behind the browser, for callers that genuinely need it. */
  get adapter() {
    return this.browser ? this.browser.adapter : null;
  }

  get capabilities() {
    const adapter = this.adapter;

    return {
      ...DEFAULT_CAPABILITIES,
      // A page is a thing a human or the dashboard can look at. In practice the
      // prompt appears and is fired without being watched, but the page is still
      // observable — that is a fact about the transport, not about usage.
      observable: Boolean(this.browser && this.browser.page),
      stop: Boolean(adapter && typeof adapter.stopGeneration === 'function'),
      freshChat: Boolean(this.browser && typeof this.browser.newChat === 'function'),
      uploads: Boolean(adapter && typeof adapter.uploadFiles === 'function'),
    };
  }

  async send(text) {
    if (!this.browser) throw new Error('BrowserChatTransport has no browser');
    return this.browser.sendMessage(text);
  }

  async awaitReply() {
    if (!this.browser) throw new Error('BrowserChatTransport has no browser');
    return this.browser.waitForResponse();
  }

  async newChat() {
    if (!this.browser) throw new Error('BrowserChatTransport has no browser');
    return this.browser.newChat();
  }

  async isGenerating() {
    const adapter = this.adapter;
    if (!adapter || typeof adapter.getGenerationState !== 'function') return false;

    const state = await adapter.getGenerationState();
    return state === true || Boolean(state && state.generating === true);
  }

  async stop() {
    const adapter = this.adapter;
    if (!adapter || typeof adapter.stopGeneration !== 'function') {
      throw new Error(`${this.model || 'this model'} cannot stop a generation`);
    }
    return adapter.stopGeneration();
  }

  /** The browser owns its lifecycle; the transport does not close it. */
  async close() {
    // Intentionally empty: ForgeBrowser.close() is called by the agent's own
    // shutdown path, and closing it here would double-close.
  }
}

module.exports = { BrowserChatTransport };
