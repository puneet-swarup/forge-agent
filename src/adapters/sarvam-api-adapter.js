// src/adapters/sarvam-adapter.js — Sarvam AI's hosted chat API.
//
// Sarvam is different from the other adapters in this directory: it is not a
// web chat UI driven through a browser, it is an OpenAI-compatible HTTP API
// (https://api.sarvam.ai/v1/chat/completions). There is no page to type into,
// so this adapter reuses the existing remote-endpoint path (the same one
// `--model=colab` uses) with Sarvam's defaults and a clear failure when the key
// is missing.
//
// Auth: Sarvam accepts `Authorization: Bearer <key>`, which is exactly the
// header the proxy already sends. The key comes from SARVAM_API_KEY (preferred)
// or OLLAMA_API_KEY, and must never be written into a file in this repo.
//
// Models (2026): sarvam-105b (128K, flagship, reasoning on by default),
// sarvam-105b-conversations (32K, dialogue), sarvam-30b (64K). Sarvam-M is
// deprecated and rejected by the API.
'use strict';

const ColabAdapter = require('./colab-adapter');
const logger = require('../logger');

const SARVAM_BASE_URL = 'https://api.sarvam.ai/v1';
const SARVAM_DEFAULT_MODEL = 'sarvam-105b';

class SarvamApiAdapter extends ColabAdapter {
  static DEDICATED_INSTANCE = true;

  constructor(page, config = {}) {
    // Sarvam's endpoint and model are fixed, so they are set before the parent
    // constructor reads them.
    const merged = { ...config };
    merged.OLLAMA_BASE_URL = merged.SARVAM_BASE_URL || SARVAM_BASE_URL;
    merged.OLLAMA_API_KEY  = merged.SARVAM_API_KEY || merged.OLLAMA_API_KEY || '';
    merged.OLLAMA_MODEL    = merged.SARVAM_MODEL || SARVAM_DEFAULT_MODEL;

    super(page, merged);

    // The parent prefers process.env.OLLAMA_* over the config it was given, so
    // an OLLAMA_BASE_URL left over from a Colab tunnel would silently redirect
    // Sarvam traffic to someone's ngrok endpoint. Sarvam's endpoint is not
    // negotiable, so it is asserted after the parent resolves.
    this._ollamaBaseUrl = merged.SARVAM_BASE_URL || SARVAM_BASE_URL;
    this._model          = merged.SARVAM_MODEL || SARVAM_DEFAULT_MODEL;
    this._ollamaApiKey   = merged.SARVAM_API_KEY || merged.OLLAMA_API_KEY || '';

    this._isSarvam = true;

    if (!merged.OLLAMA_API_KEY) {
      // A missing key is the most likely failure, and it must say so plainly
      // rather than surfacing as a 401 from the endpoint three steps later.
      logger.warn(
        '[Sarvam] No API key. Set SARVAM_API_KEY (get one at ' +
        'https://dashboard.sarvam.ai), or pass --api-key. ' +
        'The key is sent as a Bearer token and is never written to disk here.'
      );
    }
  }

  getModelUrl() {
    return this.config.SARVAM_URL || SARVAM_BASE_URL;
  }
}

SarvamApiAdapter.BASE_URL = SARVAM_BASE_URL;
SarvamApiAdapter.DEFAULT_MODEL = SARVAM_DEFAULT_MODEL;

module.exports = SarvamApiAdapter;
