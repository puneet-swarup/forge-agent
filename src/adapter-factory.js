// src/adapter-factory.js — Central adapter registry
'use strict';

const MODEL_REGISTRY = Object.freeze({
  local: {
    displayName: 'Local Ollama Chat',
 dedicated: true,
    url: 'file://' + __dirname + '/html/local-ollama-chat.html',
    aliases: ['local', 'local-chat'],
    adapter: './adapters/local-chat-adapter',
  },

  ollama: {
    // Port 11434 is Ollama's REST API, not a chat UI — browsing to it returns
    // plain text, so every selector missed and the run failed with "input not
    // found". The UI is the bundled page, which proxies to the daemon. Point
    // OLLAMA_UI_URL at Open WebUI or similar if you prefer a different one.
    displayName: 'Local Ollama',
    dedicated: true,
    url: 'file://' + __dirname + '/html/local-ollama-chat.html',
 aliases: ['ollama', 'local-ollama', 'ollama-local'],
 adapter: './adapters/ollama-adapter',
  },

  colab: {
    displayName: 'Colab / Remote Tunnel',
    dedicated: true,
    // No default endpoint, deliberately. This used to be a personal ngrok
    // tunnel URL, which meant any user who ran `--model=colab` without
    // --model-url sent their prompts and file contents to one individual's
    // development endpoint. The endpoint is supplied at run time via
    // --model-url / OLLAMA_BASE_URL (see ColabAdapter).
    url: null,
    aliases: ['colab', 'tunnel', 'ngrok', 'remote-ollama'],
    adapter: './adapters/colab-adapter',
  },

  sarvam: {
    displayName: 'Sarvam AI (Indus)',
    dedicated: true,
    // The browser-driven chat UI, like the other web models: sign in once and
    // the session persists. Selectors live in SarvamAdapter, which also carries
    // the TipTap/ProseMirror insertion workaround.
    url: 'https://indus.sarvam.ai/indus',
    aliases: ['sarvam', 'sarvam-ai', 'indus'],
    adapter: './adapters/sarvam-adapter',
  },

  deepseek: {
    displayName: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    aliases: ['deepseek', 'deepseek-r1', 'r1'],
    adapter: './adapters/deepseek-adapter',
  },

  qwen: {
    displayName: 'Qwen',
    url: 'https://chat.qwen.ai/',
    aliases: ['qwen'],
    adapter: './adapters/qwen-adapter',
  },

  chatgpt: {
    displayName: 'ChatGPT',
    url: 'https://chatgpt.com',
    aliases: ['chatgpt', 'gpt', 'openai'],
    adapter: './adapters/chatgpt-adapter',
  },

  gemini: {
    displayName: 'Gemini',
    url: 'https://gemini.google.com/app',
    aliases: ['gemini'],
    adapter: './adapters/gemini-adapter',
  },
  
  google: {
    // Not a chat model. www.google.com/ai is a search surface: this adapter
    // types a query and reads results back. Useful as a research fallback,
    // wrong for a coding task — so the display name says which it is, because
    // selecting "Google" expecting an agent is selecting the wrong thing.
    displayName: 'Google Search (research only)',
    url: 'https://www.google.com',
    aliases: ['google', 'search', 'goog'],
    adapter: './adapters/google-adapter',
  }
});

// Build alias -> canonical-name lookup once.
const ALIAS_MAP = new Map();

for (const [canonicalName, definition] of Object.entries(MODEL_REGISTRY)) {
  for (const alias of definition.aliases) {
    ALIAS_MAP.set(alias, canonicalName);
  }
}

const SUPPORTED_MODELS = Object.freeze(
  Object.keys(MODEL_REGISTRY)
);

/**
 * Resolve a supplied model name or alias to its canonical name.
 *
 * Examples:
 *   resolveModelName('GPT')        -> 'chatgpt'
 *   resolveModelName('deepseek-r1')-> 'deepseek'
 */
function resolveModelName(modelName) {
  const requested = String(modelName || 'deepseek')
    .trim()
    .toLowerCase();

  const canonical = ALIAS_MAP.get(requested);

  if (!canonical) {
    throw new Error(
      `Unsupported model: "${requested}". ` +
      `Supported models: ${SUPPORTED_MODELS.join(', ')}`
    );
  }

  return canonical;
}

/**
 * Construct the adapter for the requested model.
 *
 * @param {string} modelName
 * @param {Object} page Playwright Page
 * @param {Object} config Application configuration
 * @returns {BaseAdapter}
 */
function getAdapter(modelName, page, config = {}) {
  const canonicalName = resolveModelName(modelName);
  const definition = MODEL_REGISTRY[canonicalName];

  // Lazy loading keeps unused model adapters out of the require path.
  const AdapterClass = require(definition.adapter);

  return new AdapterClass(page, config);
}

/**
 * Get the default URL for a model.
 */
function getModelUrl(modelName) {
  const canonicalName = resolveModelName(modelName);
  const def = MODEL_REGISTRY[canonicalName];

  if (!def.url) {
    throw new Error(
      `${def.displayName} has no default endpoint. Point it at your own: ` +
      `--model-url <url> (or set OLLAMA_BASE_URL). Refusing to guess an ` +
      `endpoint for a remote model.`
    );
  }

  return def.url;
}

/**
 * Get the human-readable model name.
 */
function getModelDisplayName(modelName) {
  const canonicalName = resolveModelName(modelName);

  return MODEL_REGISTRY[canonicalName].displayName;
}

/**
 * Return metadata for a model.
 * A copy is returned so callers cannot mutate the registry.
 */
function getModelInfo(modelName) {
  const canonicalName = resolveModelName(modelName);
  const definition = MODEL_REGISTRY[canonicalName];

  return {
    name: canonicalName,
    displayName: definition.displayName,
    url: definition.url,
    aliases: [...definition.aliases],
 dedicated: definition.dedicated === true,
  };
}

module.exports = {
  getAdapter,
  getModelUrl,
  getModelDisplayName,
  getModelInfo,
  resolveModelName,
  SUPPORTED_MODELS,
};