// src/adapter-factory.js — Central adapter registry
'use strict';

const MODEL_REGISTRY = Object.freeze({
  local: {
    displayName: 'Local Ollama Chat',
 dedicated: true,
    url: 'file://' + __dirname + '/html/local-ollama-chat.html',
    aliases: ['local', 'ollama', 'local-chat'],
    adapter: './adapters/local-chat-adapter',
  },

 ollama: {
 displayName: 'Local Ollama',
 dedicated: true,
 url: 'http://localhost:11434',
 aliases: ['local-ollama', 'ollama-local'],
 adapter: './adapters/ollama-adapter',
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
	displayName: 'Google',
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

  return MODEL_REGISTRY[canonicalName].url;
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