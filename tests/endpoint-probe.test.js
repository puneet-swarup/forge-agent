// tests/endpoint-probe.test.js — the HTTP models have no UI to diagnose.
//
// A llama.cpp server on Colab behind ngrok either answers or it does not, and
// "does not" has a dozen causes that look identical from inside a run: tunnel
// down, ngrok interstitial, wrong model name, missing API key, wrong path. The
// probe separates them, and these tests hold it to that.
'use strict';

const http = require('http');
const { probeEndpoint, formatProbe, baseHeaders } = require('../src/endpoint-probe');

/** A stand-in OpenAI-compatible server. */
function startServer(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const handler = handlers[req.url.split('?')[0]];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('baseHeaders', () => {
  test('sets the ngrok skip header, or every probe looks like a broken server', () => {
    expect(baseHeaders()['ngrok-skip-browser-warning']).toBe('1');
  });

  test('adds a bearer token only when a key is given', () => {
    expect(baseHeaders()['Authorization']).toBeUndefined();
    expect(baseHeaders('sk-test').Authorization).toBe('Bearer sk-test');
  });
});

describe('probeEndpoint', () => {
  test('reports ready when models and completion both work', async () => {
    const { server, url } = await startServer({
      '/v1/models': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'deepseek-r1' }] }));
      },
      '/v1/chat/completions': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
      },
    });

    try {
      const report = await probeEndpoint(url, { timeoutMs: 5000 });
      expect(report.ok).toBe(true);
      expect(report.model).toBe('deepseek-r1');
      expect(report.reply).toBe('OK');
      expect(report.verdict).toContain('ready');
    } finally {
      server.close();
    }
  });

  test('an unreachable tunnel says so, and does not throw', async () => {
    const report = await probeEndpoint('http://127.0.0.1:1', { timeoutMs: 2000 });
    expect(report.ok).toBe(false);
    expect(report.verdict).toMatch(/unreachable|ECONNREFUSED/i);
  });

  test('an ngrok interstitial is named as such', async () => {
    const { server, url } = await startServer({
      '/v1/models': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>You are about to visit ngrok</body></html>');
      },
    });

    try {
      const report = await probeEndpoint(url, { timeoutMs: 5000 });
      expect(report.ok).toBe(false);
      expect(report.verdict).toMatch(/interstitial|did not return JSON/);
    } finally {
      server.close();
    }
  });

  test('a wrong model name surfaces the server message', async () => {
    const { server, url } = await startServer({
      '/v1/models': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'real-model' }] }));
      },
      '/v1/chat/completions': (req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"model not found"}}');
      },
    });

    try {
      const report = await probeEndpoint(url, { model: 'wrong-model', timeoutMs: 5000 });
      expect(report.ok).toBe(false);
      expect(report.verdict).toContain('400');
      expect(report.verdict).toContain('model not found');
    } finally {
      server.close();
    }
  });

  test('no endpoint is reported, not crashed', async () => {
    const report = await probeEndpoint('', {});
    expect(report.ok).toBe(false);
    expect(report.verdict).toContain('no endpoint');
  });

  test('a server that is not OpenAI-compatible is called out', async () => {
    const { server, url } = await startServer({
      '/v1/models': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Ollama is running');
      },
    });

    try {
      const report = await probeEndpoint(url, { timeoutMs: 5000 });
      expect(report.ok).toBe(false);
      expect(report.verdict).toMatch(/OpenAI-compatible/);
    } finally {
      server.close();
    }
  });
});

describe('formatProbe', () => {
  test('shows each step independently', () => {
    const out = formatProbe({
      url: 'https://x.ngrok-free.dev',
      models: { ok: true, status: 200, ms: 120, body: '{}', error: null },
      modelsSeen: ['deepseek-r1'],
      completion: { ok: true, status: 200, ms: 3400, body: '{}', error: null },
      model: 'deepseek-r1',
      reply: 'OK',
      ok: true,
      verdict: 'ready — deepseek-r1 replied in 3400 ms',
    });

    expect(out).toContain('/v1/models 200 in 120 ms');
    expect(out).toContain('deepseek-r1');
    expect(out).toContain('completion 200 in 3400 ms');
    expect(out).toContain('✓');
  });

  test('never throws on an empty report', () => {
    expect(() => formatProbe(null)).not.toThrow();
    expect(() => formatProbe({})).not.toThrow();
  });
});

// ─────────────────────────────────────────────
//  A local proxy may speak either dialect
//
//  A proxy in front of a remote server is a legitimate pattern — to bypass
//  network restrictions, to terminate auth, to fix CORS. It may forward the
//  OpenAI API (/v1/*) or Ollama's (/api/*), and the adapter choice depends on
//  which, so the probe reports the dialect instead of assuming one.
// ─────────────────────────────────────────────

describe('dialect detection', () => {
  test('reports the OpenAI dialect when /v1/models answers', async () => {
    const { server, url } = await startServer({
      '/v1/models': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'deepseek-r1' }] }));
      },
      '/v1/chat/completions': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      },
    });

    try {
      const report = await probeEndpoint(url, { timeoutMs: 5000 });
      expect(report.dialect).toBe('openai');
    } finally {
      server.close();
    }
  });

  test('reports the Ollama dialect when only /api/tags answers', async () => {
    const { server, url } = await startServer({
      '/api/tags': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'deepseek-r1:latest' }] }));
      },
    });

    try {
      const report = await probeEndpoint(url, { timeoutMs: 5000 });
      expect(report.dialect).toBe('ollama');
      expect(report.modelsSeen).toContain('deepseek-r1:latest');
      expect(report.verdict).toMatch(/Ollama dialect/);
      expect(report.verdict).toMatch(/--model=ollama/);
    } finally {
      server.close();
    }
  });

  test('reports both paths when neither dialect answers', async () => {
    const { server, url } = await startServer({
      '/nothing': (req, res) => { res.writeHead(200); res.end('{}'); },
    });

    try {
      const report = await probeEndpoint(url, { timeoutMs: 3000 });
      expect(report.ok).toBe(false);
      expect(report.verdict).toMatch(/\/v1\/models returned 404/);
      expect(report.verdict).toMatch(/\/api\/tags returned 404/);
    } finally {
      server.close();
    }
  });

  test('the rendered report names the dialect', () => {
    const out = formatProbe({
      url: 'http://localhost:11434',
      models: { ok: false, status: 404, ms: 5, body: '', error: null },
      ollamaTags: { ok: true, status: 200, ms: 6, body: '{}', error: null },
      dialect: 'ollama',
      modelsSeen: ['deepseek-r1:latest'],
      ok: false,
      verdict: 'speaks the Ollama dialect, not OpenAI',
    });

    expect(out).toContain('dialect');
    expect(out).toContain('Ollama (/api/*)');
  });
});
