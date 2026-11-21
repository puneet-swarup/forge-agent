'use strict';
// src/loom/config.js — environment parsing for Loom.
//
// Spec: src/loom_specs.md §11. Two rules, both merge blockers in practice:
//   * never throw on config — a bad value warns, names itself, and falls back;
//   * LOOM_ENABLED=0 is a real kill switch, so parsing must be cheap and
//     side-effect free (I2: no I/O, no allocation beyond the call frame).

const DEFAULTS = Object.freeze({
  enabled          : true,
  dir              : null,
  digestTokens     : 1200,
  maxFiles         : 2000,
  maxFileBytes     : 512000,
  modelSummaries   : false,
  summaryModel     : 'ollama',
  worker           : true,
  watch            : false,
  heatHalfLifeDays : 14,
  rebuildThreshold : 0.3,
  rehashDays       : 7,
});

// Declared in spec order so `describe()` and the docs read the same way.
const SPEC = Object.freeze([
  { key: 'enabled',          env: 'LOOM_ENABLED',            kind: 'bool' },
  { key: 'dir',              env: 'LOOM_DIR',                kind: 'path' },
  { key: 'digestTokens',     env: 'LOOM_DIGEST_TOKENS',      kind: 'int',   min: 200, max: 8000 },
  { key: 'maxFiles',         env: 'LOOM_MAX_FILES',          kind: 'int',   min: 1, max: 100000 },
  { key: 'maxFileBytes',     env: 'LOOM_MAX_FILE_BYTES',     kind: 'int',   min: 1024, max: 10000000 },
  { key: 'modelSummaries',   env: 'LOOM_MODEL_SUMMARIES',    kind: 'bool' },
  { key: 'summaryModel',     env: 'LOOM_SUMMARY_MODEL',      kind: 'string' },
  { key: 'worker',           env: 'LOOM_WORKER',             kind: 'bool' },
  { key: 'watch',            env: 'LOOM_WATCH',              kind: 'bool' },
  { key: 'heatHalfLifeDays', env: 'LOOM_HEAT_HALFLIFE_DAYS', kind: 'int',   min: 1, max: 365 },
  { key: 'rebuildThreshold', env: 'LOOM_REBUILD_THRESHOLD',  kind: 'float', min: 0.05, max: 1 },
  { key: 'rehashDays',       env: 'LOOM_REHASH_DAYS',        kind: 'int',   min: 1, max: 365 },
]);

// One warn per (variable, value) per process. A config mistake should be
// visible once, not once per refresh.
const _warned = new Set();

function warnOnce(env, value, message) {
  const key = `${env}=${value}`;
  if (_warned.has(key)) return;
  _warned.add(key);
  try {
    const logger = require('../logger');
    logger.warn(message);
  } catch (_) {
    // A logger that is not initialised must not break config parsing.
  }
}

function invalid(spec, raw, reason) {
  const message = `[Loom] ${spec.env}="${raw}" is invalid (${reason}); using default ${JSON.stringify(DEFAULTS[spec.key])}`;
  warnOnce(spec.env, raw, message);
  return { ok: false, value: DEFAULTS[spec.key], warning: message };
}

function parseBool(spec, raw) {
  if (raw === '0' || raw === 'false') return { ok: true, value: false };
  if (raw === '1' || raw === 'true') return { ok: true, value: true };
  return invalid(spec, raw, 'expected 0 or 1');
}

function parseNumber(spec, raw, integer) {
  const trimmed = String(raw).trim();
  if (trimmed === '') return invalid(spec, raw, 'expected a number');
  const n = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) return invalid(spec, raw, 'expected a number');
  if (integer && !/^[+-]?\d+$/.test(trimmed)) return invalid(spec, raw, 'expected an integer');
  if (spec.min !== undefined && n < spec.min) return invalid(spec, raw, `must be >= ${spec.min}`);
  if (spec.max !== undefined && n > spec.max) return invalid(spec, raw, `must be <= ${spec.max}`);
  return { ok: true, value: n };
}

function parseValue(spec, raw) {
  switch (spec.kind) {
    case 'bool'  : return parseBool(spec, raw);
    case 'int'   : return parseNumber(spec, raw, true);
    case 'float' : return parseNumber(spec, raw, false);
    case 'path'  : return { ok: true, value: String(raw) };
    default      : return { ok: true, value: String(raw) };
  }
}

/**
 * Parse Loom configuration from an environment object.
 *
 * Never throws. Every invalid value is reported in `warnings` and replaced by
 * the default.
 *
 * @param {Record<string, string|undefined>} [env] environment (default: process.env)
 * @param {{ silent?: boolean }} [opts] `silent` suppresses the logger
 * @returns {typeof DEFAULTS & { warnings: string[] }}
 */
function load(env = process.env, opts = {}) {
  const silent = opts.silent === true;
  const out = { ...DEFAULTS, warnings: [] };
  const source = env || {};

  for (const spec of SPEC) {
    const raw = source[spec.env];
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = parseValue(spec, raw);
    if (!parsed.ok) {
      if (!silent) warnOnce(spec.env, raw, parsed.warning);
      out.warnings.push(parsed.warning);
      continue;
    }
    out[spec.key] = parsed.value;
  }

  return out;
}

/** The env var names Loom reads, in order. Used by `--loom doctor` and docs. */
function envNames() {
  return SPEC.map((s) => s.env);
}

/** Reset the warn-once cache. Test helper. */
function resetWarnings() {
  _warned.clear();
}

module.exports = { DEFAULTS, SPEC, load, envNames, resetWarnings };
