// src/transport-factory.js — choose a transport from the model's category.
//
// The registry declares `kind` per model: 'http' for an endpoint, 'browser' for a
// page we do not control. This is the only place that decision is made, so
// nothing downstream has to ask "does this model use a browser?" and branch.
'use strict';

const { BrowserChatTransport } = require('./browser-transport');
const { HttpChatTransport } = require('./http-transport');
const { ChatTransport } = require('./chat-transport');

const adapterFactory = require('./adapter-factory');

/**
 * The endpoint an HTTP model should talk to.
 *
 * Resolution order matches what the adapters already do, so a config that works
 * today keeps working: an explicit --model-url wins, then the per-model
 * environment, then the shared OLLAMA_BASE_URL.
 *
 * @param {string} model
 * @param {object} config
 * @returns {{baseUrl: string, apiKey: string|null, model: string|null}}
 */
function endpointFor(model, config = {}) {
  const name = adapterFactory.resolveModelName(model);
  const upper = name.toUpperCase().replace(/-/g, '_');

  const baseUrl = config.MODEL_URL
    || config[`${upper}_BASE_URL`]
    || config.OLLAMA_BASE_URL
    || config.OLLAMA_UI_URL
    || '';

  const apiKey = config.API_KEY
    || config[`${upper}_API_KEY`]
    || config.OLLAMA_API_KEY
    || null;

  // llama.cpp and vLLM ignore the model field; Ollama uses it to pick a tag.
  const modelId = config[`${upper}_MODEL`] || config.OLLAMA_MODEL || null;

  return { baseUrl, apiKey, model: modelId };
}

/**
 * Build the transport for a model.
 *
 * @param {object} opts
 * @param {string} opts.model          the requested model name or alias
 * @param {object} [opts.config]       resolved config
 * @param {object} [opts.browser]      a ForgeBrowser, required for browser models
 * @returns {ChatTransport}
 */
function createTransport(opts = {}) {
  const config = opts.config || {};
  const info = adapterFactory.getModelInfo(opts.model || config.MODEL);

  if (info.kind === 'http') {
    const endpoint = endpointFor(info.name, config);

    return new HttpChatTransport({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      timeoutMs: config.RESPONSE_TIMEOUT_MS,
    });
  }

  if (!opts.browser) {
    throw new Error(
      `${info.displayName} needs a browser, and none was provided — ` +
      'this is a bug in the caller, not a configuration problem'
    );
  }

  return new BrowserChatTransport({ browser: opts.browser, model: info.name });
}

/** Does this model need Playwright at all? */
function needsBrowser(model, config = {}) {
  return adapterFactory.getModelInfo(model || config.MODEL).kind !== 'http';
}

module.exports = { createTransport, needsBrowser, endpointFor };
