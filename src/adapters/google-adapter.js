'use strict';

const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

/**
 * GoogleAdapter -- drives Google's AI surfaces (AI Mode / AI Overview)
 * through the live chat composer, exactly like the other adapters.
 *
 * It deliberately does NOT navigate to google.com/search?q=. SERP HTML
 * contains no model that understands the Forge tool-call protocol, and the
 * full system prompt cannot fit in a query string. Instead the adapter
 * attaches to whatever Google AI surface is open in the browser::
 *
 *  - https://google.com/ai                (AI Mode chat)
 *  - https://google.com/search?udm=50    (AI Mode tab)
 *
 * See docs/GOOGLE_ADAPTER.md for the full feasibility analysis.
 */
class GoogleAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  _getInputSelectors() {
    return [
      'textarea[aria-label*="ask" i]',
      'textarea[placeholder*="ask" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="ask" i]',
      'textarea',
      'textarea[name="q"]',
      'input[name="q"]',
      'textarea[aria-label*="Search" i]',
      'input[aria-label*="Search" i]',
    ];
  }

  _getSendSelectors() {
    return [
      'button[aria-label*="Send" i]',
      'button[data-test-id*="send" i]',
      'button[jsname*="send" i]',
      'div[irole="button"][aria-label*="Send" i]',
      'input[type="submit"][name="btnK"]',
      'button[type="submit"]',
    ];
  }

  _getStopSelectors() {
    return [
      'div[irole="button"][aria-label*="Stop" i]',
      'button[aria-label*="Stop" i]',
      'button[data-test-id*="stop" i]',
      'div[jsname*="stop" i]',
    ];
  }

  _getNewChatSelectors() {
    return [
      'a[href="/ai"]',
      'a[href="/ai?"]',
      'a[href="/"]',
      'a#logo',
    ];
  }

  _getResponseSelectors() {
    return [
      'div[data-attribution]',
      'div[class*="ai-answer" i]',
      'div[id*="ai-overview" i]',
      'div[class*="markdown" i]',
      '#search',
      '#rcnt',
      '#center_col',
    ];
  }

  getModelUrl() {
    return this.config.GOOGLE_URL || 'https://www.google.com/ai';
  }

  async discoverComposer() {
    for (const selector of this._getInputSelectors()) {
      try {
        const locator = this.page.locator(selector).last();
        if (await locator.count() && await locator.isVisible() && await locator.isEnabled()) {
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
        if (await locator.count() && await locator.isVisible() && await locator.isEnabled()) {
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
