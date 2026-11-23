// tests/chat-transport.test.js — step 1: the contract, and proof it fits.
//
// The interface is outcome-shaped on purpose. A transport promises a reply, not
// a method of getting one. These tests hold every existing adapter to it, so
// step 3 can wrap them by delegation rather than by rewriting.
'use strict';

const fs = require('fs');
const path = require('path');

const {
  ChatTransport, DEFAULT_CAPABILITIES, conforms, fromBrowserAdapter,
} = require('../src/chat-transport');

const factory = require('../src/adapter-factory');

describe('the contract is four methods', () => {
  test('it declares exactly the four the loop needs', () => {
    for (const method of ['send', 'awaitReply', 'newChat', 'isGenerating']) {
      expect(typeof ChatTransport.prototype[method]).toBe('function');
    }
  });

  test('the base class refuses rather than silently returning undefined', async () => {
    const t = new ChatTransport();
    await expect(t.send('x')).rejects.toThrow(/not implemented/);
    await expect(t.awaitReply()).rejects.toThrow(/not implemented/);
    await expect(t.newChat()).rejects.toThrow(/not implemented/);
  });

  test('isGenerating defaults to false — "not generating" is a safe answer', async () => {
    await expect(new ChatTransport().isGenerating()).resolves.toBe(false);
  });

  test('capabilities are declared, and conservative by default', () => {
    const caps = new ChatTransport().capabilities;
    expect(caps).toEqual(DEFAULT_CAPABILITIES);
    expect(caps.stop).toBe(false);
    expect(caps.observable).toBe(false);
  });

  test('capabilities are a copy, so one transport cannot mutate another', () => {
    const a = new ChatTransport();
    const b = new ChatTransport();
    a.capabilities.stop = true;
    expect(b.capabilities.stop).toBe(false);
  });
});

describe('conformance checking', () => {
  test('a complete transport passes', () => {
    const t = new ChatTransport();
    expect(conforms(t)).toEqual({ ok: true, missing: [], reason: null });
  });

  test('a missing method is named', () => {
    const partial = { send() {}, newChat() {}, isGenerating() {}, capabilities: {} };
    const result = conforms(partial);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['awaitReply']);
  });

  test('malformed capabilities are caught', () => {
    const t = new ChatTransport();
    Object.defineProperty(t, 'capabilities', { get: () => ({ stop: 'yes' }) });
    expect(conforms(t).reason).toMatch(/booleans/);
  });

  test('null does not throw', () => {
    expect(conforms(null).ok).toBe(false);
  });
});

describe('every existing adapter fits the contract', () => {
  // Step 3 depends on this: if an adapter lacks one of the four behaviours under
  // its own name, wrapping it is a rewrite rather than delegation.
  const models = factory.SUPPORTED_MODELS;

  for (const model of models) {
    test(`${model} exposes the four behaviours`, () => {
      const Adapter = require(path.join(__dirname, '..', 'src',
        factory.getModelInfo(model).adapter));

      const proto = Adapter.prototype;

      expect(typeof proto.sendMessage).toBe('function');
      expect(typeof proto.waitForResponse).toBe('function');
      expect(typeof proto.newChat).toBe('function');
      // getGenerationState lives on the base and delegates to _isGenerating.
      expect(typeof proto.getGenerationState).toBe('function');
    });
  }

  test('the factory knows a category for each model', () => {
    for (const model of models) {
      const info = factory.getModelInfo(model);
      expect(['browser', 'http']).toContain(info.kind);
    }
  });
});

describe('fromBrowserAdapter translates without rewriting', () => {
  /** A stand-in with the four behaviours under their adapter names. */
  function fakeAdapter(overrides = {}) {
    return {
      sendMessage: async (text) => ({ sent: text }),
      waitForResponse: async () => 'the reply',
      newChat: async () => ({ ok: true }),
      getGenerationState: async () => false,
      ...overrides,
    };
  }

  test('send delegates to sendMessage', async () => {
    const t = fromBrowserAdapter(fakeAdapter());
    await expect(t.send('hello')).resolves.toEqual({ sent: 'hello' });
  });

  test('awaitReply delegates to waitForResponse', async () => {
    const t = fromBrowserAdapter(fakeAdapter());
    await expect(t.awaitReply()).resolves.toBe('the reply');
  });

  test('newChat delegates', async () => {
    const t = fromBrowserAdapter(fakeAdapter());
    await expect(t.newChat()).resolves.toEqual({ ok: true });
  });

  test('isGenerating reads either a boolean or an object', async () => {
    expect(await fromBrowserAdapter(fakeAdapter()).isGenerating()).toBe(false);
    expect(await fromBrowserAdapter(fakeAdapter({ getGenerationState: async () => true })).isGenerating()).toBe(true);
    expect(await fromBrowserAdapter(fakeAdapter({ getGenerationState: async () => ({ generating: true }) })).isGenerating()).toBe(true);
  });

  test('capabilities reflect what the adapter actually offers', () => {
    const plain = fromBrowserAdapter(fakeAdapter()).capabilities;
    expect(plain.observable).toBe(true);   // it is a page
    expect(plain.stop).toBe(false);        // no stopGeneration

    const withStop = fromBrowserAdapter(fakeAdapter({ stopGeneration: async () => {} })).capabilities;
    expect(withStop.stop).toBe(true);
  });

  test('a wrapped adapter conforms to the contract', () => {
    expect(conforms(fromBrowserAdapter(fakeAdapter())).ok).toBe(true);
  });
});
