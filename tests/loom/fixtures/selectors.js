'use strict';
// tests/loom/fixtures/selectors.js — braces that are not blocks.

/** Adapter selectors. Kept as strings so the UI can change without a rebuild. */
const SELECTORS = {
  composer: 'div[contenteditable="true"] { outline: none; }',
  send: 'button[data-testid="send"]',
  stop: 'button[aria-label="Stop {generating}"]',
};

/**
 * Base adapter. Shared by every model adapter.
 */
class BaseAdapter {
  constructor(page) {
    this.page = page;
    this.marker = '}';
  }

  /** Type into the composer. */
  async send(text) {
    const payload = `{ "text": "${text}" }`; // a brace in a template
    /* a block comment with { and } */
    if (!text) {
      throw new Error('empty');
    }
    return payload;
  }

  static create(page) {
    return new BaseAdapter(page);
  }

  get ready() {
    return true;
  }
}

const withDefaults = (opts) => {
  return { ...opts };
};

const PURE = (x) => x;

const MAX_RETRIES = 3;

function topLevel(x) { return x; }

module.exports = { BaseAdapter, withDefaults, topLevel };
