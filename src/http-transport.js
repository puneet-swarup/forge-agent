// src/http-transport.js — an OpenAI-compatible endpoint as a chat transport.
//
// Step 2 of the split. The point is what is NOT here: no Playwright, no page, no
// selectors, no completion heuristics. `local` and `colab` currently launch a
// browser, serve a bundled HTML page, and scrape it with selectors written for
// elements this repository owns — to make one HTTP call. This does the call.
//
// The contract is the same four methods the loop already uses:
//
//   send(text)        start the request, resolve when it is away
//   awaitReply()      await it, return the text
//   newChat()         drop the conversation history
//   isGenerating()    is a request still in flight
//
// send() and awaitReply() are separate because the loop calls them separately —
// it sends, does other work, then waits. Firing the request in send() keeps that
// shape without the loop having to change.
'use strict';

const http = require('http');
const https = require('https');

const { ChatTransport } = require('./chat-transport');

const DEFAULT_TIMEOUT_MS = 180_000;

/** Endpoint path, tolerating a base URL that already ends in /v1. */
function completionUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v1\/chat\/completions$/.test(root)) return root;
  if (/\/v1$/.test(root)) return `${root}/chat/completions`;
  return `${root}/v1/chat/completions`;
}

class HttpChatTransport extends ChatTransport {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   e.g. http://localhost:11434
   * @param {string} [opts.model]   the model id the server knows
   * @param {string} [opts.apiKey]  bearer token, if the endpoint wants one
   * @param {number} [opts.timeoutMs]
   * @param {Array}  [opts.messages] pre-seeded history
   */
  constructor(opts = {}) {
    super(opts);

    this.baseUrl = opts.baseUrl || '';
    this.apiKey = opts.apiKey || null;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    this.messages = Array.isArray(opts.messages) ? [...opts.messages] : [];

    this._inflight = null;      // { promise, controller, reject }
    this._generating = false;
    this._lastError = null;
  }

  get capabilities() {
    return {
      ...super.capabilities,
      stop: true,        // an in-flight request can be aborted
      freshChat: true,   // history is ours to drop
      observable: false, // there is no page to watch
      uploads: false,    // the endpoint takes text, not the chat surface's files
    };
  }

  /** Begin the request. Resolves once it is dispatched, not once it answers. */
  async send(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('HttpChatTransport.send() requires a non-empty string');
    }
    if (!this.baseUrl) {
      throw new Error('HttpChatTransport has no endpoint (set OLLAMA_BASE_URL or --model-url)');
    }

    // A previous reply that was never awaited must not leak into this turn.
    if (this._inflight) {
      throw new Error('send() called while a reply is still in flight');
    }

    this.messages.push({ role: 'user', content: text });

    const payload = JSON.stringify({
      model: this.model || 'default',
      messages: this.messages,
      stream: false,
    });

    const controller = new AbortController();
    this._generating = true;

    const promise = this._request(payload, controller.signal)
      .then((reply) => {
        this.messages.push({ role: 'assistant', content: reply });
        return reply;
      })
      .finally(() => {
        this._generating = false;
        this._inflight = null;
      });

    // Keep a handle so awaitReply can await it and stop() can abort it.
    this._inflight = { promise, controller };

    // A rejection with nobody awaiting yet must not become an unhandled
    // rejection: awaitReply attaches, and stop() may drop it entirely.
    promise.catch(() => {});

    return { dispatched: true };
  }

  /** Await the reply started by send(). */
  async awaitReply(opts = {}) {
    if (!this._inflight) {
      throw new Error('awaitReply() called with no prompt in flight');
    }

    const { promise } = this._inflight;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : this.timeoutMs;

    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no reply within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs
      );
    });

    try {
      const text = await Promise.race([promise, timeout]);
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Drop the conversation. The endpoint holds no session of its own. */
  async newChat() {
    this.messages = [];
    return { ok: true };
  }

  /** Is a request still in flight? */
  async isGenerating() {
    return this._generating === true;
  }

  /** Abort the request in flight, if any. */
  async stop() {
    if (this._inflight && this._inflight.controller) {
      this._inflight.controller.abort();
      this._inflight = null;
      this._generating = false;
      return { stopped: true };
    }
    return { stopped: false };
  }

  /** Nothing held open — the request closes itself. */
  async close() {
    await this.stop().catch(() => {});
  }

  /**
   * One POST, resolved rather than thrown where it matters.
   *
   * @param {string} body
   * @param {AbortSignal} signal
   * @returns {Promise<string>}
   */
  _request(body, signal) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(completionUrl(this.baseUrl));
      } catch (err) {
        reject(new Error(`invalid endpoint: ${err.message}`));
        return;
      }

      const transport = parsed.protocol === 'https:' ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Free ngrok tunnels serve an HTML interstitial without this.
        'ngrok-skip-browser-warning': '1',
        'User-Agent': 'forge-agent/http-transport',
      };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const req = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        signal,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode < 200 || res.statusCode >= 300) {
            this._lastError = `HTTP ${res.statusCode}: ${text.slice(0, 300)}`;
            reject(new Error(this._lastError));
            return;
          }

          try {
            const parsedBody = JSON.parse(text);
            const choice = parsedBody.choices && parsedBody.choices[0];
            const content = choice && choice.message && choice.message.content;

            if (typeof content !== 'string') {
              reject(new Error('the endpoint returned no message content'));
              return;
            }

            resolve(content);
          } catch (_) {
            reject(new Error('the endpoint did not return JSON — check the URL and the dialect'));
          }
        });
      });

      req.on('error', (err) => {
        if (err.name === 'AbortError') {
          reject(new Error('reply stopped'));
          return;
        }
        this._lastError = err.message;
        reject(new Error(`request failed: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { HttpChatTransport, completionUrl };
