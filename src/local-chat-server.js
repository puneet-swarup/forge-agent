// src/local-chat-server.js — the loopback chat page and its reverse proxy.
//
// This is not plumbing. It exists because a browser client talking to a remote
// endpoint hits problems the agent does not have:
//
//   CORS          a page served from file:// cannot POST to api.example.com.
//                 Served from here, the request is same-origin, and the proxy
//                 answers OPTIONS with the right headers for anything else.
//   Interstitials ngrok's free tier serves an HTML page instead of your API
//                 unless the skip header is set. The proxy sets it.
//   Auth          a bearer token stays on this side of the proxy instead of
//                 being pasted into a page.
//   Reachability  one URL — http://127.0.0.1:<port> — for anything on this
//                 machine that speaks OpenAI or Ollama.
//
// It also happens to be a chat UI a human can use directly, which is how it was
// found to matter: the agent does not need it (Node has no CORS), but a person
// does.
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, 'html', 'local-ollama-chat.html');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/** Upstream completion URL, tolerating a base that already ends in /v1. */
function upstreamUrl(baseUrl) {
  const url = new URL(baseUrl);
  const trimmed = url.pathname.replace(/\/+$/, '');

  if (trimmed.endsWith('/v1/chat/completions')) return url;

  url.pathname = trimmed.endsWith('/v1')
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;

  return url;
}

/**
 * Start the page and its proxy.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]        0 picks a free port
 * @param {string} [opts.upstream]    the endpoint to proxy to
 * @param {string} [opts.apiKey]      bearer token for the upstream
 * @param {string} [opts.model]       default model id
 * @param {string} [opts.htmlPath]    override the page (tests)
 * @returns {Promise<{server, port, url, close}>}
 */
function startLocalChatServer(opts = {}) {
  const port = Number.isInteger(opts.port) ? opts.port : 1337;
  const upstream = opts.upstream || process.env.OLLAMA_BASE_URL || '';
  const apiKey = opts.apiKey || process.env.OLLAMA_API_KEY || '';
  const model = opts.model || process.env.OLLAMA_MODEL || '';
  const htmlPath = opts.htmlPath || HTML_PATH;

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);

    const json = (status, payload) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...CORS_HEADERS,
      });
      res.end(JSON.stringify(payload));
    };

    // CORS preflight: the page is same-origin, but other local tools are not.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (requestUrl.pathname === '/health') {
      json(200, { ok: true, model, upstream, proxying: Boolean(upstream) });
      return;
    }

    // ── the page ──────────────────────────────────────────────────────────
    if (requestUrl.pathname === '/' && req.method === 'GET') {
      fs.readFile(htmlPath, 'utf8', (err, html) => {
        if (err) {
          json(500, { ok: false, error: `page not found: ${err.message}` });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
        res.end(html);
      });
      return;
    }

    // ── the proxy ─────────────────────────────────────────────────────────
    // Both dialects are accepted so a browser client can point at either.
    const isChat = (requestUrl.pathname === '/api/chat' && req.method === 'POST')
      || (requestUrl.pathname === '/v1/chat/completions' && req.method === 'POST');

    if (isChat) {
      if (!upstream) {
        json(503, { ok: false, error: 'no upstream configured (set OLLAMA_BASE_URL)' });
        return;
      }

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        let target;
        try {
          target = upstreamUrl(upstream);
        } catch (err) {
          json(500, { ok: false, error: `bad upstream URL: ${err.message}` });
          return;
        }

        const transport = target.protocol === 'https:' ? https : http;

        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
          // ngrok's free tier serves an HTML interstitial without this.
          'ngrok-skip-browser-warning': '1',
          'User-Agent': 'forge-agent/local-chat-server',
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const proxyReq = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          timeout: 300000,
        }, (proxyRes) => {
          const out = [];
          proxyRes.on('data', (c) => out.push(c));
          proxyRes.on('end', () => {
            if (res.headersSent || res.writableEnded) return;
            res.writeHead(proxyRes.statusCode || 502, {
              'Content-Type': proxyRes.headers['content-type'] || 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              ...CORS_HEADERS,
            });
            res.end(Buffer.concat(out));
          });
        });

        proxyReq.on('timeout', () => proxyReq.destroy(new Error('upstream timed out')));
        proxyReq.on('error', (err) => {
          json(502, { ok: false, error: `upstream failed: ${err.message}` });
        });

        proxyReq.write(body);
        proxyReq.end();
      });
      return;
    }

    json(404, { ok: false, error: `no route for ${req.method} ${requestUrl.pathname}` });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        upstream,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startLocalChatServer, upstreamUrl, CORS_HEADERS };
