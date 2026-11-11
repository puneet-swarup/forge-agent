// src/adapters/colab-adapter.js - dedicated adapter for a remote
// Colab / ngrok / self-hosted OpenAI-compatible endpoint.
//
// This adapter is a thin, explicitly-named subclass of the local chat proxy.
// It exists so that `--model=colab` selects a REMOTE tunnel (which requires a
// reachable URL and, usually, an API key) and fails loudly with a clear error
// instead of silently falling back to localhost.
//
// Distinction from the other two self-hosted adapters:
//   ollama-adapter.js     -> TRUE local daemon (http://localhost:11434),
//                            talks to /api/tags, /v1/chat/completions.
//   local-chat-adapter.js -> proxy UI (port 1337) that forwards to whatever
//                            OLLAMA_BASE_URL points at (local or remote).
//   colab-adapter.js      -> this file: proxy UI, but hard-requires a remote
//                            endpoint and reports configuration errors early.
'use strict';

const LocalChatAdapter = require('./local-chat-adapter');
const logger = require('../logger');

class ColabAdapter extends LocalChatAdapter {
  static DEDICATED_INSTANCE = true;

  constructor(page, config = {}) {
    super(page, config);

    this._isColab = true;

    // A Colab adapter must be pointed at a real remote endpoint. If it still
    // resolves to a localhost default, surface a clear, actionable warning
    // rather than silently proxying to the local Ollama daemon.
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(
      this._ollamaBaseUrl || ''
    );

    if (!this._ollamaBaseUrl || isLocalhost) {
      logger.warn(
        '[Colab] No remote OLLAMA_BASE_URL configured. ' +
        'Set it via --model-url <url>, the OLLAMA_BASE_URL env var, a .env ' +
        'file, or forge-agent.config.json. Falling back to ' +
        (this._ollamaBaseUrl || 'http://localhost:11434') + '.'
      );
    }

    if (!this._ollamaApiKey) {
      logger.info(
        '[Colab] No OLLAMA_API_KEY configured. This is fine for open tunnels, ' +
        'but most Colab/ngrok endpoints require a bearer token.'
      );
    }
  }

  /**
   * Lightweight reachability probe against the configured tunnel.
   * Mirrors OllamaAdapter.probe() so `--test-model` and health checks behave
   * consistently, but uses the OpenAI-compatible /v1/models route because a
   * Colab tunnel may not expose the native Ollama /api/tags route.
   *
   * Never throws.
   */
  async probe() {
    let endpoint;

    try {
      endpoint = this._getOllamaEndpoint();
    } catch (err) {
      logger.warn('[Colab] probe failed: ' + err.message);
      return { ok: false, error: err.message };
    }

    const modelsUrl = new URL(endpoint.toString());
    modelsUrl.pathname = '/v1/models';

    const transport = modelsUrl.protocol === 'https:' ? require('https') : require('http');

    return new Promise(resolve => {
      const headers = {
        Accept: 'application/json',
        'ngrok-skip-browser-warning': '1',
        'User-Agent': 'forge-agent/colab-adapter'
      };

      if (this._ollamaApiKey) {
        headers.Authorization = 'Bearer ' + this._ollamaApiKey;
      }

      const req = transport.request(
        {
          protocol: modelsUrl.protocol,
          hostname: modelsUrl.hostname,
          port: modelsUrl.port || undefined,
          path: modelsUrl.pathname + modelsUrl.search,
          method: 'GET',
          headers,
          timeout: 15000
        },
        res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            if ((res.statusCode || 500) >= 400) {
              resolve({ ok: false, status: res.statusCode, body: body.slice(0, 500) });
              return;
            }
            let names = [];
            try {
              const parsed = JSON.parse(body);
              if (Array.isArray(parsed.data)) {
                names = parsed.data.map(m => m.id).filter(Boolean);
              }
            } catch (_) { /* non-JSON body: still reachable */ }
            resolve({ ok: true, models: names, requested: this._model });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('Colab probe timed out after 15s'));
      });
      req.on('error', err => {
        logger.warn('[Colab] probe failed: ' + err.message);
        resolve({ ok: false, error: err.message });
      });
      req.end();
    });
  }
}

module.exports = ColabAdapter;
