// src/tool-format.js — what to do when a model ignores the canonical format.
//
// The parser tolerates five shapes because models drift: `<tool_call>{json}`
// (canonical), a ```tool_call fence, bare JSON, function-call style, and plain
// text. Tolerance keeps weak models working. It also hides a real problem: a
// model that NEVER follows the contract is indistinguishable from one that
// always does, and the work still gets done, so nobody notices.
//
// This module makes the decision explicit and testable:
//
//   canonical  -> execute
//   tolerated  -> refuse, ask for the canonical form, retry a bounded number
//                 of times, then fail with the format the model kept using
//
// The refusal is the point. Either the model complies on the next turn — which
// is the common case, models respond well to a precise correction — or the run
// fails with a message that names the problem instead of quietly papering over
// it.
'use strict';

/** The one format the prompt asks for. */
const CANONICAL = 'xml';

/** Shapes that carry a tool call but are not the canonical one. */
const TOLERATED = Object.freeze(['fence', 'json', 'function']);

/** Turn types that are complete answers, not tool calls. */
const ANSWER_TYPES = Object.freeze(['text', 'final', 'task_complete']);

/** How many times to ask before giving up. */
const DEFAULT_MAX_REFUSALS = 2;

/**
 * Is this a tool call in a shape the prompt did not ask for?
 *
 * @param {object|null} parsed
 * @returns {boolean}
 */
function isToleratedToolCall(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.type !== 'tool_call' && parsed.type !== 'tool_batch') return false;
  return TOLERATED.includes(parsed.strategy);
}

/**
 * Decide what to do with a parsed response.
 *
 * Pure: no clock, no I/O, no logging. The caller does the acting.
 *
 * @param {object|null} parsed          result of parseResponse()
 * @param {object} [opts]
 * @param {boolean} [opts.strict]       STRICT_TOOL_FORMAT; false restores tolerance
 * @param {number} [opts.refusals]      how many times this run already refused
 * @param {number} [opts.maxRefusals]
 * @returns {{action: 'execute'|'correct'|'fail'|'answer', message: string|null, strategy: string}}
 */
function verdictFor(parsed, opts = {}) {
  const strict = opts.strict !== false;
  const refusals = Number.isFinite(opts.refusals) ? opts.refusals : 0;
  const maxRefusals = Number.isFinite(opts.maxRefusals) ? opts.maxRefusals : DEFAULT_MAX_REFUSALS;

  const strategy = (parsed && parsed.strategy) || 'none';
  const isAnswer = parsed && ANSWER_TYPES.includes(parsed.type);

  if (isAnswer) {
    return { action: 'answer', message: null, strategy };
  }

  if (!isToleratedToolCall(parsed)) {
    return { action: 'execute', message: null, strategy };
  }

  // A tolerated shape. With strict mode off it executes, as it always did.
  if (!strict) {
    return { action: 'execute', message: null, strategy };
  }

  if (refusals >= maxRefusals) {
    return {
      action: 'fail',
      message:
        `The model repeatedly sent tool calls in a non-canonical format ` +
        `(${strategy}${parsed && parsed.name ? `, for "${parsed.name}"` : ''}). ` +
        `Expected <tool_call>{"tool": "...", "args": {...}}</tool_call> and nothing else. ` +
        `Set STRICT_TOOL_FORMAT=false to accept the tolerated format instead.`,
      strategy,
    };
  }

  return {
    action: 'correct',
    message: buildCorrection(strategy, parsed),
    strategy,
  };
}

/**
 * The correction sent back to the model.
 *
 * Names the format it used, so the model can see what to change, and repeats the
 * exact target — a correction that only says "wrong format" gets another wrong
 * format.
 *
 * @param {string} strategy
 * @param {object|null} parsed
 * @returns {string}
 */
function buildCorrection(strategy, parsed) {
  const used = {
    fence: 'a markdown code fence (```tool_call … ```)',
    json: 'a bare JSON object with no <tool_call> tags',
    function: 'function-call style (tool_name(key="value"))',
  }[strategy] || `an unrecognised format (${strategy})`;

  const name = parsed && parsed.name ? parsed.name : 'the tool you intended';

  return [
    `Your last reply used ${used}. That format is not accepted.`,
    '',
    'Re-send the same call, exactly like this and with nothing else in the reply:',
    '',
    '<tool_call>',
    `{"tool": "${name}", "args": { /* the same arguments */ }}`,
    '</tool_call>',
    '',
    'No prose, no code fence, no explanation before or after.',
  ].join('\n');
}

module.exports = {
  CANONICAL,
  TOLERATED,
  ANSWER_TYPES,
  DEFAULT_MAX_REFUSALS,
  isToleratedToolCall,
  verdictFor,
  buildCorrection,
};
