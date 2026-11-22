// src/endpoint-probe.js — verify an OpenAI-compatible endpoint end to end.
//
// The browser adapters can be checked with --diagnose: point a page at the UI and
// see which selectors match. The HTTP adapters cannot — there is no UI to look
// at. A llama.cpp server on Colab behind ngrok either answers or it does not, and
// "does not" has a dozen causes that all look the same from inside a run:
//
//   the tunnel is down · ngrok is showing its interstitial · the model name is
//   wrong · the server needs an API key · the path is not /v1/chat/completions
//
// This module separates them. Three steps, each reported independently, so the
// answer is "the tunnel is up but the model name is wrong" rather than a 502.
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 20_000;

/** Headers a llama.cpp / Ollama / vLLM endpoint behind ngrok needs. */
function baseHeaders(apiKey) {
  const headers = {
    Accept: 'application/json',
    // ngrok's free tier serves an HTML interstitial unless this is set; without
    // it every probe looks like a broken server.
    'ngrok-skip-browser-warning': '1',
    'User-Agent': 'forge-agent/endpoint-probe',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * One HTTP request, resolved rather than thrown.
 *
 * @param {string} url
 * @param {object} [opts] { method, headers, body, timeoutMs }
 * @returns {Promise<{ok: boolean, status: number|null, body: string, error: string|null, ms: number}>}
 */
function request(url, opts = {}) {
  const started = Date.now();

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ ok: false, status: null, body: '', error: `invalid URL: ${err.message}`, ms: 0 });
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const body = opts.body ? Buffer.from(opts.body) : null;

    const headers = { ...(opts.headers || {}) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }

    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: text,
          error: null,
          ms: Date.now() - started,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${opts.timeoutMs || DEFAULT_TIMEOUT_MS} ms`));
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: null, body: '', error: err.message, ms: Date.now() - started });
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Probe an OpenAI-compatible endpoint: models, then one tiny completion.
 *
 * @param {string} baseUrl     e.g. https://xxx.ngrok-free.dev (no /v1 needed)
 * @param {object} [opts]      { apiKey, model, timeoutMs, completion }
 * @returns {Promise<object>}  a structured report; never throws
 */
async function probeEndpoint(baseUrl, opts = {}) {
  const report = {
    url: String(baseUrl || ''),
    models: null,
    completion: null,
    model: opts.model || null,
    modelsSeen: [],
    ok: false,
    verdict: '',
  };

  if (!baseUrl) {
    report.verdict = 'no endpoint configured';
    return report;
  }

  const root = String(baseUrl).replace(/\/+$/, '');
  const headers = baseHeaders(opts.apiKey);

  // ── 1. Does the tunnel answer at all, and which models does it list? ─────
  const modelsRes = await request(`${root}/v1/models`, { headers, timeoutMs: opts.timeoutMs });
  report.models = modelsRes;

  if (!modelsRes.ok) {
    report.verdict = modelsRes.error
      ? `endpoint unreachable: ${modelsRes.error}`
      : `GET /v1/models returned ${modelsRes.status}` +
        (modelsRes.body.includes('ngrok') ? ' (ngrok interstitial — the skip header did not take)' : '');
    return report;
  }

  try {
    const parsed = JSON.parse(modelsRes.body);
    report.modelsSeen = Array.isArray(parsed.data)
      ? parsed.data.map((m) => m && (m.id || m.name)).filter(Boolean)
      : [];
  } catch (_) {
    report.verdict = 'GET /v1/models did not return JSON — is this an OpenAI-compatible server?';
    return report;
  }

  // ── 2. Does it complete? One token is enough to prove the path. ─────────
  const model = opts.model || report.modelsSeen[0] || 'default';
  report.model = model;

  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: opts.completion ? undefined : 8,
    temperature: 0,
    stream: false,
  });

  const chatRes = await request(`${root}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: payload,
    timeoutMs: opts.timeoutMs || 60_000,
  });
  report.completion = chatRes;

  if (!chatRes.ok) {
    report.verdict = chatRes.error
      ? `completion failed: ${chatRes.error}`
      : `POST /v1/chat/completions returned ${chatRes.status}: ${chatRes.body.slice(0, 200)}`;
    return report;
  }

  try {
    const parsed = JSON.parse(chatRes.body);
    const choice = parsed.choices && parsed.choices[0];
    const text = choice && choice.message && choice.message.content;

    if (typeof text !== 'string') {
      report.verdict = 'completion returned no message content';
      return report;
    }

    report.reply = text.trim();
    report.ok = true;
    report.verdict = `ready — ${model} replied in ${chatRes.ms} ms`;
  } catch (_) {
    report.verdict = 'completion did not return JSON — check the endpoint, not the agent';
  }

  return report;
}

/**
 * Render a probe report for the terminal.
 *
 * Pure: no I/O, so the shape is testable without a server.
 *
 * @param {object} report
 * @returns {string}
 */
function formatProbe(report) {
  const lines = [];
  const r = report || {};

  lines.push('');
  lines.push('Endpoint probe');
  lines.push(`  url        ${r.url || '(none)'}`);

  if (r.models) {
    const m = r.models;
    lines.push(`  /v1/models ${m.ok ? `200 in ${m.ms} ms` : m.error ? `failed: ${m.error}` : `HTTP ${m.status}`}`);
  }

  if (Array.isArray(r.modelsSeen) && r.modelsSeen.length) {
    lines.push(`  models     ${r.modelsSeen.slice(0, 6).join(', ')}${r.modelsSeen.length > 6 ? '…' : ''}`);
  }

  if (r.completion) {
    const c = r.completion;
    lines.push(`  completion ${c.ok ? `200 in ${c.ms} ms` : c.error ? `failed: ${c.error}` : `HTTP ${c.status}`}`);
  }

  if (r.model) lines.push(`  model      ${r.model}`);
  if (r.reply) lines.push(`  reply      ${JSON.stringify(r.reply.slice(0, 80))}`);

  lines.push('');
  lines.push(`  ${r.ok ? '✓' : '✗'} ${r.verdict || (r.ok ? 'ready' : 'not ready')}`);
  lines.push('');

  return lines.join('\n');
}

module.exports = { probeEndpoint, formatProbe, request, baseHeaders };
