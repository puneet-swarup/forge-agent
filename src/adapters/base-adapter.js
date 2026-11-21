// src/adapters/base-adapter.js — Shared base class for model adapters
'use strict';

const logger = require('../logger');

// Response envelope markers. The system prompt instructs the model to wrap
// every reply in these so completion can be detected deterministically even
// when the DOM never goes fully quiet.
const RESPONSE_START = '<<<FORGE_START>>>';
const RESPONSE_END = '<<<FORGE_END>>>';

class BaseAdapter {
  constructor(page, config = {}) {
    this.page = page;
    this.config = config;
    this._projectContext = '';
    this._isFirstMessage = true;

    // Turn-boundary bookkeeping (see "Turn boundary" below).
    // `_pendingTurn` holds the transcript baseline captured by sendMessage(),
    // so waitForResponse() can prove it is reading the NEW reply rather than
    // the previous one. `_lastCompletionSignal` records which signal ended the
    // last turn ('marker' | 'idle' | 'baseline'), for traces and metrics.
    this._pendingTurn = null;
    this._lastCompletionSignal = null;
  }

  // ── Adapter interface ────────────────────────────────────────────────────

  _getInputSelectors() {
    throw new Error('_getInputSelectors() not implemented');
  }

  _getSendSelectors() {
    throw new Error('_getSendSelectors() not implemented');
  }

  _getStopSelectors() {
    throw new Error('_getStopSelectors() not implemented');
  }

  _getNewChatSelectors() {
    throw new Error('_getNewChatSelectors() not implemented');
  }

  _getResponseSelectors() {
    throw new Error('_getResponseSelectors() not implemented');
  }

  getModelUrl() {
    throw new Error('getModelUrl() not implemented');
  }

  // ── Optional model-specific discovery hooks ─────────────────────────────

  /**
   * Find the active composer.
   * Adapters can override this when their UI needs custom discovery.
   */
  async discoverComposer(options = {}) {
    return this._trySelectors(
      this._getInputSelectors(),
      options
    );
  }

  /**
   * Find the active send button.
   * Returns null when no usable button is found.
   */
  async discoverSendButton() {
    const selectors = this._getSendSelectors();

    for (const selector of selectors) {
      try {
        const elements = await this.page.$$(selector);

        for (let i = elements.length - 1; i >= 0; i--) {
          const element = elements[i];

          if (
            await element.isVisible() &&
            await element.isEnabled()
          ) {
            return element;
          }
        }
      } catch (_) {
        // Try the next selector.
      }
    }

    return null;
  }

  /**
   * Find the latest response element.
   * This is deliberately separate from text extraction so an adapter can
   * customize DOM discovery without changing the shared response lifecycle.
   */
  async discoverLatestResponse() {
    const selectors = this._getResponseSelectors();

    for (const selector of selectors) {
      try {
        const elements = await this.page.$$(selector);

        for (let i = elements.length - 1; i >= 0; i--) {
          const element = elements[i];

          if (await element.isVisible()) {
            const text = await element.innerText().catch(() => '');

            if (text && text.trim()) {
              return element;
            }
          }
        }
      } catch (_) {
        // Try the next selector.
      }
    }

    return null;
  }

  /**
   * Model-specific generation-state hook.
   * The default implementation checks the model's stop selectors.
   */
  async getGenerationState() {
    return this._isGenerating();
  }

  // ── Project context ─────────────────────────────────────────────────────

  setProjectContext(context) {
    this._projectContext = context || '';
  }

  // ── Readiness ───────────────────────────────────────────────────────────

  async isReady() {
    const input = await this.discoverComposer({ timeout: 5000 });
    return !!input;
  }

  // ── New conversation ────────────────────────────────────────────────────

  async newChat() {
    await this._clickElement(
      this._getNewChatSelectors(),
      { timeout: 10000 }
    );

    await this.page.waitForTimeout(2000);
    this._isFirstMessage = true;
    // A new conversation invalidates any transcript baseline.
    this._pendingTurn = null;
  }

  // ── Send message ────────────────────────────────────────────────────────

 /**
 * Delay (ms) between typing a prompt and pressing send.
 * Returns 0 for dedicated instances so local/self-hosted models are not
 * artificially slowed. Shared public UIs keep SEND_DELAY.
 */
 _sendDelayMs() {
 const dedicated = this.config.DEDICATED_INSTANCE === true ||
 this.constructor.DEDICATED_INSTANCE === true ||
 process.env.FORGE_DEDICATED_INSTANCE === '1';
 if (dedicated) return 0;
 return Number(this.config.SEND_DELAY ?? 600);
 }

  async sendMessage(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('sendMessage: message must be a non-empty string');
    }

    let fullText = text;

    // The canonical system prompt is already included by the caller.
    // Only prepend explicitly configured project context.
    if (this._isFirstMessage) {
      if (this._projectContext) {
        fullText = this._projectContext + '\n\n' + text;
      }

      this._isFirstMessage = false;
    }

    const input = await this.discoverComposer({ timeout: 10000 });

    if (!input) {
      const selectors = this._getInputSelectors();

      throw new Error(
        `Failed to send message to ${this.constructor.name}.\n` +
        `Tried ${selectors.length} input selectors — none found.\n` +
        `The model UI may have changed. Run: forge-agent --test-model\n` +
        `Or try: forge-agent --calibrate`
      );
    }

    // Capture the transcript BEFORE typing, so waitForResponse() can tell a
    // new reply from the previous one. Captured here rather than after the
    // click because the new bubble can appear within milliseconds.
    this._pendingTurn = await this._transcriptBaseline();
    this._lastSentText = fullText;

    await this._typeText(input, fullText);

 // Shared web UIs need a small pause between prompts so we do not look
 // like a flood and get throttled. Dedicated instances (local Ollama,
 // Colab tunnel, self-hosted) are ours alone: answer immediately.
 const delay = this._sendDelayMs();

    if (delay > 0) {
      await this.page.waitForTimeout(delay);
    }

    const sendButton = await this.discoverSendButton();

    if (sendButton) {
      try {
        await sendButton.click({ timeout: 5000 });
        return;
      } catch (err) {
        logger.warn(
          `Send button click failed for ${this.constructor.name}: ${err.message}`
        );
      }
    }

    // Keyboard fallback.
    await this.page.keyboard.press('Enter');
  }

  // ── Wait for response ───────────────────────────────────────────────────

  async waitForResponse(options = {}) {
    const { onChunk } = options;

    const configuredTimeout = this.config.RESPONSE_TIMEOUT;
    const timeoutMs = configuredTimeout === 0
      ? 24 * 60 * 60 * 1000
      : (configuredTimeout || 600_000);

    // Single-use: the baseline captured by sendMessage(). A waitForResponse()
    // with no preceding send falls back to idle detection alone, which keeps
    // the old behaviour for callers that drive the page themselves.
    const baseline = this._pendingTurn;
    this._pendingTurn = null;

    try {
      if (baseline) {
        await this._waitForNewBubble(baseline, {
          timeoutMs: this.config.APPEAR_TIMEOUT || 20_000,
        });
      }

      const text = await this._waitForTextStable({
        containerSelectors: this._getResponseSelectors(),
        timeoutMs,
        onChunk,
      });

      const cleaned = this._cleanText(text);

      if (!cleaned.trim()) {
        throw new Error('The model returned an empty response');
      }

      return cleaned;
    } catch (err) {
      // A turn-boundary failure is already specific and actionable; do not
      // bury it under the generic "no response after N seconds" wrapper.
      if (err && err.turnBoundary) throw err;

      const wrapped = new Error(
        `No response received from ${this.constructor.name} ` +
        `after ${Math.round(timeoutMs / 1000)} seconds.\n` +
        `The AI may still be processing.\n` +
        `Try:\n` +
        `  - Increasing timeout: forge-agent --timeout=600 "task"\n` +
        `  - Disabling timeout: forge-agent --no-timeout "task"\n` +
        `  - Testing the model: forge-agent --test-model\n` +
        `Original error: ${err.message}`
      );

      wrapped.cause = err;
      wrapped.retryable = err.retryable !== false;

      throw wrapped;
    }
  }

  // ── Selector diagnostics ────────────────────────────────────────────────

  async testSelectors() {
    const results = {
      model: this.constructor.name,
      url: this.getModelUrl(),
      input: false,
      send: false,
      response: false,
      newChat: false,
      errors: [],
    };

    try {
      results.input = !!await this.discoverComposer({ timeout: 5000 });

      if (!results.input) {
        results.errors.push(
          'Input not found: ' + this._getInputSelectors()[0]
        );
      }
    } catch (err) {
      results.errors.push('Input error: ' + err.message);
    }

    // The send control usually appears only once the composer has content —
    // ChatGPT, Gemini and Indus all do this. Checking it against an empty
    // composer reports "not found" for a button that exists, which is worse than
    // useless: it sends the operator hunting for a selector that is already
    // correct.
    try {
      let typed = false;
      if (results.input) {
        try {
          const composer = await this.discoverComposer({ timeout: 5000 });
          if (composer) {
            await composer.click({ timeout: 3000 }).catch(() => {});
            await this.page.keyboard.type('x', { delay: 0 });
            typed = true;
            await this.page.waitForTimeout(600);
          }
        } catch (_) {
          // Typing is a probe, not a requirement.
        }
      }

      results.send = !!await this.discoverSendButton();

      if (typed) {
        // Leave the composer as we found it.
        try {
          await this.page.keyboard.press('Control+A');
          await this.page.keyboard.press('Backspace');
          await this.page.waitForTimeout(200);
        } catch (_) { /* best effort */ }
      }

      if (!results.send) {
        results.errors.push(
          typed
            ? 'Send button not found (checked with text in the composer)'
            : 'Send button not found (composer was empty; could not type a probe)'
        );
      }
    } catch (err) {
      results.errors.push('Send error: ' + err.message);
    }

    try {
      results.response = !!await this.discoverLatestResponse();
    } catch (_) {
      results.response = false;
    }

    try {
      const newChat = await this._trySelectors(
        this._getNewChatSelectors(),
        { timeout: 2000 }
      );

      results.newChat = !!newChat;
    } catch (_) {
      results.newChat = false;
    }

    results.ready = results.input && results.send;

    return results;
  }

  // ── Upload capability ───────────────────────────────────────────────────

  _getUploadSelectors() {
    return [];
  }

  async detectUploadSelector() {
    const selectors = this._getUploadSelectors();

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);

        if (element) {
          return selector;
        }
      } catch (_) {
        // Continue probing.
      }
    }

    return null;
  }

  async supportsUpload() {
    return (await this.detectUploadSelector()) !== null;
  }

  async uploadFile(absPath, opts = {}) {
    void absPath;
    void opts;

    throw new Error(
      'uploadFile() not implemented for ' + this.constructor.name
    );
  }

  // ── Selector utilities ──────────────────────────────────────────────────

  async _trySelectors(selectors, options = {}) {
    if (!Array.isArray(selectors) || selectors.length === 0) {
      return null;
    }

    const {
      timeout = 5000,
      visible = true,
    } = options;

    const perSelectorTimeout = Math.max(
      250,
      Math.floor(timeout / selectors.length)
    );

    for (const selector of selectors) {
      try {
        const element = await this.page.waitForSelector(selector, {
          timeout: perSelectorTimeout,
          state: visible ? 'visible' : 'attached',
        });

        if (!element) continue;

        if (!visible || await element.isVisible()) {
          return element;
        }
      } catch (_) {
        // Continue with the next selector.
      }
    }

    return null;
  }

  
// ── Text input ──────────────────────────────────────────────────────────
	
  async _typeText(element, text) {
    if (!element) {
      throw new Error('_typeText: element is null');
    }

    if (typeof text !== 'string' || !text.length) {
      return;
    }

    try {
      await element.click({ timeout: 5000 });

      try {
        await element.fill(text, { timeout: 10000 });
      } catch (fillError) {
        // Fallback: type into the focused composer.
        await element.click({ force: true });
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.insertText(text);
      }

      await this.page.waitForTimeout(300);

      const actualText = await element.evaluate(el =>
        'value' in el ? el.value : el.innerText
      );

      if (!actualText || !actualText.trim()) {
        throw new Error('Composer remained empty after typing');
      }
    } catch (error) {
      throw new Error(
        `Failed to type into ${this.constructor.name}: ${error.message}`
      );
    }
  }

  // ── Click utility ───────────────────────────────────────────────────────

  async _clickElement(selectors, options = {}) {
    const {
      timeout = 10000,
      force = false,
    } = options;

    const element = await this._trySelectors(selectors, { timeout });

    if (!element) {
      return null;
    }

    try {
      await element.click({
        force,
        timeout: 3000,
      });

      return element;
    } catch (_) {
      try {
        await element.evaluate(el => el.click());
        return element;
      } catch (_) {
        return null;
      }
    }
  }

  // ── Turn boundary ───────────────────────────────────────────────────────
  //
  // Deciding when a reply has finished is the single most important guess in
  // the loop. It used to be "the text stopped changing for STABLE_DELAY", which
  // has two failure modes: it costs 1.5-3 s on every turn, and if the new
  // bubble has not rendered yet it happily returns the PREVIOUS reply.
  //
  // The boundary is now measured in three steps:
  //   1. baseline  — sendMessage() records how many replies exist and a hash
  //                  of the last one, before typing.
  //   2. appear    — waitForResponse() waits for that transcript to change,
  //                  so a stale reply can never be mistaken for a new one.
  //   3. complete  — the END marker wins if present; otherwise idle text plus
  //                  a stopped generator; otherwise the timeout.

  /**
   * Snapshot the assistant transcript before a send.
   *
   * @returns {Promise<{selector: string|null, count: number, lastHash: string}>}
   */
  async _transcriptBaseline() {
    const selector = await this._resolveResponseSelector();

    if (!selector) {
      return { selector: null, count: 0, lastHash: '' };
    }

    const nodes = await this.page.$$(selector).catch(() => []);
    const last  = nodes.length ? await nodes[nodes.length - 1].innerText().catch(() => '') : '';

    return {
      selector,
      count: nodes.length,
      lastHash: this._hashText(last),
    };
  }

  /**
   * First response selector that currently matches at least one node.
   * Adapters list selectors most-specific-first, so this is the transcript
   * container the scraper would actually read.
   */
  async _resolveResponseSelector() {
    for (const selector of this._getResponseSelectors()) {
      try {
        const nodes = await this.page.$$(selector);
        if (nodes.length > 0) return selector;
      } catch (_) {
        // Try the next selector.
      }
    }
    return null;
  }

  /** Cheap non-cryptographic hash — used only to detect change, never for security. */
  _hashText(text) {
    const s = String(text || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  /**
   * Wait until the transcript differs from the baseline — a new bubble, or the
   * last one changed. Throws a retryable, turnBoundary-marked error on timeout
   * instead of silently returning stale text.
   */
  async _waitForNewBubble(baseline, options = {}) {
    const timeoutMs = options.timeoutMs || this.config.APPEAR_TIMEOUT || 20_000;
    const pollMs    = this.config.GENERATION_POLL || 400;
    const start     = Date.now();

    while (Date.now() - start < timeoutMs) {
      const selector = baseline.selector || await this._resolveResponseSelector();

      if (selector) {
        const nodes = await this.page.$$(selector).catch(() => []);

        if (nodes.length > baseline.count) return true;

        if (nodes.length > 0 && nodes.length === baseline.count) {
          const last = await nodes[nodes.length - 1].innerText().catch(() => '');
          if (last && this._hashText(last) !== baseline.lastHash) return true;
        }
      }

      await this.page.waitForTimeout(pollMs);
    }

    const err = new Error(
      `${this.constructor.name}: no new reply appeared within ` +
      `${Math.round(timeoutMs / 1000)}s of sending. The previous reply was ` +
      `NOT used (that is the stale-response guard). The UI may have failed to ` +
      `submit the message, or the response container selector may have drifted.\n` +
      `  - Check the browser window; re-run with --debug to keep the raw log\n` +
      `  - Run: forge-agent --test-model\n`
    );
    err.retryable   = true;
    err.turnBoundary = 'appear';
    throw err;
  }

  // ── Response text stability ─────────────────────────────────────────────

  async _waitForTextStable(options = {}) {
    const {
      containerSelectors,
      stableMs = this.config.STABLE_DELAY || 1500,
      timeoutMs = this.config.RESPONSE_TIMEOUT || 600_000,
      pollMs = this.config.GENERATION_POLL || 400,
      onChunk,
    } = options;

    const start = Date.now();

    let lastText = '';
    let stableStart = null;
    let lastChunkLen = 0;

    while (Date.now() - start < timeoutMs) {
      const text = await this._extractText(containerSelectors);

      // Guard against reading our own prompt back. Some UIs render the user
      // bubble in a container that also matches a response selector; if that
      // bubble is the newest node, a naive stability check would return it.
      if (this._lastSentText && text.trim() === this._lastSentText.trim()) {
        await this.page.waitForTimeout(pollMs);
        continue;
      }

      // Deterministic completion: the model wrote its END marker. One settle
      // poll lets any trailing characters land before we take the text.
      if (this._hasEndMarker(text)) {
        await this.page.waitForTimeout(pollMs);
        const settled = await this._extractText(containerSelectors);
        this._lastCompletionSignal = 'marker';
        return settled || text;
      }

      if (text !== lastText) {
        lastText = text;
        stableStart = Date.now();
      } else if (
        stableStart !== null &&
        Date.now() - stableStart >= stableMs &&
        text.trim().length > 0
      ) {
        const generating = await this.getGenerationState();

        if (!generating) {
          this._lastCompletionSignal = 'idle';
          return text;
        }

        // Text may pause temporarily during reasoning or token streaming.
        stableStart = Date.now();
      }

      // Display-only callback. It never triggers execution or completion.
      if (
        typeof onChunk === 'function' &&
        text.length > lastChunkLen
      ) {
        try {
          onChunk({
            text,
            delta: text.length - lastChunkLen,
            elapsedMs: Date.now() - start,
          });
        } catch (_) {
          // UI callback errors must not interrupt response collection.
        }

        lastChunkLen = text.length;
      }

      await this.page.waitForTimeout(pollMs);
    }

    const error = new Error(
      `Response timeout after ${timeoutMs}ms`
    );

    error.retryable = true;

    throw error;
  }

  // ── Response extraction ─────────────────────────────────────────────────

  async _extractText(selectors) {
    const element = await this.discoverLatestResponse();

    if (element) {
      try {
        const text = await element.innerText();

        if (text && text.trim().length > 0) {
          return text.trim();
        }
      } catch (_) {
        // Fall through to selector-based extraction.
      }
    }

    // Compatibility fallback for adapters with unusual response containers.
    for (const selector of selectors || []) {
      try {
        const elements = await this.page.$$(selector);

        for (let i = elements.length - 1; i >= 0; i--) {
          const text = await elements[i].innerText().catch(() => '');

          if (text && text.trim().length > 5) {
            return text.trim();
          }
        }
      } catch (_) {
        // Continue to next selector.
      }
    }

    return '';
  }

  // ── Generation detection ────────────────────────────────────────────────

  async _isGenerating() {
    const selectors = this._getStopSelectors();

    for (const selector of selectors) {
      try {
        const elements = await this.page.$$(selector);

        for (const element of elements) {
          if (await element.isVisible()) {
            return true;
          }
        }
      } catch (_) {
        // Continue checking.
      }
    }

    return false;
  }

  /**
 * True when the reply contains a START marker followed by an END marker.
 * Requiring END AFTER START stops the model from completing early merely by
 * mentioning the END marker in prose.
 */
 _hasEndMarker(text) {
 if (typeof text !== 'string') return false;
 const startIdx = text.lastIndexOf(RESPONSE_START);
 const endIdx = text.lastIndexOf(RESPONSE_END);
 return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx;
 }

 // ── Response cleanup ────────────────────────────────────────────────────
  _cleanText(text) {
    if (!text) return '';

    let trimmedText = text.trim();

 // Strip the response envelope markers the system prompt asks the model to
 // emit. Without this they leak into parsed tool calls and final answers.
 trimmedText = trimmedText.split(RESPONSE_START).join('');
 trimmedText = trimmedText.split(RESPONSE_END).join('');
 trimmedText = trimmedText.trim();

    // 🔓 BASE64 TRANSPORT DECODING INTERCEPTOR
    // If the LLM wrapped the tool call chunk in a safe base64 packet to bypass browser corruption
    if (trimmedText.startsWith('base64:')) {
      try {
        const base64Content = trimmedText.replace(/^base64:\s*/i, '').trim();
        trimmedText = Buffer.from(base64Content, 'base64').toString('utf8').trim();
      } catch (err) {
        logger.error(`[BaseAdapter] Failed to decode transport-layer Base64 string: ${err.message}`);
      }
    }

    // 🛡️ JSON & MARKDOWN STRUCTURAL BYPASS
    // If the text is raw JSON payload structural data, bypass all destructive 
    // interface cleaning regex variables to preserve it intact.
    if (trimmedText.startsWith('{') && trimmedText.endsWith('}')) {
      return trimmedText;
    }
    if (trimmedText.startsWith('```json') && trimmedText.endsWith('```')) {
      return trimmedText;
    }

    // Normal text cleaning fallback for conversational UI elements
    return trimmedText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^Thinking\.{0,3}\s*[\s\S]*?\n\n/m, '')
      .replace(/^(Assistant|AI|Claude|GPT|Gemini|DeepSeek):\s*/i, '')
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\w*.*$/gm, '')
      // Action chrome that renders as its own line: Copy / Download /
      // Regenerate / Share. Previously only "Copy code" was handled, so a
      // toolbar could survive into the model's next turn (and into the parser).
      .replace(/^[ \t]*(?:Copy|Copy code|Download|Regenerate|Share|Edit|Retry|Read aloud)[ \t]*$/gmi, '')
      .replace(/Copy code[\s\S]{0,50}$/gm, '')
      .replace(/\d+ \/ \d+[\s\n]*$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

module.exports = BaseAdapter;