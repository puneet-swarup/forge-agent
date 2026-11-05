'use strict';

const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class GoogleAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  _getInputSelectors() {
    return [
      'textarea[name="q"]',
      'input[name="q"]',
      'textarea[aria-label="Search"]',
      'input[aria-label="Search"]',
    ];
  }

  _getSendSelectors() {
    return [
      'input[type="submit"][name="btnK"]',
      'button[type="submit"]',
      'svg.MlmLtf',
    ];
  }

  _getStopSelectors() {
    return [];
  }

  _getNewChatSelectors() {
    return [
      'a[href="/"]',
      'a#logo',
    ];
  }

  _getResponseSelectors() {
    return [
      '#search',
      '#rcnt',
      '#center_col',
    ];
  }

  getModelUrl() {
    return this.config.GOOGLE_URL || 'https://www.google.com';
  }

  async discoverComposer() {
    for (const selector of this._getInputSelectors()) {
      try {
        const locator = this.page.locator(selector).first();

        if (
          await locator.count() &&
          await locator.isVisible() &&
          await locator.isEnabled()
        ) {
          return locator;
        }
      } catch (_) {
        // Probe next selector.
      }
    }

    return null;
  }

  async discoverSendButton() {
    for (const selector of this._getSendSelectors()) {
      try {
        const locator = this.page.locator(selector).first();

        if (await locator.count() && await locator.isVisible()) {
          return locator;
        }
      } catch (_) {
        // Probe next selector.
      }
    }

    return null;
  }

  async sendMessage(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('sendMessage: search query must be a non-empty string');
    }

    try {
      const searchUrl = `https://google.com/search?q=${encodeURIComponent(text.trim())}`;
      logger.info('[Google] Navigating directly to query url');

      await this.page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.NAVIGATION_TIMEOUT || 30000,
      });
      return;
    } catch (err) {
      logger.warn(
        `[Google] Direct URL navigation failed: ${err.message}. Retrying via UI composition...`
      );
    }

    const input = await this.discoverComposer();
    if (!input) {
      throw new Error('Failed to find Google search text input element.');
    }

    await input.click();
    await input.fill(text.trim());

    const sendButton = await this.discoverSendButton();
    if (sendButton) {
      await sendButton.click();
    } else {
      await this.page.keyboard.press('Enter');
    }
  }

  async waitForResponse(options = {}) {
    const { onChunk } = options;
    const timeoutMs = this.config.RESPONSE_TIMEOUT || 30000;
    const startedAt = Date.now();

    try {
      const searchContainerSelector = this._getResponseSelectors()[0];

      await this.page.waitForSelector(searchContainerSelector, {
        state: 'visible',
        timeout: timeoutMs,
      });

      const text = await this.page.evaluate(() => {
        const target = document.querySelector('#search');
        return target ? target.innerText : '';
      });

      if (!text.trim()) {
        throw new Error(
          'Google page loaded but layout yields an empty container.'
        );
      }

      // Apply the shared cleaning pipeline (base64 decode, JSON passthrough,
      // reasoning-block stripping, etc.). Previously this was skipped.
      const cleaned = this._cleanText(text);

      if (typeof onChunk === 'function') {
        try {
          onChunk({
            text: cleaned,
            delta: cleaned.length,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (_) {
          // UI callback errors must not break extraction.
        }
      }

      return cleaned;
    } catch (err) {
      throw new Error(
        `[Google] Engine extraction timeout or failed node access: ${err.message}`
      );
    }
  }

  async newChat() {
    this._isFirstMessage = true;

    try {
      await this.page.goto(this.getModelUrl(), {
        waitUntil: 'domcontentloaded',
        timeout: this.config.NAVIGATION_TIMEOUT || 30000,
      });
      return true;
    } catch (error) {
      logger.error('[Google] Navigation home failed:', error.message);
      return false;
    }
  }
}

module.exports = GoogleAdapter;