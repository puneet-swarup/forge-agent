'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const paths = require('./paths');

// ─────────────────────────────────────────────
//  Minimal zero-dependency .env loader
//  Loaded once, before DEFAULTS / file overrides are read, so that
//  OLLAMA_BASE_URL / OLLAMA_API_KEY etc. can live in a gitignored .env
//  instead of being hard-coded in the adapter. Real environment variables
//  always win over .env files.
// ─────────────────────────────────────────────
function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    paths.resolveExisting('.env'),
  ].filter(Boolean);

  const seen = new Set();

  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);

    let raw;
    try {
      if (!fs.existsSync(file)) continue;
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

loadDotEnv();

// ─────────────────────────────────────────────
//  Default values
// ─────────────────────────────────────────────

const DEFAULTS = {
  // AI Model
  MODEL              : 'deepseek',
  DEEPSEEK_URL       : 'https://chat.deepseek.com',

  // Local / Colab (Ollama-compatible) adapter.
  // Populate via CLI flags (--model-url / --api-key), a .env file, or
  // forge-agent.config.json — no need to edit the adapter source.
  OLLAMA_BASE_URL    : process.env.OLLAMA_BASE_URL || '',
  OLLAMA_API_KEY     : process.env.OLLAMA_API_KEY  || '',
  OLLAMA_MODEL       : process.env.OLLAMA_MODEL    || 'deepseek-r1-16k:latest',
  LOCAL_CHAT_PORT    : process.env.LOCAL_CHAT_PORT
    ? Number(process.env.LOCAL_CHAT_PORT)
    : 1337,

  // Timing (tuned for slow connections)
  RESPONSE_TIMEOUT   : 600_000,   // 10 min total wait
  STABLE_DELAY       : 1_500,     // 1.5s of silence before response is done
  SEND_DELAY         : 250,       // 0.25s after filling input (was 600ms; safe lower bound)
  GENERATION_POLL    : 400,       // poll every 400ms
  APPEAR_TIMEOUT     : 20_000,    // 20s for first chars to appear
  BROWSER_TIMEOUT    : 30_000,    // 30s for page navigation
  NAV_SETTLE_MS      : 500,       // fallback settle if selector wait fails (see browser.js)
  TOOL_TIMEOUT       : 300_000,   // 5min for shell commands
  HEALTH_CHECK_TIMEOUT: 15_000,   // 15s for health checks

  // Agent behaviour
  WORKING_DIR        : process.cwd(),
  PARALLEL_TOOL_CALLS    : true,
  MAX_PARALLEL_TOOL_CALLS: 4,
  // Audio (Items 3 & 4): async, sequentially-queued speech by default.
  AUDIO_ASYNC            : true,
  AUDIO_SEQUENTIAL       : true,
  // Anti-block: random pause between consecutive prompts.
  PROMPT_PAUSE           : true,
  PROMPT_PAUSE_MIN_MS    : 10_000,
  PROMPT_PAUSE_MAX_MS    : 20_000,
  SESSION_DIR: process.env.FORGE_SESSION_DIR
    ? path.resolve(process.env.FORGE_SESSION_DIR)
    : paths.forgePath('session'),
  // Phase 1: auto-add SESSION_CONTEXT.md to the project's .gitignore
  SESSION_CONTEXT_GITIGNORE: true,
  STRICT_SANDBOX     : false,
  MAX_OUTPUT_LENGTH  : 8_000,
  // read_file upload (default OFF - see ARCHITECTURE.md section 11)
  READ_FILE_UPLOAD           : false,
  READ_FILE_UPLOAD_MIN_BYTES : 4096,
  READ_FILE_UPLOAD_TIMEOUT_MS: 15000,

  // Browser resource optimisation (default OFF; see ARCHITECTURE.md s.13.2)
  BROWSER_BLOCK_IMAGES    : false,
  BROWSER_BLOCK_TELEMETRY : false,
 BROWSER_NO_SANDBOX : process.env.FORGE_NO_SANDBOX === '1',

  // Display
  HEADLESS           : false,

 // Chromium channel: empty = Playwright bundled Chromium (no infobars).
 // Set to 'chrome' or 'msedge' to use a locally installed browser.
 BROWSER_CHANNEL : process.env.FORGE_BROWSER_CHANNEL || '',
  DEBUG              : false,
  NO_TUI             : false,
  COMPACT_OUTPUT     : false,

  // Intelligence features
  PLANNING_MODE      : false,
  SHOW_THINKING      : false,
  ACTIVE_PROFILE     : 'default',
  CONTEXT_COMPRESSION_THRESHOLD: 80_000,
  CONTEXT_KEEP_RECENT: 6,
  SMART_TRUNCATION   : true,

  // Memory & Cache
  MEMORY_ENABLED     : true,
  MEMORY_FILE        : paths.forgePath('memory.json'),
  CACHE_ENABLED      : true,
  CACHE_TTL_MS       : 30_000,
  CACHE_MAX_ENTRIES  : 200,

  // History
  HISTORY_ENABLED    : true,
  HISTORY_FILE       : paths.forgePath('history.json'),
  HISTORY_MAX_ENTRIES: 200,

  // Plugins
  PLUGIN_DIR         : paths.forgePath('tools'),

  // Templates
  TEMPLATES_FILE     : paths.forgePath('templates.json'),

  // Output formatting
  OUTPUT_FORMAT      : 'text',
  OUTPUT_FILE        : null,
  OUTPUT_TIMESTAMP   : false,

  // Security
  ALLOW_DANGEROUS_COMMANDS: false,
  ALLOW_ENV_PLAIN_READ    : false,
  AUDIT_LOG               : false,
  PARAM_VALIDATION        : true,

  // Sponsorship
  DISABLE_SPONSOR_NUDGE   : false,
  SPONSOR_NUDGE_FILE      : paths.forgePath('sponsor-nudge.json'),

  // Docker
  DOCKER_CONTAINER   : process.env.DOCKER_CONTAINER || '',

  // Watch mode
  WATCH_DEBOUNCE_MS  : 1_000,
  WATCH_COOLDOWN_MS  : 5_000,
  WATCH_MAX_RUNS     : 0,

  // Wizard
  WIZARD_COMPLETED   : false,

  // Response Streak Thresholds
  EMPTY_RESPONSE_THRESHOLD: 4,
  PARTIAL_RESULT_THRESHOLD: 6,
};

// ─────────────────────────────────────────────
//  Config file loading
// ─────────────────────────────────────────────

function loadJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      delete parsed._comment;
      return parsed;
    }
  } catch (e) {
    // Silent fail — bad config file just uses defaults
  }
  return {};
}

const globalConfigPath  = paths.resolveExisting('config.json');
const projectConfigPath = path.join(process.cwd(), 'forge-agent.config.json');

const fileOverrides = {
  ...loadJsonSafe(globalConfigPath),
  ...loadJsonSafe(projectConfigPath),
};

// ─────────────────────────────────────────────
//  Validation
// ─────────────────────────────────────────────

function validateConfigValue(key, value) {
  const rules = {
    RESPONSE_TIMEOUT  : v => typeof v === 'number' && v >= 0,
    STABLE_DELAY      : v => typeof v === 'number' && v >= 100 && v <= 30000,
    SEND_DELAY        : v => typeof v === 'number' && v >= 100 && v <= 5000,
    GENERATION_POLL   : v => typeof v === 'number' && v >= 100 && v <= 5000,
    TOOL_TIMEOUT      : v => typeof v === 'number' && v >= 1000,
    MODEL             : v => ['deepseek','gemini','qwen','chatgpt','google','local','ollama','colab'].includes(String(v).toLowerCase()),
    OLLAMA_BASE_URL   : v => typeof v === 'string',
    OLLAMA_API_KEY    : v => typeof v === 'string',
    OLLAMA_MODEL      : v => typeof v === 'string' && v.length > 0,
    LOCAL_CHAT_PORT   : v => Number.isInteger(v) && v > 0 && v < 65536,
    ACTIVE_PROFILE    : v => ['default','backend','frontend','data-science','devops'].includes(v),
    OUTPUT_FORMAT     : v => ['text','markdown','json','json-raw','minimal','silent'].includes(v),
    HEADLESS          : v => typeof v === 'boolean',
    DEBUG             : v => typeof v === 'boolean',
    NO_TUI            : v => typeof v === 'boolean',
    MEMORY_ENABLED    : v => typeof v === 'boolean',
    CACHE_ENABLED     : v => typeof v === 'boolean',
    PLANNING_MODE     : v => typeof v === 'boolean',
    SHOW_THINKING     : v => typeof v === 'boolean',
    STRICT_SANDBOX    : v => typeof v === 'boolean',
    PARALLEL_TOOL_CALLS    : v => typeof v === 'boolean',
    MAX_PARALLEL_TOOL_CALLS: v => Number.isInteger(v) && v >= 1 && v <= 32,
    AUDIO_ASYNC            : v => typeof v === 'boolean',
    AUDIO_SEQUENTIAL       : v => typeof v === 'boolean',
    PROMPT_PAUSE           : v => typeof v === 'boolean',
    PROMPT_PAUSE_MIN_MS    : v => typeof v === 'number' && v >= 0,
    PROMPT_PAUSE_MAX_MS    : v => typeof v === 'number' && v >= 0,
  };

  if (rules[key]) {
    return rules[key](value);
  }
  return true; // unknown keys pass through
}

// ─────────────────────────────────────────────
//  Reactive config using Proxy
// ─────────────────────────────────────────────

const _subscribers = new Map(); // key → Set<callback>
const _changeLog   = [];        // { key, oldValue, newValue, timestamp, source }
const _sessionOverrides = {};   // changes made during this session (slash commands)

const _raw = {
  ...DEFAULTS,
  ...fileOverrides,
};

// Ensure directories exist
try {
  fs.mkdirSync(path.dirname(_raw.SESSION_DIR), { recursive: true });
  fs.mkdirSync(_raw.SESSION_DIR,               { recursive: true });
  fs.mkdirSync(paths.forgePath('logs'), { recursive: true });
} catch {}

// Fix non-absolute WORKING_DIR
if (_raw.WORKING_DIR && !path.isAbsolute(_raw.WORKING_DIR)) {
  _raw.WORKING_DIR = path.resolve(process.cwd(), _raw.WORKING_DIR);
}

// The Proxy intercepts all reads and writes
const config = new Proxy(_raw, {
  get(target, key) {
    return target[key];
  },

  set(target, key, value) {
    if (typeof key === 'string') {
      if (!validateConfigValue(key, value)) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn(`[forge-agent] Invalid value for ${key}: ${JSON.stringify(value)} — ignored`);
        }
        return true; // return true to avoid TypeError, but don't set
      }

      const oldValue = target[key];
      target[key]    = value;

      // Track session override (skip functions and internal keys added during module export)
      const isConfigKey = key in DEFAULTS || (typeof value !== 'function' && !['_raw', 'DEFAULTS'].includes(key));
      if (isConfigKey && typeof value !== 'function' && !['_raw', 'DEFAULTS'].includes(key)) {
        _sessionOverrides[key] = value;

        // Record in change log
        _changeLog.push({
          key,
          oldValue,
          newValue  : value,
          timestamp : Date.now(),
          source    : 'session',
        });
      }

      // Notify subscribers
      if (_subscribers.has(key)) {
        _subscribers.get(key).forEach(cb => {
          try { cb(value, oldValue, key); } catch {}
        });
      }
      // Notify wildcard subscribers ('*')
      if (_subscribers.has('*')) {
        _subscribers.get('*').forEach(cb => {
          try { cb(value, oldValue, key); } catch {}
        });
      }
    } else {
      target[key] = value;
    }

    return true;
  },
});

// ─────────────────────────────────────────────
//  Subscription API
// ─────────────────────────────────────────────

/**
 * Subscribe to config changes.
 * @param {string|string[]} keys — key(s) to watch, or '*' for all
 * @param {Function} callback — (newValue, oldValue, key) => void
 * @returns {Function} unsubscribe function
 */
function onConfigChange(keys, callback) {
  const keyList = keys === '*' ? ['*'] : (Array.isArray(keys) ? keys : [keys]);
  keyList.forEach(key => {
    if (!_subscribers.has(key)) _subscribers.set(key, new Set());
    _subscribers.get(key).add(callback);
  });
  return () => keyList.forEach(key => _subscribers.get(key)?.delete(callback));
}

/**
 * Apply multiple config changes at once (batched — fires subscribers once per key).
 */
function setConfig(updates) {
  Object.entries(updates).forEach(([key, value]) => {
    config[key] = value;
  });
}

/**
 * Get the session overrides (changes made since startup).
 */
function getSessionOverrides() {
  return { ..._sessionOverrides };
}

/**
 * Get the full change log for this session.
 */
function getChangeLog() {
  return [..._changeLog];
}

/**
 * Reset a key to its default value.
 */
function resetToDefault(key) {
  if (key in DEFAULTS) {
    config[key] = DEFAULTS[key];
  }
}

/**
 * Reset all session overrides to defaults/file values.
 */
function resetAllToDefaults() {
  Object.keys(_sessionOverrides).forEach(key => {
    const fileVal = fileOverrides[key];
    config[key]   = fileVal !== undefined ? fileVal : DEFAULTS[key];
  });
  // Clear overrides after reset
  for (const key in _sessionOverrides) delete _sessionOverrides[key];
}

/**
 * Save current session overrides to the global config file.
 */
function saveSessionOverrides() {
  try {
    const existing = loadJsonSafe(globalConfigPath);
    const merged   = { ...existing, ..._sessionOverrides };
    delete merged._comment;
    fs.writeFileSync(globalConfigPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return { saved: true, path: globalConfigPath };
  } catch (e) {
    return { saved: false, error: e.message };
  }
}

// ─────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────

// Native structural parameter sync: Ensure command-line arguments override hardcoded profile settings.
try {
  const processArgs = process.argv;
  
  // 1. Check for manual inline model assignment flags (--model=XYZ)
  const modelMatch = processArgs.find(arg => arg.startsWith('--model='));
  if (modelMatch) {
    const passedModel = modelMatch.split('=')[1].toLowerCase().trim();
    if (['deepseek', 'gemini', 'qwen', 'chatgpt', 'google', 'local', 'ollama', 'colab'].includes(passedModel)) {
      _raw.MODEL = passedModel;
    }
  }

  // 2. Early sync of local/Colab adapter flags (--model-url / --api-key /
  //    --local-model / --local-port), both "=" and space-separated forms.
  //    Kept in sync with applyFlagsToConfig() in index.js.
  const readFlag = (names) => {
    for (const n of names) {
      const inline = processArgs.find(a => a.startsWith(n + '='));
      if (inline) return inline.slice(n.length + 1);
      const idx = processArgs.indexOf(n);
      if (idx !== -1 && processArgs[idx + 1] && !processArgs[idx + 1].startsWith('-')) {
        return processArgs[idx + 1];
      }
    }
    return null;
  };

  const urlFlag = readFlag(['--model-url', '--ollama-url']);
  if (urlFlag) {
    _raw.OLLAMA_BASE_URL = urlFlag.trim();
    process.env.OLLAMA_BASE_URL = _raw.OLLAMA_BASE_URL;
  }

  const keyFlag = readFlag(['--api-key', '--ollama-api-key']);
  if (keyFlag) {
    _raw.OLLAMA_API_KEY = keyFlag.trim();
    process.env.OLLAMA_API_KEY = _raw.OLLAMA_API_KEY;
  }

  const lmFlag = readFlag(['--local-model']);
  if (lmFlag) {
    _raw.OLLAMA_MODEL = lmFlag.trim();
    process.env.OLLAMA_MODEL = _raw.OLLAMA_MODEL;
  }

  const lpFlag = readFlag(['--local-port']);
  if (lpFlag) {
    const port = Number(lpFlag);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      _raw.LOCAL_CHAT_PORT = port;
    }
  }

  // 3. Check for manual calibration invocation flags (--calibrate)
  if (processArgs.includes('--calibrate')) {
    _raw.PLANNING_MODE = false; // Safeguard calibration execution runs
  }
} catch (err) {
  // Safe operational boundary check fallback
}

// The config proxy is the default export (backward compatible)
module.exports = config;

// Additional named exports for the reactive API
module.exports.onConfigChange    = onConfigChange;
module.exports.setConfig         = setConfig;
module.exports.getSessionOverrides = getSessionOverrides;
module.exports.getChangeLog      = getChangeLog;
module.exports.resetToDefault    = resetToDefault;
module.exports.resetAllToDefaults= resetAllToDefaults;
module.exports.saveSessionOverrides = saveSessionOverrides;
module.exports.DEFAULTS          = DEFAULTS;
module.exports._raw              = _raw; // for testing
