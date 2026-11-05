'use strict';

const fs = require('fs');
const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class DeepSeekAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  // ── DOM target selectors ────────────────────────────────────────────────

  _getInputSelectors() {
    return [
      'textarea#chat-input',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Send" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"]',
      'textarea',
    ];
  }

  _getSendSelectors() {
    return [
      'div[role="button"][aria-label*="Send" i]:not([aria-disabled="true"])',
      'button[aria-label*="Send" i]:not([disabled])',
      'div[class*="send-btn"]',
      'div[class*="sendBtn"]',
      'button[type="submit"]:not([disabled])',
      // DeepSeek hashes CSS classes per build; this is a rotating hint only.
      'div[class*="_7436101"]',
    ];
  }

  _getStopSelectors() {
    return [
      'div[role="button"][aria-label*="Stop" i]',
      'button[aria-label*="Stop" i]',
      'div[class*="stop-gen"]',
      'div[class*="stopGen"]',
      'button:has(svg[class*="stop"])',
    ];
  }

  _getNewChatSelectors() {
    return [
      'div[role="button"][aria-label*="New chat" i]',
      'button[aria-label*="New chat" i]',
      'a[href="/"]',
      'div[class*="new-chat"]',
      'div[class*="newChat"]',
      'button:has-text("New chat")',
    ];
  }

  _getResponseSelectors() {
    return [
      '.ds-markdown',
      '[class*="markdown"]',
      'div[class*="message"] div[class*="content"]',
      'div[class*="assistant"] div[class*="markdown"]',
      'div[class*="message-content"]',
      '[data-message-author="assistant"]',
 // Mock-server / generic chat DOMs: assistant bubble wrapping plain text.
 // Listed last so real DeepSeek selectors always win.
 'div[class="assistant"] span[class="reply"]',
 'div[class*="assistant"]',
 'div[data-role="assistant"]',
    ];
  }

  getModelUrl() {
    return this.config.DEEPSEEK_URL || 'https://chat.deepseek.com';
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

        if (!(await locator.count()) || !(await locator.isVisible())) {
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

  async _isGenerating() {
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
        'div[role="button"][aria-label*="Stop" i]',
        'button[aria-label*="Stop" i]',
        'div[class*="stop-gen"]',
        'div[class*="stopGen"]',
        'div[class*="generating"]',
      ];

      for (const selector of stopSelectors) {
        const elements = document.querySelectorAll(selector);

        for (const el of elements) {
          if (isVisible(el)) return { ok: true, method: 'setInputFiles' };
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

      for (const selector of loaderSelectors) {
        const elements = document.querySelectorAll(selector);

        for (const el of elements) {
          if (isVisible(el)) return { ok: true, method: 'setInputFiles' };
        }
      }

      return false;
    });
  }

  // ── New chat ───────────────────────────────────────────────────────────

  async newChat() {
    this._isFirstMessage = true;

    try {
      await this.page.goto(this.getModelUrl(), {
        waitUntil: 'domcontentloaded',
        timeout: this.config.NAVIGATION_TIMEOUT || 60000,
      });

      await this.page.waitForTimeout(1500);

      if (await this.discoverComposer()) {
        logger.debug('[DeepSeek] New chat page ready');
        return { ok: true, method: 'setInputFiles' };
      }
    } catch (error) {
      logger.warn('[DeepSeek] Navigation fallback:', error.message);
    }

    for (const selector of this._getNewChatSelectors()) {
      try {
        const button = this.page.locator(selector).first();

        if (await button.count() && await button.isVisible()) {
          await button.click({ timeout: 3000 });
          await this.page.waitForTimeout(1500);
          return { ok: true, method: 'setInputFiles' };
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
      'input.upload-file-input',
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
          logger.info('[DeepSeek] File uploaded:', filePath);
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
        'div[role="button"][aria-label*="Upload" i]',
        'button[class*="upload"]',
        'button:has(svg[class*="upload"])',
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
        throw new Error('DeepSeek upload button not found');
      }

      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);

      logger.info('[DeepSeek] File uploaded using file chooser');
      return { ok: true, method: 'filechooser' };
    } catch (error) {
      logger.error('[DeepSeek] File upload failed:', error.message);
      throw error;
    }
  }
}

module.exports = DeepSeekAdapter;