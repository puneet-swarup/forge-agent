
'use strict';

const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class ChatGPTAdapter extends BaseAdapter {
  constructor(page, config = {}) {
    super(page, config);
    this._isFirstMessage = true;
  }

  _getInputSelectors() {
    return [
      '#prompt-textarea',
      'div#prompt-textarea',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"].ProseMirror',
      'main [contenteditable="true"]',
      'form [contenteditable="true"]',
      '[data-testid="composer"] [contenteditable="true"]',
      'textarea',
    ];
  }

  _getSendSelectors() {
    return [
      'button[data-testid="composer-send-button"]',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      '#send-button',
      'form button[type="submit"]',
    ];
  }

  _getStopSelectors() {
    return [
      'button[data-testid="composer-stop-button"]',
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Cancel" i]',
      'button:has(svg.stop-icon)',
    ];
  }

  _getNewChatSelectors() {
    return [
      'button[aria-label="New chat"]',
      'button[data-testid="create-new-chat-button"]',
      'a[href="/"]',
      'a[href="/?oai-dm=1"]',
      'nav button[aria-label*="New chat" i]',
      'button:has-text("New chat")',
    ];
  }

  _getResponseSelectors() {
	  return [
		'.thread-scroll-container [class*="prose"]',
		'[role="region"][aria-label="Conversation"] [class*="prose"]',
		'[class*="prose"]',
	  ];
  }

  getModelUrl() {
    return this.config.CHATGPT_URL || 'https://chatgpt.com/';
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
      // Try the next selector.
    }
  }

  return null;
}

async getGenerationState() {
  return await this.page.evaluate(() => {
    const stopSelectors = [
      'button[data-testid="composer-stop-button"]',
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
    ];

    for (const selector of stopSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        const style = window.getComputedStyle(element);

        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 &&
          element.getClientRects().length > 0;

        if (visible && !element.disabled) {
          return { ok: true, method: 'setInputFiles' };
        }
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

      const composer = await this.discoverComposer();

      if (composer) {
        logger.debug('[ChatGPT] New chat page ready');
        return { ok: true, method: 'setInputFiles' };
      }
    } catch (error) {
      logger.warn(
		  '[ChatGPT] Navigation fallback:',
		  error.stack || error.message || error
		);
    }

    for (const selector of this._getNewChatSelectors()) {
      try {
        const locator = this.page.locator(selector).first();

        if (await locator.count() && await locator.isVisible()) {
          await locator.click({ timeout: 3000 });
          await this.page.waitForTimeout(1500);
          return { ok: true, method: 'setInputFiles' };
        }
      } catch (_) {
        // Continue trying selectors.
      }
    }

    return false;
  }

  async isReady() {
    try {
      const title = await this.page.title().catch(() => '');

      if (/just a moment|attention required/i.test(title)) {
        logger.warn('[ChatGPT] Cloudflare challenge detected');

        await this.page.bringToFront().catch(() => {});

        await this.page.waitForFunction(
          () => !/just a moment|attention required/i.test(document.title),
          { timeout: this.config.CLOUDFLARE_TIMEOUT || 120000 }
        ).catch(() => {});
      }

      await this.page.waitForTimeout(500);

      return await super.isReady();
    } catch (error) {
      logger.warn('[ChatGPT] Readiness check failed:', error.message);
      return false;
    }
  }

  async _extractText(selectors = this._getResponseSelectors()) {
  const result = await this.page.evaluate((responseSelectors) => {
      const visible = (element) => {
        if (!element) return false;

        const style = getComputedStyle(element);

        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        );
      };

      let message = null;

      for (const selector of responseSelectors) {
        const elements = Array.from(
          document.querySelectorAll(selector)
        ).filter(visible);

        if (elements.length) {
          message = elements[elements.length - 1];
          break;
        }
      }

      if (!message) return '';

      const clone = message.cloneNode(true);

      clone.querySelectorAll(
        'button, nav, [aria-hidden="true"], ' +
        '[data-testid*="toolbar"], [data-testid*="actions"], ' +
        'svg, canvas'
      ).forEach((element) => element.remove());

      const codeBlocks = Array.from(
        clone.querySelectorAll('pre')
      );

      const replacements = [];

      codeBlocks.forEach((pre, index) => {
        const code = pre.querySelector('code');
        const content = code ? code.innerText : pre.innerText;

        const languageClass = code
          ? Array.from(code.classList).find((name) =>
              name.startsWith('language-')
            )
          : null;

        const language = languageClass
          ? languageClass.replace('language-', '')
          : '';

        const placeholder = `\n\n__FORGE_CODE_${index}__\n\n`;

        replacements.push({
          placeholder,
          value: `\n\n\`\`\`${language}\n${content}\n\`\`\`\n\n`,
        });

        pre.replaceWith(document.createTextNode(placeholder));
      });

      const inlineCodes = Array.from(
        clone.querySelectorAll('code')
      );

      const inlineReplacements = [];

      inlineCodes.forEach((code, index) => {
        const placeholder = `__FORGE_INLINE_${index}__`;

        inlineReplacements.push({
          placeholder,
          value: `\`${code.innerText}\``,
        });

        code.replaceWith(document.createTextNode(placeholder));
      });

      let text = clone.innerText || clone.textContent || '';

      for (const item of replacements) {
        text = text.replace(item.placeholder, item.value);
      }

      for (const item of inlineReplacements) {
        text = text.replace(item.placeholder, item.value);
      }

      return text.trim();
    }, selectors);
    return result || '';
  }

  _cleanText(text) {
    return super._cleanText(text)
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  _getUploadSelectors() {
    return [
      'input[type="file"]',
      'input[type="file"][multiple]',
      'input[accept]',
      '[data-testid="upload-file-input"]',
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
          logger.info('[ChatGPT] File uploaded:', filePath);
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

      const buttons = [
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
        'button[data-testid*="attach"]',
      ];

      let clicked = false;

      for (const selector of buttons) {
        const button = this.page.locator(selector).first();

        if (await button.count() && await button.isVisible()) {
          await button.click();
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        throw new Error('ChatGPT upload button not found');
      }

      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);

      logger.info('[ChatGPT] File uploaded using file chooser');
      return { ok: true, method: 'filechooser' };
    } catch (error) {
      logger.error('[ChatGPT] File upload failed:', error.message);
      throw error;
    }
  }
}

module.exports = ChatGPTAdapter;
