// src/chat-transport.js — the contract the agent loop depends on.
//
// The loop does not need to know what a DOM is. It needs four things:
//
//   send(text)              hand the prompt over
//   awaitReply(opts)        get the reply, or throw
//   newChat()               start a clean conversation
//   isGenerating()          is a reply still arriving
//
// Everything else — composers, send buttons, response containers, structural
// fallbacks, completion heuristics — is how ONE KIND of transport fulfils
// awaitReply(). Putting those on the contract forces an HTTP endpoint to
// implement selectors it will never use, which is how this layer drifted in the
// first place.
//
// So the interface is outcome-shaped: any transport must satisfy the same
// postcondition (a string, or a throw), and none of them promises anything about
// how that happened. Where the two kinds genuinely differ, they say so through
// `capabilities` rather than pretending uniformity — a browser model has no real
// stop button, an HTTP model has no page to look at.
'use strict';

/** What a transport may be able to do. Declared, never assumed. */
const DEFAULT_CAPABILITIES = Object.freeze({
  /** Can a generation in flight be interrupted? */
  stop: false,
  /** Does awaitReply emit incremental text? */
  stream: false,
  /** Can a fresh conversation be started without a page reload? */
  freshChat: true,
  /** Is there a page a human (or the dashboard) can watch? */
  observable: false,
  /** Can the model accept file attachments through the chat surface? */
  uploads: false,
});

/**
 * The four methods, and nothing else.
 *
 * Subclasses override; this class exists so the contract is written down in one
 * place and can be asserted against.
 */
class ChatTransport {
  /**
   * @param {object} [opts]
   * @param {string} [opts.model]    the model this transport talks to
   * @param {object} [opts.config]   the resolved config
   */
  constructor(opts = {}) {
    this.model = opts.model || null;
    this.config = opts.config || {};
  }

  /** What this transport can do. Merged over the defaults. */
  get capabilities() {
    return { ...DEFAULT_CAPABILITIES };
  }

  /** Hand a prompt over. Resolves when it has been accepted, not answered. */
  async send(_text) {
    throw new Error(`${this.constructor.name}.send() is not implemented`);
  }

  /**
   * Wait for the reply to the prompt most recently sent.
   *
   * @param {object} [_opts] { timeoutMs }
   * @returns {Promise<string>}
   */
  async awaitReply(_opts = {}) {
    throw new Error(`${this.constructor.name}.awaitReply() is not implemented`);
  }

  /** Start a clean conversation. */
  async newChat() {
    throw new Error(`${this.constructor.name}.newChat() is not implemented`);
  }

  /** Is a reply still arriving? */
  async isGenerating() {
    return false;
  }

  /** Interrupt a reply in flight, when `capabilities.stop` is true. */
  async stop() {
    throw new Error(`${this.constructor.name} cannot stop a generation`);
  }

  /** Release anything held — a page, a socket, a timer. */
  async close() {
    // Nothing by default.
  }
}

/**
 * Check an object against the contract.
 *
 * Used by tests to hold every transport to the same shape, so a new one cannot
 * arrive with three of the four methods and be discovered at runtime.
 *
 * @param {object} transport
 * @returns {{ok: boolean, missing: string[], reason: string|null}}
 */
function conforms(transport) {
  const missing = [];

  if (!transport || typeof transport !== 'object') {
    return { ok: false, missing: ['<not an object>'], reason: 'transport is not an object' };
  }

  for (const method of ['send', 'awaitReply', 'newChat', 'isGenerating']) {
    if (typeof transport[method] !== 'function') missing.push(method);
  }

  let reason = null;

  if (missing.length === 0) {
    const caps = transport.capabilities;
    if (!caps || typeof caps !== 'object') {
      reason = 'capabilities must be an object';
    } else if (typeof caps.stop !== 'boolean' || typeof caps.freshChat !== 'boolean') {
      reason = 'capabilities.stop and capabilities.freshChat must be booleans';
    }
  }

  return { ok: missing.length === 0 && reason === null, missing, reason };
}

/**
 * Adapt an existing browser adapter to the contract.
 *
 * The browser adapters already have the four behaviours under their own names —
 * `sendMessage`, `waitForResponse`, `newChat`, `getGenerationState`. This is the
 * whole of the translation, so step 3 of the migration is delegation rather than
 * a rewrite.
 *
 * @param {object} adapter a BaseAdapter subclass instance
 * @param {object} [opts]
 * @returns {ChatTransport}
 */
function fromBrowserAdapter(adapter, opts = {}) {
  const transport = new ChatTransport(opts);

  transport.model = opts.model || (adapter && adapter.constructor && adapter.constructor.name) || null;

  Object.defineProperty(transport, 'capabilities', {
    get() {
      return {
        ...DEFAULT_CAPABILITIES,
        stop: typeof adapter.stopGeneration === 'function',
        freshChat: typeof adapter.newChat === 'function',
        observable: true,
        uploads: typeof adapter.uploadFiles === 'function',
      };
    },
  });

  transport.send = (text) => adapter.sendMessage(text);
  transport.awaitReply = () => adapter.waitForResponse();
  transport.newChat = () => adapter.newChat();
  transport.isGenerating = async () => {
    if (typeof adapter.getGenerationState === 'function') {
      const state = await adapter.getGenerationState();
      return state === true || (state && state.generating === true);
    }
    return false;
  };

  if (typeof adapter.stopGeneration === 'function') {
    transport.stop = () => adapter.stopGeneration();
  }

  return transport;
}

module.exports = {
  ChatTransport,
  DEFAULT_CAPABILITIES,
  conforms,
  fromBrowserAdapter,
};
