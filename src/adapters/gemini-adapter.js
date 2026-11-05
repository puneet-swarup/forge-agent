
'use strict';

const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class GeminiAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  _getInputSelectors() {
    return [
      'rich-textarea .ql-editor',
      'rich-textarea [contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea',
    ];
  }

  _getSendSelectors() {
    return [
      'button[aria-label*="Send message" i]',
      'button[aria-label="Send"]',
      'button[data-test-id="send-button"]',
      'button.send-button',
      'button[mattooltip*="Send" i]',
      'button.send-message-button',
      'button:has(mat-icon:text-is("send"))',
    ];
  }

  _getStopSelectors() {
    return [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Pause" i]',
      'button[data-test-id*="stop" i]',
      'button.stop-button',
      'button:has(mat-icon:text-is("stop"))',
    ];
  }

  _getNewChatSelectors() {
    return [
      'a[href="/app"]',
      'button[aria-label*="New chat" i]',
      'button[data-test-id*="new-chat" i]',
      'button.new-conversation-button',
      'button[mattooltip*="New chat" i]',
      'button:has(mat-icon:text-is("add"))',
    ];
  }

  _getResponseSelectors() {
    return [
      'model-response:last-child .markdown',
      'model-response:last-child',
      '.response-container:last-child .markdown-content',
      'message-content:last-child',
      '[data-response-index]:last-child',
      '.conversation-container .model-response:last-child',
      'div.model-response:last-child p',
    ];
  }

  getModelUrl() {
    return this.config.GEMINI_URL || 'https://gemini.google.com/app';
  }

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
        // Try the next selector.
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
        // Try the next selector.
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
        // Try the next selector.
      }
    }

    return null;
  }

  async getGenerationState() {
    return await this.page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;

        const style = getComputedStyle(element);

        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          element.getClientRects().length > 0
        );
      };

      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Pause" i]',
        'button[data-test-id*="stop" i]',
        'button.stop-button',
      ];

      for (const selector of stopSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (visible(element)) return { ok: true, method: 'setInputFiles' };
        }
      }

      const loadingSelectors = [
        'mat-progress-bar',
        'mat-spinner',
        '[role="progressbar"]',
        '[class*="loading"]',
        '[class*="streaming"]',
        '[class*="generating"]',
      ];

      for (const selector of loadingSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (visible(element)) return { ok: true, method: 'setInputFiles' };
        }
      }

      return false;
    });
  }

  async newChat() {
    this._isFirstMessage = true;

    try {
      await this.page.goto(this.getModelUrl(), {
        waitUntil: 'domcontentloaded',
        timeout: this.config.NAVIGATION_TIMEOUT || 60000,
      });

      await this.page.waitForTimeout(1500);

      if (await this.discoverComposer()) {
        logger.debug('[Gemini] New chat page ready');
        return { ok: true, method: 'setInputFiles' };
      }
    } catch (error) {
      logger.warn('[Gemini] Navigation fallback:', error.message);
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
        // Try the next selector.
      }
    }

    return false;
  }

  _getUploadSelectors() {
    return [
      'input[type="file"]',
      'input[type="file"][accept]',
      'input.upload-file-input',
      'input[name="file"]',
    ];
  }

  async uploadFile(filePath) {
    const fs = require('fs');

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    for (const selector of this._getUploadSelectors()) {
      try {
        const input = this.page.locator(selector).first();

        if (await input.count()) {
          await input.setInputFiles(filePath);
          logger.info('[Gemini] File uploaded:', filePath);
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
        'button[mattooltip*="Upload" i]',
        'button[mattooltip*="Add file" i]',
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
        throw new Error('Gemini upload button not found');
      }

      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);

      logger.info('[Gemini] File uploaded using file chooser');
      return { ok: true, method: 'filechooser' };
    } catch (error) {
      logger.error('[Gemini] File upload failed:', error.message);
      throw error;
    }
  }
}

module.exports = GeminiAdapter;
