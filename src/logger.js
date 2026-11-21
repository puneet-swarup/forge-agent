'use strict';

const { TUI, color, colors, stripAnsi } = require('./tui');

/**
 * Join a message with any extra arguments.
 *
 * `logger.warn('[Gemini] Navigation fallback:', err.message)` used to drop
 * everything after the first argument, so the operator saw a warning with no
 * reason attached. Arguments are joined instead of discarded.
 */
function joinArgs(msg, rest) {
  if (!rest || rest.length === 0) return msg;
  const extra = rest.filter((r) => r !== undefined && r !== null && r !== '');
  return extra.length ? [msg, ...extra].join(' ') : msg;
}

// Module-level TUI instance (shared across all imports)
let _tui = null;
let _config = {};

function getTUI() {
  if (!_tui) {
    _tui = new TUI({
      compact : _config.COMPACT_OUTPUT || false,
      noColor : !process.stdout.isTTY || process.env.NO_COLOR !== undefined || _config.NO_COLOR || _config.NO_TUI,
      debug   : _config.DEBUG || false,
    });
  }
  return _tui;
}

// Allow external code to reinitialise TUI with config
function initTUI(config = {}) {
  _config = config;
  _tui    = new TUI({
    compact : config.COMPACT_OUTPUT || false,
    noColor : !process.stdout.isTTY || process.env.NO_COLOR !== undefined || config.NO_COLOR || config.NO_TUI,
    debug   : config.DEBUG || false,
  });
  return _tui;
}

// Keep TUI instance in sync with latest config
function updateTUIConfig(config = {}) {
  _config = { ..._config, ...config };
  const tui = getTUI();
  if (config.COMPACT_OUTPUT !== undefined) tui.compact = config.COMPACT_OUTPUT;
  if (config.DEBUG !== undefined)          tui.debug   = config.DEBUG;
  if (config.NO_TUI !== undefined || config.NO_COLOR !== undefined) {
    tui.noColor = !process.stdout.isTTY || process.env.NO_COLOR !== undefined || config.NO_COLOR || config.NO_TUI;
  }
}

// Called when config changes to keep TUI in sync
function updateRunContext(config) {
  const tui = getTUI();
  if (tui && tui.setRunContext) {
    tui.setRunContext({
      model   : config.MODEL    || 'deepseek',
      profile : config.ACTIVE_PROFILE || 'default',
      maxSteps: config.MAX_ITERATIONS || 100,
    });
  }
}

const logger = {
  // ── TUI management ──────────────────────────────────────────────────────
  initTUI,
  updateTUIConfig,
  updateRunContext,
  getTUI,

  // ── Core messages ────────────────────────────────────────────────────────
  banner()        { getTUI().banner(); },
  info(msg)       { getTUI().info(msg); },
  success(msg)    { getTUI().success(msg); },
  warn(msg, ...rest)   { getTUI().warn(joinArgs(msg, rest)); },
  error(msg)      { getTUI().error(msg); },
  dim(msg)        { getTUI().dim(msg); },
  answer(text)    { getTUI().renderAnswer(text); },
  separator(label){ getTUI().separator(label); },

  // ── Task lifecycle ────────────────────────────────────────────────────────
  header(task, opts = {}) {
    getTUI().renderTaskHeader(task, opts);
  },

  iteration(n, max) {
    // Legacy compatibility — use renderStepLine
    getTUI().renderStepLine(n, 0, null, max);
  },

  // ── Tool display ──────────────────────────────────────────────────────────
  toolCall(name, args) {
    getTUI().renderToolCall(name, args);
  },

  toolResult(result, isError = false, toolName = '') {
    getTUI().renderToolResult(toolName, result, isError);
  },

  // ── AI interaction ────────────────────────────────────────────────────────
  thinking(elapsedMs, charsReceived) {
    // A string here is a status message, not a duration — see TUI.renderThinking.
    getTUI().renderThinking(
      typeof elapsedMs === 'string' ? elapsedMs : elapsedMs,
      charsReceived
    );
  },

  clearThinking() {
    getTUI().clearThinking();
  },

  waiting(elapsedMs, charsReceived, model) {
    getTUI().renderWaiting(elapsedMs, charsReceived, model);
  },

  clearWaiting() {
    getTUI().clearWaiting();
  },

  // ── Completion ────────────────────────────────────────────────────────────
  // Accepted signatures (ARCHITECTURE s.10.4):
  //   finalOutput(string)               -> plain completion text
  //   finalOutput(progressTracker, status) -> rich completion panel
  // Null/undefined are handled defensively so a stray call never throws.
  finalOutput(progress, status, opts = {}) {
    // Legacy / plain-string path.
    if (typeof progress === 'string') {
      if (progress) console.log(progress);
      return;
    }
    // Nullish guard: nothing to render.
    if (progress == null) return;
    // Rich path: a ProgressTracker (or tracker-like object). `opts` carries the
    // facts the tracker does not know — the verification result and the model.
    getTUI().renderCompletion(progress, status, opts);
  },

  // ── Context meter ─────────────────────────────────────────────────────────
  contextMeter(used, max) {
    getTUI().renderContextMeter(used, max);
  },

  // ── Health check ──────────────────────────────────────────────────────────
  healthCheck(checks) {
    getTUI().renderHealthCheck(checks);
  },

  // ── Error display ─────────────────────────────────────────────────────────
  renderError(err) {
    getTUI().renderError(err);
  },

  // ── Step line (used in agent loop) ────────────────────────────────────────
  stepLine(stepNum, elapsedMs, progress, descriptor) {
    getTUI().renderStepLine(stepNum, elapsedMs, progress, descriptor);
  },

  // ── Clearline (for overwrite-style output) ────────────────────────────────
  clearLine() {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${' '.repeat(80)}\r`);
    }
  },
};

module.exports = logger;
