
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class LocalChatAdapter extends BaseAdapter {
 // Dedicated instance: we own the endpoint, no inter-prompt throttle.
 static DEDICATED_INSTANCE = true;
  constructor(page, config = {}) {
    super(page, config);

    this._isFirstMessage = true;

    this._serverPort = Number(
      config.LOCAL_CHAT_PORT ||
      process.env.LOCAL_CHAT_PORT ||
      1337
    );

    // Colab tunnel / OpenAI-compatible endpoint. Configurable via
    // --model-url, OLLAMA_BASE_URL env var, a .env file, or
    // forge-agent.config.json — no need to edit this file.
    this._ollamaBaseUrl =
      process.env.OLLAMA_BASE_URL ||
      config.OLLAMA_BASE_URL ||
      'http://localhost:11434';

    this._model =
      process.env.OLLAMA_MODEL ||
      config.OLLAMA_MODEL ||
      'deepseek-r1-16k:latest';

    // Optional: only needed if your tunnel requires an API key.
    this._ollamaApiKey =
      process.env.OLLAMA_API_KEY ||
      config.OLLAMA_API_KEY ||
      '';

    this._server = null;
    this._startLocalServer();
  }

  _sendJson(res, statusCode, payload) {
    if (res.headersSent || res.writableEnded) return;

    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });

    res.end(JSON.stringify(payload));
  }

  _getOllamaEndpoint() {
    const url = new URL(this._ollamaBaseUrl);

    if (!url.pathname.endsWith('/v1/chat/completions')) {
      url.pathname =
        url.pathname.replace(/\/+$/, '') +
        '/v1/chat/completions';
    }

    return url;
  }

  _startLocalServer() {
    if (this._server) return;

    const htmlFilePath = path.resolve(
      __dirname,
      '../html/local-ollama-chat.html'
    );

    this._server = http.createServer((req, res) => {
      const requestUrl = new URL(
        req.url,
        `http://127.0.0.1:${this._serverPort}`
      );

      // CORS preflight — the chat UI and any external tool may probe
      // the proxy cross-origin.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        });
        res.end();
        return;
      }

      if (
        requestUrl.pathname === '/health' &&
        req.method === 'GET'
      ) {
        this._sendJson(res, 200, {
          ok: true,
          provider: 'ollama',
          model: this._model,
          ollamaUrl: this._ollamaBaseUrl
        });
        return;
      }

      if (
        requestUrl.pathname === '/api/chat' &&
        req.method === 'POST'
      ) {
        this._handleChatRequest(req, res);
        return;
      }

      if (
        requestUrl.pathname === '/' &&
        req.method === 'GET'
      ) {
        fs.readFile(htmlFilePath, 'utf8', (err, html) => {
          if (err) {
            logger.error(
              `[LocalChat] Failed to load HTML: ${err.message}`
            );

            this._sendJson(res, 500, {
              error: 'Failed to load chat interface.'
            });
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          });

          res.end(html);
        });
        return;
      }

      this._sendJson(res, 404, {
        error: 'Route not found.'
      });
    });

    this._server.on('error', err => {
      logger.error(
        `[LocalChat] HTTP server error: ${err.message}`
      );
    });

    this._server.listen(
      this._serverPort,
      '127.0.0.1',
      () => {
        logger.info(
          `[LocalChat] Ollama chat proxy listening at http://127.0.0.1:${this._serverPort}`
        );
      }
    );

    this._server.unref();
  }

  _handleChatRequest(req, res) {
    let body = '';
    let bodySize = 0;
    let rejected = false;

    req.on('data', chunk => {
      if (rejected) return;

      bodySize += chunk.length;

      if (bodySize > 1024 * 1024) {
        rejected = true;

        this._sendJson(res, 413, {
          error: 'Request body exceeds the 1 MB limit.'
        });

        req.resume();
        return;
      }

      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (rejected || res.writableEnded) return;

      let payload;

      try {
        payload = JSON.parse(body);
      } catch {
        this._sendJson(res, 400, {
          error: 'Invalid JSON request body.'
        });
        return;
      }

      if (
        !payload ||
        !Array.isArray(payload.messages) ||
        payload.messages.length === 0
      ) {
        this._sendJson(res, 400, {
          error: 'A non-empty messages array is required.'
        });
        return;
      }

      for (const message of payload.messages) {
        if (
          !message ||
          typeof message.role !== 'string' ||
          typeof message.content !== 'string'
        ) {
          this._sendJson(res, 400, {
            error: 'Each message must contain string role and content fields.'
          });
          return;
        }
      }

      let endpoint;

      try {
        endpoint = this._getOllamaEndpoint();
      } catch (err) {
        this._sendJson(res, 500, {
          error: `Invalid OLLAMA_BASE_URL: ${err.message}`
        });
        return;
      }

      // Use the model installed in Ollama.
      payload.model = this._model;

      const upstreamBody = JSON.stringify(payload);
      const transport =
        endpoint.protocol === 'https:' ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'Accept': payload.stream
          ? 'text/event-stream'
          : 'application/json',
        // ngrok free tunnels serve an HTML interstitial unless this is set.
        'ngrok-skip-browser-warning': '1',
        'User-Agent': 'forge-agent/local-chat-adapter',
        'Content-Length': Buffer.byteLength(upstreamBody)
      };

      if (this._ollamaApiKey) {
        headers.Authorization = `Bearer ${this._ollamaApiKey}`;
      }

      const proxyReq = transport.request({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: endpoint.pathname + endpoint.search,
        method: 'POST',
        headers,
        timeout: 300000
      }, proxyRes => {
        const responseHeaders = {
          'Content-Type':
            proxyRes.headers['content-type'] ||
            'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no'
        };

        res.writeHead(
          proxyRes.statusCode || 502,
          responseHeaders
        );

        proxyRes.pipe(res);

        proxyRes.on('error', err => {
          logger.error(
            `[LocalChat] Ollama response error: ${err.message}`
          );

          if (!res.writableEnded) {
            res.destroy(err);
          }
        });
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy(
          new Error('Ollama request timed out after 5 minutes.')
        );
      });

      proxyReq.on('error', err => {
        logger.error(
          `[LocalChat] Ollama proxy error: ${err.message}`
        );

        if (!res.headersSent) {
          this._sendJson(res, 502, {
            error: `Ollama connection failed: ${err.message}`,
            endpoint: endpoint.origin
          });
        } else if (!res.writableEnded) {
          res.destroy(err);
        }
      });

      req.on('aborted', () => {
        proxyReq.destroy();
      });

      res.on('close', () => {
        if (!res.writableEnded) {
          proxyReq.destroy();
        }
      });

      proxyReq.end(upstreamBody);
    });

    req.on('error', err => {
      logger.error(
        `[LocalChat] Incoming request error: ${err.message}`
      );

      if (!res.writableEnded) {
        this._sendJson(res, 400, {
          error: 'Incoming request failed.'
        });
      }
    });
  }

  _getInputSelectors() {
    return ['textarea#chat-input'];
  }

  _getSendSelectors() {
    return [
      'button#send-btn:not(.stop-gen-btn)',
      'button[aria-label*="Send" i]'
    ];
  }

  _getStopSelectors() {
    return [
      'button.stop-gen-btn',
      'button[aria-label*="Stop" i]'
    ];
  }

  _getNewChatSelectors() {
    return [
      'button#new-chat-btn',
      'button[aria-label*="New chat" i]'
    ];
  }

  _getResponseSelectors() {
  return [
    '.message.assistant .message-text',
    '.message.assistant'
  ];
}

  getModelUrl() {
    return `http://127.0.0.1:${this._serverPort}`;
  }

  async _isGenerating() {
    return await this.page.evaluate(() => {
      const loader = document.querySelector(
        '#loading-indicator'
      );

      return Boolean(
        loader &&
        window.getComputedStyle(loader).display !== 'none'
      );
    });
  }

  async newChat() {
    this._isFirstMessage = true;

    try {
      await this.page.goto(this.getModelUrl(), {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      return true;
    } catch (error) {
      logger.error(
        `[LocalChat] Workspace reset failed: ${error.message}`
      );

      return false;
    }
  }
}

module.exports = LocalChatAdapter;
