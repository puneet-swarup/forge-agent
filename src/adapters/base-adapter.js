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
  }

  // ── Send message ────────────────────────────────────────────────────────

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

    await this._typeText(input, fullText);

    const delay = Number(this.config.SEND_DELAY ?? 600);

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

    try {
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

    try {
      results.send = !!await this.discoverSendButton();

      if (!results.send) {
        results.errors.push('Send button not found');
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
      .replace(/Copy code[\s\S]{0,50}$/gm, '')
      .replace(/\d+ \/ \d+[\s\n]*$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

module.exports = BaseAdapter;