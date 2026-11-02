// src/adapters/gemini-adapter.js — Gemini model adapter
'use strict';

const BaseAdapter = require('./base-adapter');
const logger      = require('../logger');

/**
 * Adapter for gemini.google.com
 */
class GeminiAdapter extends BaseAdapter {
  constructor(page, config) {
    super(page, config);
  }

  // ── Implement Abstract Methods ─────────────────────────────────────────────

  _getInputSelectors() {
    return [
      'rich-textarea .ql-editor',           // Quill editor inside rich-textarea
      'rich-textarea div[contenteditable]',  // contenteditable inside component
      '.ql-editor[contenteditable="true"]',  // Direct Quill editor
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"]',
      'textarea[aria-label*="Enter a prompt" i]',
      'textarea[placeholder*="Enter a prompt" i]',
      'textarea[aria-label*="prompt" i]',
      '[jsname="YPqjbf"]',                  // Common Gemini jsname
      'textarea',
    ];
  }

  _getSendSelectors() {
    return [
      'button[aria-label*="Send message" i]',
      'button[aria-label*="send message" i]',
      'button[jsname*="send" i]',
      '[data-test-id="send-button"]',
      'button.send-button',
      'button[aria-label="Send" i]',
      'button[mattooltip*="Send" i]',
      'button:has(mat-icon):not([disabled])',
      '.send-message-button',
    ];
  }

  _getStopSelectors() {
    return [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop" i]',
      'button[jsname*="stop" i]',
      '.stop-button',
      'button:has(mat-icon[data-mat-icon-name="stop"])',
    ];
  }

  _getNewChatSelectors() {
    return [
      'a[href="/app"]',
      'button[aria-label*="New chat" i]',
      'button[aria-label*="new chat" i]',
      '[data-test-id="new-conversation-button"]',
      'c-wiz a[href="/app"]',
      '.new-conversation-button',
      'a[jsname*="new" i]',
      'button[mattooltip*="New chat" i]',
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
    return 'https://gemini.google.com/app';
  }

  // ── Overrides ──────────────────────────────────────────────────────────────

  async newChat() {
    this._isFirstMessage = true;
    try {
      await this.page.goto(this.getModelUrl(), {
        waitUntil: 'domcontentloaded',
        timeout: this.config.BROWSER_TIMEOUT || 30_000,
      });
      await this.page.waitForTimeout(2000);
    } catch (err) {
      logger.warn(`Gemini navigation failed: ${err.message}. Trying selector fallback.`);
      // Fallback: click new chat button
      await this._clickElement(this._getNewChatSelectors(), { timeout: 10000 });
      await this.page.waitForTimeout(2000);
    }
  }

  // ── Upload capability (ARCHITECTURE.md §11) ────────────────────────────────

  /**
   * Selectors for Gemini native file-attach input.
   * Gemini usually exposes a hidden input[type=file] behind an "Add files"
   * material button/menu. Always probed via supportsUpload() before use.
   */
  _getUploadSelectors() {
    return [
      'input[type="file"]',
      'input[type="file"][accept]',
      '[class*="upload"] input[type="file"]',
      'uploader input[type="file"]',
      'input[type="file"][name*="file"]',
    ];
  }

  /**
   * Upload a local file to Gemini chat as a native attachment.
   * Tries setInputFiles first; falls back to a filechooser event. Any failure
   * throws — the caller (read_file) treats a throw as "fall back to text".
   */
  async uploadFile(absPath, opts = {}) {
    const fs = require('fs');
    const timeoutMs = opts.timeoutMs || (this.config.READ_FILE_UPLOAD_TIMEOUT_MS || 15000);

    if (!absPath || !fs.existsSync(absPath)) {
      throw new Error('uploadFile: file not found: ' + absPath);
    }

    const selectors = this._getUploadSelectors();
    for (const selector of selectors) {
      try {
        const handle = await this.page.$(selector);
        if (!handle) continue;
        await handle.setInputFiles(absPath, { timeout: timeoutMs });
        return { ok: true, method: 'setInputFiles', selector };
      } catch (err) {
        logger.warn('uploadFile(gemini): setInputFiles failed for ' + selector + ': ' + err.message);
      }
    }

    const chooserTriggers = [
      'button[aria-label*="Add files" i]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="upload" i]',
      'button[mattooltip*="Add files" i]',
      'button[aria-label*="Add" i]',
      '[class*="upload"]',
      '[class*="attach"]',
    ];
    for (const trigger of chooserTriggers) {
      try {
        const el = await this.page.$(trigger);
        if (!el) continue;
        const [chooser] = await Promise.all([
          this.page.waitForEvent('filechooser', { timeout: Math.min(timeoutMs, 5000) }),
          el.click({ timeout: 3000 }),
        ]);
        await chooser.setFiles(absPath);
        return { ok: true, method: 'filechooser', selector: trigger };
      } catch (_) {
        continue;
      }
    }

    throw new Error('uploadFile(gemini): no usable file input or attach affordance found');
  }
}

module.exports = GeminiAdapter;
