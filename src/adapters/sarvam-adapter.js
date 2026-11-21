'use strict';

const fs = require('fs');
const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class SarvamAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  // ── DOM target selectors ────────────────────────────────────────────────

_getInputSelectors() {
  return [
    '.tiptap.ProseMirror',
    'div[contenteditable="true"].tiptap',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    '.indus-prompt-input', // wrapper — only a last resort
  ];
}

  _getSendSelectors() {
    return [
      // The debug output shows an .indus-send-slot container
      '.indus-send-slot button:not([disabled])',
      '.indus-send-slot [role="button"]:not([aria-disabled="true"])',
      'button[aria-label*="Send" i]:not([disabled])',
      'button[type="submit"]:not([disabled])',
      'button:has(svg[class*="send"])',
    ];
  }

  _getStopSelectors() {
    return [
      'button[aria-label*="Stop" i]',
      'div[role="button"][aria-label*="Stop" i]',
      'button[data-testid="stop-button"]',
      'button:has(svg[class*="stop"])',
      // TipTap sometimes uses a typing indicator
      '[class*="typing"]',
      '[class*="spinner"]',
    ];
  }

  _getNewChatSelectors() {
    return [
      'button[aria-label*="New chat" i]',
      'a[href="/indus"]',
      'button:has-text("New chat")',
      'button[data-testid="new-chat-button"]',
    ];
  }

  _getResponseSelectors() {
    return [
      // Markdown/prose containers are the most reliable signal
      '.markdown',
      '[class*="markdown"]',
      '[class*="prose"]',
      '[data-message-author="assistant"]',
      '[data-role="assistant"]',
      'div[class*="assistant"] div[class*="content"]',
      'div[class*="message-content"]',
      // Broad fallbacks for generic chat bubbles
      'div[class="assistant"] span[class="reply"]',
      'div[class*="assistant"]',
    ];
  }

  getModelUrl() {
    return this.config.SARVAM_URL || 'https://indus.sarvam.ai/indus';
  }

  // ── Custom discovery (mirrors the other adapters) ──────────────────────

  async discoverComposer() {
    for (const selector of this._getInputSelectors()) {
      try {
        const locator = this.page.locator(selector).last();

        if (
          await locator.count() &&
          await locator.isVisible() &&
          await locator.isEnabled()
        ) {
          return locator;
        }
      } catch (_) {
        // Try next selector.
      }
    }
    return null;
  }

  async discoverSendButton() {
    for (const selector of this._getSendSelectors()) {
      try {
        const locator = this.page.locator(selector).last();

        if (
          await locator.count() &&
          await locator.isVisible() &&
          await locator.isEnabled()
        ) {
          return locator;
        }
      } catch (_) {
        // Try next selector.
      }
    }
    return null;
  }

  async discoverLatestResponse() {
    for (const selector of this._getResponseSelectors()) {
      try {
        const locator = this.page.locator(selector).last();

        if (
          !(await locator.count()) ||
          !(await locator.isVisible())
        ) {
          continue;
        }

        const text = await locator.innerText().catch(() => '');

        if (text && text.trim()) {
          return locator;
        }
      } catch (_) {
        // Try next selector.
      }
    }
    return null;
  }

  // ── Generation detection ────────────────────────────────────────────────

  async getGenerationState() {
    return await this.page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          el.getClientRects().length > 0
        );
      };

      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Stop" i]',
        'button[data-testid="stop-button"]',
        'div[class*="stop-gen"]',
        'div[class*="generating"]',
      ];

      for (const selector of stopSelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (isVisible(el)) return { ok: true, method: 'setInputFiles' };
        }
      }

      const loaderSelectors = [
        '[class*="typing"]',
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="blink"]',
        '[class*="pulsing"]',
      ];

      for (const selector of loaderSelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (isVisible(el)) return { ok: true, method: 'setInputFiles' };
        }
      }

      return false;
    });
  }

  // ── 🔑 CRITICAL OVERRIDE: TipTap-safe text insertion ───────────────────

  /**
   * TipTap/ProseMirror ignores `fill()` and synthetic `input` events.
   * We must click the editor, clear it via keyboard shortcuts, then
   * insert text using `document.execCommand('insertText')`, which
   * ProseMirror listens for and processes as a real transaction.
   */
async _typeText(element, text) {
  if (!element) throw new Error('_typeText: element is null');
  if (typeof text !== 'string' || !text.length) return;

  // Resolve to the ACTUAL editable node (unwrap wrappers like .indus-prompt-input).
  const editor = await element.evaluateHandle((el) => {
    if (el.isContentEditable) return el;
    return el.querySelector('[contenteditable="true"]') || el;
  });

  const isEditable = await editor.evaluate((el) => el.isContentEditable === true);
  if (!isEditable) {
    throw new Error(
      'Resolved target is not contenteditable — refusing to type (would select page chrome)'
    );
  }

  // Focus the EDITOR, place caret at its end.
  await editor.evaluate((el) => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);   // ← now scoped to editor only
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await this.page.waitForTimeout(150);

  const focused = await editor.evaluate((el) => {
    const a = document.activeElement;
    return !!a && (a === el || el.contains(a));
  });
  if (!focused) throw new Error('TipTap editor could not be focused');

  // Clear — DOM range scoped to editor (never touches disclaimer).
  await editor.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await this.page.keyboard.press('Backspace');
  await this.page.waitForTimeout(100);

  // Insert the FULL prompt in one CDP call — newlines do NOT fire keydown,
  // so Enter-to-send is never triggered.
  await this.page.keyboard.insertText(text);
  await this.page.waitForTimeout(300);

  // Verify.
  const len = await editor.evaluate((el) => (el.innerText || '').length);
  if (len < Math.min(text.length, 5)) {
    logger.warn('[Sarvam] insertText produced no text — falling back to Shift+Enter');
    await editor.evaluate((el) => el.focus());
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.page.keyboard.insertText(lines[i]);
      if (i < lines.length - 1) await this.page.keyboard.press('Shift+Enter');
    }
  }
}

  // ── New chat ───────────────────────────────────────────────────────────

async newChat() {
  this._isFirstMessage = true;

  const targetUrl = this.getModelUrl();
  const composerSelector = '.indus-prompt-input, .tiptap.ProseMirror, div[contenteditable="true"]';

  // 1. If we're already on the right page with a live composer, do nothing.
  //    This is what the health check leaves us in, so re-navigation is a no-op.
  try {
    const currentUrl = this.page.url() || '';
    const sameOrigin = currentUrl.startsWith(
      new URL(targetUrl).origin
    );

    if (sameOrigin && await this.discoverComposer()) {
      logger.debug('[Sarvam] Already on chat page — skipping navigation');
      return { ok: true, method: 'no-op' };
    }
  } catch (_) {
    // Fall through to full navigation.
  }

  // 2. Full navigation, but wait on the TipTap editor rather than a timer.
  try {
    await this.page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.NAVIGATION_TIMEOUT || 60000,
    });

    // Wait for the ProseMirror editor to actually mount (hydration).
    await this.page.waitForSelector(composerSelector, {
      state: 'visible',
      timeout: this.config.NAVIGATION_TIMEOUT || 60000,
    });

    if (await this.discoverComposer()) {
      logger.debug('[Sarvam] New chat page ready');
      return { ok: true, method: 'goto' };
    }
  } catch (error) {
    // Playwright SPA aborts often surface here with an empty .message.
    // Always log stack/message/string so we never get a blank warning.
    logger.warn(
      '[Sarvam] Navigation fallback:',
      error.stack || error.message || String(error)
    );
  }

  // 3. Button-based fallback (only reached if goto failed).
  for (const selector of this._getNewChatSelectors()) {
    try {
      const button = this.page.locator(selector).first();

      if (await button.count() && await button.isVisible()) {
        await button.click({ timeout: 3000 });
        await this.page.waitForSelector(composerSelector, {
          state: 'visible',
          timeout: 10000,
        }).catch(() => {});
        return { ok: true, method: 'new-chat-button' };
      }
    } catch (_) {
      // Try next selector.
    }
  }

  return false;
}

  // ── Upload capability ──────────────────────────────────────────────────

  _getUploadSelectors() {
    return [
      'input[type="file"]',
      'input[type="file"][accept]',
      'input[type="file"][multiple]',
    ];
  }

  async uploadFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    for (const selector of this._getUploadSelectors()) {
      try {
        const input = this.page.locator(selector).first();
        if (await input.count()) {
          await input.setInputFiles(filePath);
          logger.info('[Sarvam] File uploaded:', filePath);
          return { ok: true, method: 'setInputFiles' };
        }
      } catch (_) {
        // Try file chooser fallback.
      }
    }

    try {
      const chooserPromise = this.page.waitForEvent('filechooser', {
        timeout: 5000,
      });

      const uploadButtons = [
        'button[aria-label*="Upload" i]',
        'button[aria-label*="Attach" i]',
        'button[class*="upload"]',
      ];

      let clicked = false;
      for (const selector of uploadButtons) {
        const button = this.page.locator(selector).first();
        if (await button.count() && await button.isVisible()) {
          await button.click();
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        throw new Error('Sarvam upload button not found');
      }

      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);
      logger.info('[Sarvam] File uploaded using file chooser');
      return { ok: true, method: 'filechooser' };
    } catch (error) {
      logger.error('[Sarvam] File upload failed:', error.message);
      throw error;
    }
  }
}

module.exports = SarvamAdapter;