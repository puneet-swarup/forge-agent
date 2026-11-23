// tests/local-chat-server.test.js — the page and its reverse proxy.
//
// This is not plumbing, and it was nearly deleted as if it were. It exists
// because a browser talking to a remote endpoint hits problems Node does not:
// CORS, ngrok's interstitial, auth that should not live in a page, and a single
// loopback URL for anything on this machine that speaks OpenAI or Ollama.
//
// It is also a chat UI a human can use directly, which is how it came to matter.
'use strict';

const http = require('http');
const { startLocalChatServer, upstreamUrl, CORS_HEADERS } = require('../src/local-chat-server');

/** A stand-in upstream endpoint. */
function startUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('upstream URL', () => {
  test('a bare host gets the full path', () => {
    expect(upstreamUrl('http://localhost:11434').pathname).toBe('/v1/chat/completions');
  });

  test('a /v1 base gets only the rest', () => {
    expect(upstreamUrl('https://api.example.com/v1').pathname).toBe('/v1/chat/completions');
  });

  test('a full path is left alone', () => {
    expect(upstreamUrl('https://x/v1/chat/completions').pathname).toBe('/v1/chat/completions');
  });
});

describe('the page', () => {
  test('is served at / and is the real chat UI', async () => {
    const ui = await startLocalChatServer({ port: 0, upstream: 'http://127.0.0.1:1' });
    try {
      const res = await fetch(`${ui.url}/`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('chat-input');
      expect(html).toContain('send-btn');
    } finally {
      await ui.close();
    }
  });

  test('reports health and what it proxies to', async () => {
    const ui = await startLocalChatServer({ port: 0, upstream: 'http://upstream.example' });
    try {
      const body = await (await fetch(`${ui.url}/health`)).json();
      expect(body.ok).toBe(true);
      expect(body.upstream).toBe('http://upstream.example');
      expect(body.proxying).toBe(true);
    } finally {
      await ui.close();
    }
  });
});

describe('CORS — the reason this exists', () => {
  test('preflight is answered with the headers a browser needs', async () => {
    const ui = await startLocalChatServer({ port: 0, upstream: 'http://x' });
    try {
      const res = await fetch(`${ui.url}/v1/chat/completions`, { method: 'OPTIONS' });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    } finally {
      await ui.close();
    }
  });

  test('real responses carry the origin header too', async () => {
    const { server, url } = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
    const ui = await startLocalChatServer({ port: 0, upstream: url });

    try {
      const res = await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await ui.close();
      server.close();
    }
  });
});

describe('the proxy', () => {
  test('forwards a chat request and returns the upstream body', async () => {
    const { server, url } = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'proxied reply' } }] }));
    });
    const ui = await startLocalChatServer({ port: 0, upstream: url });

    try {
      const res = await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      const body = await res.json();

      expect(body.choices[0].message.content).toBe('proxied reply');
    } finally {
      await ui.close();
      server.close();
    }
  });

  test('sets the ngrok skip header upstream — an interstitial is not a reply', async () => {
    let seen = null;
    const { server, url } = await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    });
    const ui = await startLocalChatServer({ port: 0, upstream: url });

    try {
      await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(seen['ngrok-skip-browser-warning']).toBe('1');
    } finally {
      await ui.close();
      server.close();
    }
  });

  test('carries a bearer token upstream without exposing it to the page', async () => {
    let seen = null;
    const { server, url } = await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const ui = await startLocalChatServer({ port: 0, upstream: url, apiKey: 'secret-key' });

    try {
      const res = await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(seen.authorization).toBe('Bearer secret-key');
      // The page never sees it: it is added on this side of the proxy.
      expect(res.headers.get('authorization')).toBeNull();
    } finally {
      await ui.close();
      server.close();
    }
  });

  test('an unreachable upstream is a 502 with a reason, not a hang', async () => {
    const ui = await startLocalChatServer({ port: 0, upstream: 'http://127.0.0.1:1' });
    try {
      const res = await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/upstream failed/);
    } finally {
      await ui.close();
    }
  });

  test('no upstream configured is a 503 that says so', async () => {
    const ui = await startLocalChatServer({ port: 0, upstream: '' });
    try {
      const res = await fetch(`${ui.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/no upstream/);
    } finally {
      await ui.close();
    }
  });

  test('an unknown route is a 404, not the page', async () => {
    const ui = await startLocalChatServer({ port: 0, upstream: 'http://x' });
    try {
      expect((await fetch(`${ui.url}/nope`)).status).toBe(404);
    } finally {
      await ui.close();
    }
  });
});

describe('the CLI exposes it', () => {
  const { parseArgs, KNOWN_FLAGS } = require('../src/index');

  test('--with-ui is a flag', () => {
    expect(parseArgs(['node', 'f', '--with-ui']).withUi).toBe(true);
  });

  test('--with-ui=<port> carries the port', () => {
    expect(parseArgs(['node', 'f', '--with-ui=8080']).withUi).toBe('8080');
  });

  test('it is a known flag, so it is not reported as a typo', () => {
    expect(KNOWN_FLAGS.has('--with-ui')).toBe(true);
    expect(parseArgs(['node', 'f', '--with-ui'])._unknown).toEqual([]);
  });
});
