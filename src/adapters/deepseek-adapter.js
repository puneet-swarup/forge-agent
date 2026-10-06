// src/adapters/deepseek-adapter.js — DeepSeek model adapter
'use strict';

const BaseAdapter = require('./base-adapter');
const logger      = require('../logger');
const { Errors }  = require('../errors');
const { withSendRetry, withResponseRetry } = require('../retry');
const { ThinkingTracker, formatThinkingForLog } = require('../thinking');

/**
 * Adapter for chat.deepseek.com
 */
class DeepSeekAdapter extends BaseAdapter {
  constructor(page, config) {
    super(page, config);
    this._ensureThinkingTracker();
    this.selectors = {
      chatInput: [
        '#chat-input',
        'textarea[placeholder]',
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
      ],
      sendButton: [
        'button[aria-label*="Send" i]',
        'button[aria-label*="send" i]',
        '[data-testid="send-button"]',
        'button[type="submit"]',
        '[class*="send-btn"]',
        '[class*="sendBtn"]',
        '[class*="send-button"]',
      ],
      stopButton: [
        'button[aria-label*="Stop" i]',
        '[aria-label*="stop generating" i]',
        '[data-testid="stop-button"]',
        '[class*="stop-btn"]',
        '[class*="stopBtn"]',
      ],
      newChat: [
        'button[aria-label*="New chat" i]',
        'button[aria-label*="New conversation" i]',
        'a[href="/"][aria-label]',
        '[data-testid="new-chat"]',
        '[class*="new-chat"]',
        '[class*="newChat"]',
      ],
      messageContainer: [
        '[class*="chat-content"]',
        '[class*="message-list"]',
        '[class*="conversation"]',
        'main',
      ],
    };
  }

  // ── ThinkingTracker safety ─────────────────────────────────────────────────

  _ensureThinkingTracker() {
    if (this.thinkingTracker && typeof this.thinkingTracker.reset === 'function') return;
    try {
      const { ThinkingTracker } = require('../thinking');
      this.thinkingTracker = new ThinkingTracker();
    } catch {
      this.thinkingTracker = {
        reset: () => {},
        update: () => {},
        get isThinking()     { return false; },
        get hasThinking()    { return false; },
        get thinkingContent(){ return ''; },
        get responseContent(){ return ''; },
      };
    }
  }

  // ── Core methods ───────────────────────────────────────────────────────────

  async sendMessage(text) {
    await withSendRetry(async () => {
      const { el, isTextarea } = await this._findInput();

      await el.click({ force: true });

      if (isTextarea) {
        await el.fill(text);
      } else {
        await this.page.evaluate((element, content) => {
          element.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete',    false, null);
          document.execCommand('insertText', false, content);
          element.dispatchEvent(new InputEvent('input', { bubbles: true, data: content }));
        }, el, text);
      }

      // Event-driven send: try the send button immediately (one fast pass),
      // else press Enter. No fixed delay, no long poll of the button.
      let clicked = false;
      try { clicked = await this._clickSendButton(); } catch (_) { clicked = false; }
      if (!clicked) {
        await this.page.keyboard.press('Enter');
      }

      // NOTE: we deliberately do NOT wait for the assistant node here. Doing so
      // would consume the "new message" event that waitForResponse relies on for
      // its appearance phase (a later count check would never see an increase).
      // The send button click / Enter above is enough to submit; waitForResponse
      // owns the appearance detection. A tiny yield lets the submit settle.
      await this.page.waitForTimeout(50);
    }, 'send message to DeepSeek');
  }

  async waitForResponse() {
    return withResponseRetry(async () => {
      const timeout     = this.config.RESPONSE_TIMEOUT === 0
        ? 24 * 60 * 60 * 1000
        : this.config.RESPONSE_TIMEOUT;
      const stableDelay = this.config.STABLE_DELAY;
      const start       = Date.now();

      this._ensureThinkingTracker();
      if (typeof this.thinkingTracker.reset === 'function') {
        this.thinkingTracker.reset();
      }

      // ── Phase 1: wait for a new message to appear ────────────────────────
      // Install the quiet watcher first so it observes the whole generation.
      const watcherOk = await this._installQuietWatcher();
      const appearDeadline = this.config.APPEAR_TIMEOUT || 120_000;
      // Wait until some assistant text is present (non-empty). This is more
      // robust than a count delta, because the reply node may already exist by
      // the time we get here (fast send + fast first token).
      const appeared = await this._waitForAnyAssistantText(appearDeadline);

      if (!appeared) logger.warn('Response may have been delayed - continuing to wait...');

      // ── Phase 2: wait for text to stabilise ──────────────────────────────
      let lastText = '';
      if (watcherOk) {
        // Fast path: MutationObserver tells us when the DOM goes quiet.
        let lastIndicatorUpdate = 0;
        while (Date.now() - start < timeout) {
          const text = await this._extractLastMessage();
          if (typeof this.thinkingTracker.update === 'function') {
            this.thinkingTracker.update(text);
          }
          lastText = text;

          const quiet = await this._waitForDomQuiet(stableDelay, 250);

          const now = Date.now();
          if (now - lastIndicatorUpdate > 1_000) {
            const elapsedMs = now - start;
            logger.thinking(elapsedMs, text.length);
            if (Math.round(elapsedMs / 1000) === 30) {
              logger.clearThinking();
              logger.dim('  Response is taking a while - this is normal for complex tasks or slow connections.');
            }
            lastIndicatorUpdate = now;
          }

          if (quiet && text.length > 0 && !await this._isGenerating()) break;
        }
      } else {
        // Fallback: text-stability loop (previous behaviour).
        let stableStart = null;
        let lastIndicatorUpdate = 0;
        while (Date.now() - start < timeout) {
          const text = await this._extractLastMessage();
          if (typeof this.thinkingTracker.update === 'function') {
            this.thinkingTracker.update(text);
          }
          if (text !== lastText) {
            lastText    = text;
            stableStart = null;
          } else if (text.length > 0) {
            if (!stableStart) stableStart = Date.now();
            else if (Date.now() - stableStart >= stableDelay) {
              if (!await this._isGenerating()) break;
              stableStart = null;
            }
          }
          const now = Date.now();
          if (now - lastIndicatorUpdate > 1_000) {
            const elapsedMs = now - start;
            logger.thinking(elapsedMs, text.length);
            lastIndicatorUpdate = now;
          }
          await this.page.waitForTimeout(this.config.GENERATION_POLL || 800);
        }
      }

      logger.clearThinking();

      const hasThinking = this.thinkingTracker.hasThinking || false;
      if (hasThinking) {
        const thinkingContent = this.thinkingTracker.thinkingContent;
        if (this.config.DEBUG && thinkingContent) {
          logger.dim(formatThinkingForLog(thinkingContent));
        }
      }

      const final   = await this._extractLastMessage();
      const cleaned = this._cleanText(final);

      if (!cleaned || cleaned.trim().length === 0) {
        const err = new Error('Empty response from DeepSeek');
        err.retryable = true;
        throw err;
      }

      return cleaned;
    }, 'wait for DeepSeek response');
  }

  async newChat() {
    // Navigate directly to root URL — most reliable way to get a fresh chat.
    // Trying to click the "New Chat" button is fragile because DeepSeek
    // frequently changes its DOM selectors.
    try {
      await this.page.goto(
        this.config.DEEPSEEK_URL || 'https://chat.deepseek.com',
        { waitUntil: 'domcontentloaded', timeout: this.config.BROWSER_TIMEOUT || 90_000 }
      );
      await this.page.waitForTimeout(2_000);
      logger.dim('Navigated to DeepSeek home (new chat)');
    } catch (err) {
      // Fallback: try sidebar button
      logger.warn(`Navigation failed: ${err.message} — trying sidebar button`);
      for (const sel of this.selectors.newChat) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            await this.page.waitForTimeout(1_000);
            logger.dim('Started new chat session via button');
            return;
          }
        } catch {}
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _getInputSelectors() { return this.selectors.chatInput; }
  _getSendSelectors() { return this.selectors.sendButton; }
  _getStopSelectors() { return this.selectors.stopButton; }
  _getNewChatSelectors() { return this.selectors.newChat; }
  _getResponseSelectors() { return this.selectors.messageContainer; }
  getModelUrl() { return this.config.DEEPSEEK_URL || 'https://chat.deepseek.com'; }

  async _findInput() {
    for (const sel of this.selectors.chatInput) {
      try {
        const el = await this.page.waitForSelector(sel, {
          timeout: this.config.HEALTH_CHECK_TIMEOUT || 45_000,
          state: 'visible',
        });
        if (!el) continue;
        const tagName           = await el.evaluate(e => e.tagName.toLowerCase());
        const isContentEditable = await el.evaluate(e => e.isContentEditable);
        return { el, isTextarea: tagName === 'textarea' && !isContentEditable };
      } catch {}
    }
    throw Errors.inputNotFound ? Errors.inputNotFound() : new Error('Chat input not found');
  }

  async _clickSendButton() {
    for (const sel of this.selectors.sendButton) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible() && await el.isEnabled()) {
          await el.click();
          return true;
        }
      } catch {}
    }
    return false;
  }

  async _getMessageCount() {
    return await this.page.evaluate(() => {
      const candidates = [
        '[class*="assistant"][class*="message"]',
        '[data-role="assistant"]',
        '[class*="markdown-content"]',
        '.ds-markdown',
        '[class*="chat-message"]',
        '[class*="message-bubble"]',
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return document.querySelectorAll('[class*="message"]').length;
    });
  }

  /**
   * Install a MutationObserver that records the timestamp of the last DOM
   * change anywhere in the document, so waitForResponse can resolve the instant
   * the page goes quiet instead of polling on a fixed interval.
   * Idempotent; returns true if installed.
   */
  async _installQuietWatcher() {
    try {
      await this.page.evaluate(() => {
        if (window.__forgeQuiet) return true;
        const state = { last: Date.now(), count: 0 };
        window.__forgeQuiet = state;
        const obs = new MutationObserver(() => {
          state.last = Date.now();
          state.count++;
        });
        obs.observe(document.body || document.documentElement, {
          childList: true, subtree: true, characterData: true,
        });
        window.__forgeQuietObs = obs;
        return true;
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Wait until the DOM has been quiet (no mutations) for quietMs, or maxMs
   * elapses. Uses a fast 50ms waitForFunction poll rather than the old 800ms
   * loop. Returns true if it went quiet, false on timeout.
   */
  async _waitForDomQuiet(quietMs, maxMs) {
    try {
      await this.page.waitForFunction(
        (args) => {
          const s = window.__forgeQuiet;
          if (!s) return true;
          return (Date.now() - s.last) >= args.quietMs;
        },
        { quietMs },
        { timeout: maxMs, polling: 50 },
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Wait until the assistant message count exceeds 'before', or timeout.
   * Returns the new count.
   */
  async _waitForMessageCountIncrease(before, maxMs) {
    try {
      await this.page.waitForFunction(
        (min) => {
          const candidates = [
            '[class*="assistant"][class*="message"]',
            '[data-role="assistant"]',
            '[class*="markdown-content"]',
            '.ds-markdown',
            '[class*="chat-message"]',
            '[class*="message-bubble"]',
          ];
          let n = 0;
          for (const sel of candidates) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) { n = els.length; break; }
          }
          if (n === 0) n = document.querySelectorAll('[class*="message"]').length;
          return n > min;
        },
        before,
        { timeout: maxMs, polling: 50 },
      );
    } catch (_) { /* timeout */ }
    return await this._getMessageCount();
  }

  /**
   * Wait until any assistant message has non-empty text, or timeout.
   * Returns true if text appeared.
   */
  async _waitForAnyAssistantText(maxMs) {
    try {
      await this.page.waitForFunction(
        () => {
          const candidates = [
            '[class*="assistant"][class*="message"]',
            '[data-role="assistant"]',
            '[class*="markdown-content"]',
            '.ds-markdown',
            '[class*="chat-message"]',
            '[class*="message-bubble"]',
          ];
          let nodes = [];
          for (const sel of candidates) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) { nodes = els; break; }
          }
          if (nodes.length === 0) {
            nodes = document.querySelectorAll('[class*="message"]');
          }
          for (const n of nodes) {
            if ((n.textContent || '').trim().length > 0) return true;
          }
          return false;
        },
        null,
        { timeout: maxMs, polling: 50 },
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Extract the last AI message from the page.
   *
   * CRITICAL: getFullText() reconstructs fenced code blocks from DOM elements.
   * When DeepSeek renders a tool_call response it creates:
   *   <pre><code class="language-tool_call">{"name": ...}</code></pre>
   * getFullText() converts this back to:
   *   ```tool_call\n{"name": ...}\n```
   * which is exactly what the parser's Strategy 1 expects.
   * Without this reconstruction the parser never sees the tool call.
   */
  async _extractLastMessage() {
    return await this.page.evaluate(() => {
      function getFullText(el) {
        if (!el) return '';
        let result = '';

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toLowerCase();

          if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            if (codeEl) {
              const cls  = codeEl.className || '';
              const lang = (cls.match(/language-(\S+)/) || [])[1] || '';
              const body = codeEl.textContent || '';
              result += '\n```' + lang + '\n' + body + '\n```\n';
            } else {
              result += '\n```\n' + node.textContent + '\n```\n';
            }
            return;
          }

          if (tag === 'code') {
            const parentTag = node.parentElement && node.parentElement.tagName
              ? node.parentElement.tagName.toLowerCase() : '';
            if (parentTag !== 'pre') {
              result += '`' + node.textContent + '`';
            }
            return;
          }

          for (const child of node.childNodes) walk(child);

          if (['p','div','li','br','h1','h2','h3','h4','h5','h6'].includes(tag)) {
            result += '\n';
          }
        }

        walk(el);
        return result.trim();
      }

      const directSelectors = [
        '.ds-markdown',
        '[class*="assistant"] [class*="markdown"]',
        '[class*="assistant"] [class*="content"]',
        '[data-role="assistant"] [class*="content"]',
        '[class*="ai-message"] [class*="content"]',
        '[class*="bot-message"] [class*="content"]',
        '[class*="response-content"]',
        '[class*="message-content"]:last-child',
      ];

      for (const sel of directSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const t = getFullText(els[els.length - 1]);
          if (t.length > 10) return t;
        }
      }

      const markdownEls = document.querySelectorAll(
        '[class*="markdown"], [class*="prose"], [class*="rendered"]'
      );
      if (markdownEls.length > 0) {
        const t = getFullText(markdownEls[markdownEls.length - 1]);
        if (t.length > 10) return t;
      }

      const allBlocks = Array.from(
        document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="turn"]')
      );
      const candidates = allBlocks.filter(el => {
        const cls = el.className || '';
        return (
          !cls.toLowerCase().includes('input') &&
          !cls.toLowerCase().includes('user') &&
          !el.querySelector('textarea, input[type="text"]') &&
          (el.innerText || '').length > 20
        );
      });

      if (candidates.length > 0) {
        return getFullText(candidates[candidates.length - 1]);
      }

      return '';
    });
  }

  _cleanText(text) {
    if (!text) return '';
    // Strip <think> blocks always — unconditional
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  async _isGenerating() {
    return await this.page.evaluate(() => {
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        '[class*="stop-gen"]',
        '[class*="stopGen"]',
        '[class*="generating"]',
      ];
      for (const sel of stopSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
        }
      }

      const loaderSelectors = [
        '[class*="typing"]',
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="blink"]',
        '[class*="cursor"]',
        '[class*="pulsing"]',
        'svg[class*="loading"]',
        'svg[class*="spinner"]',
      ];
      for (const sel of loaderSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden') return true;
        }
      }

      return false;
    });
  }
}

module.exports = DeepSeekAdapter;