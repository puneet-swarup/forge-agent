'use strict';

const fs = require('fs');
const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class QwenAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  _getInputSelectors() {
    return [
      '.message-input-textarea',
      '#chat-textarea',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[class*="message"]',
      '[contenteditable="true"][data-placeholder]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
    ];
  }

  _getSendSelectors() {
    return [
      '.message-input-right-button-send',
      'button[aria-label="Send"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]',
      'button.send-button',
      '.ant-btn-primary',
    ];
  }

  _getStopSelectors() {
    return [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Interrupt" i]',
      '.stop-button',
      'button:has(svg[class*="square"])',
    ];
  }

  _getNewChatSelectors() {
    return [
      'button[aria-label*="New Chat" i]',
      'button.new-chat-button',
      '.new-chat',
      'button:has-text("New Chat")',
      'aside button',
    ];
  }

  _getResponseSelectors() {
    return [
      '.qwen-markdown',
      '.message-content .markdown',
      '[data-message-author="assistant"] .markdown',
      '.message-bubble.assistant',
      '.markdown-body',
      '.content.markdown',
      '[class*="assistant"] .markdown',
    ];
  }

  getModelUrl() {
    return this.config.QWEN_URL || 'https://chat.qwen.ai/';
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
        // Continue to the next selector.
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
        // Continue to the next selector.
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
        // Continue to the next selector.
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
        'button[aria-label*="Interrupt" i]',
        '.stop-button',
      ];

      for (const selector of stopSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (visible(element)) return { ok: true, method: 'setInputFiles' };
        }
      }

      const loadingSelectors = [
        '[class*="loading"]',
        '[class*="typing"]',
        '[class*="streaming"]',
        '[class*="generating"]',
        '[role="progressbar"]',
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
        logger.debug('[Qwen] New chat page ready');
        return { ok: true, method: 'setInputFiles' };
      }
    } catch (error) {
      logger.warn('[Qwen] Navigation fallback:', error.message);
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
        // Continue to the next selector.
      }
    }

    return false;
  }

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
          logger.info('[Qwen] File uploaded:', filePath);
          return { ok: true, method: 'setInputFiles' };
        }
      } catch (_) {
        // Try the file chooser fallback.
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
        throw new Error('Qwen upload button not found');
      }

      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);

      logger.info('[Qwen] File uploaded using file chooser');
      return { ok: true, method: 'filechooser' };
    } catch (error) {
      logger.error('[Qwen] File upload failed:', error.message);
      throw error;
    }
  }
}

module.exports = QwenAdapter;