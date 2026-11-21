// src/throttle.js — reactive rate-limit backoff.
//
// Why this exists
// ---------------
// The agent used to sleep a random 10-20 s before EVERY prompt ("anti-block").
// On a 60-step task that is 10-20 minutes of pure waiting, paid whether or not
// the provider is throttling, and it does not help when the provider actually
// does throttle, because the pause has nothing to do with the response.
//
// This module replaces the fixed tax with a reactive one: watch the reply for a
// rate-limit signal, and only then back off, exponentially and briefly.
'use strict';

/**
 * Unambiguous throttle notices: these mean "stop sending" and nothing else.
 * Case-insensitive; the Chinese patterns cover DeepSeek / Qwen.
 */
const HARD_PATTERNS = [
  /too many requests/i,
  /you(?:'| a)re (?:sending messages too quickly|going too fast)/i,
  /(?:usage|message|daily|hourly|free tier) limit (?:reached|exceeded|for this)/i,
  /you(?:'ve| have) reached (?:the|your) (?:[\w-]+ )?(?:limit|quota|maximum)/i,
  /temporarily (?:unavailable|blocked|rate.?limited)/i,
  /请求(?:过于|太)频繁/,        // zh — DeepSeek / Qwen
  /请求次数(?:过多|超限)/,
];

/**
 * Ambiguous phrasing. A coding agent talks about rate limits constantly ("I
 * added rate limit handling"), so these only count when the reply also carries
 * an error-ish signal — otherwise a normal answer would trigger a backoff.
 */
const SOFT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /try again (?:later|in a (?:few|couple of) (?:seconds|minutes))/i,
  /slow down/i,
];

const SOFT_CO_SIGNAL =
  /(?:exceeded|reached|hit|blocked|error|429|retry|wait|please|throttl|quota)/i;

const DEFAULTS = Object.freeze({
  baseMs: 5_000,
  maxMs: 60_000,
  factor: 2,
  maxAttempts: 4,
});

class Throttle {
  /**
   * @param {object} [opts]
   * @param {number} [opts.baseMs]      first backoff
   * @param {number} [opts.maxMs]       cap
   * @param {number} [opts.factor]      multiplier per attempt
   * @param {number} [opts.maxAttempts] consecutive throttles before giving up
   * @param {RegExp[]} [opts.patterns]  override the signal list
   */
  constructor(opts = {}) {
    this.baseMs = num(opts.baseMs, DEFAULTS.baseMs);
    this.maxMs = num(opts.maxMs, DEFAULTS.maxMs);
    this.factor = num(opts.factor, DEFAULTS.factor);
    this.maxAttempts = num(opts.maxAttempts, DEFAULTS.maxAttempts);
    this.patterns = Array.isArray(opts.patterns) && opts.patterns.length
      ? opts.patterns
      : HARD_PATTERNS;
    this.softPatterns = Array.isArray(opts.softPatterns) && opts.softPatterns.length
      ? opts.softPatterns
      : SOFT_PATTERNS;

    this.attempts = 0;
    this.lastDelayMs = 0;
  }

  /**
   * Does this reply look like a throttle rather than an answer?
   * Only the first 2,000 characters are inspected: a long legitimate answer
   * that happens to mention "rate limit" should not trigger a backoff.
   *
   * @param {string} text
   * @returns {boolean}
   */
  detect(text) {
    if (typeof text !== 'string' || !text) return false;
    const head = text.slice(0, 2000);

    if (this.patterns.some((re) => re.test(head))) return true;

    // Ambiguous phrasing only counts when something also looks like an error.
    const soft = this.softPatterns.some((re) => re.test(head));
    return soft && SOFT_CO_SIGNAL.test(head);
  }

  /**
   * Record a throttle and return how long to wait.
   * Returns -1 when the attempt budget is exhausted — the caller should then
   * stop treating this as retryable and let the normal stall handling run.
   *
   * @returns {number} milliseconds to wait, or -1 when out of attempts
   */
  nextDelayMs() {
    this.attempts++;

    if (this.attempts > this.maxAttempts) {
      this.lastDelayMs = 0;
      return -1;
    }

    const raw = this.baseMs * Math.pow(this.factor, this.attempts - 1);
    const delay = Math.min(this.maxMs, Math.round(raw));
    this.lastDelayMs = delay;
    return delay;
  }

  /** A normal reply arrived: the provider is no longer throttling us. */
  noteSuccess() {
    this.attempts = 0;
    this.lastDelayMs = 0;
  }

  /** Human summary for logs, e.g. "throttled, attempt 2/4". */
  describe() {
    return `throttled, attempt ${this.attempts}/${this.maxAttempts}`;
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { Throttle, HARD_PATTERNS, SOFT_PATTERNS, DEFAULTS };
