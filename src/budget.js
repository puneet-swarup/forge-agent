// src/budget.js — the run's resource envelope.
//
// Why this exists
// ---------------
// The loop's only circuit breaker was a literal `if (step > 10000)`. The
// documented `MAX_ITERATIONS` setting was read for display and settable via
// /iterations, but no execution path consulted it, and `--max-iterations` was
// printed in the help text and never parsed. With the default inter-prompt
// pause, a runaway run was measured in hours.
//
// A Budget is created once per run and ticked at the top of every iteration.
// Exceeding it is a normal, reportable end state (a partial summary), not a
// crash.
'use strict';

const DEFAULTS = Object.freeze({
  MAX_ITERATIONS: 100,
  MAX_RUNTIME_MS: 0,     // 0 = no wall-clock limit
  MAX_TOOL_CALLS: 0,     // 0 = no tool-call limit
});

class BudgetExceeded extends Error {
  /**
   * @param {'steps'|'runtime'|'tool_calls'} kind
   * @param {number} limit
   * @param {number} used
   */
  constructor(kind, limit, used) {
    const human = {
      steps: `step limit reached (${used}/${limit})`,
      runtime: `time limit reached (${Math.round(used / 1000)}s of ${Math.round(limit / 1000)}s)`,
      tool_calls: `tool-call limit reached (${used}/${limit})`,
    }[kind];

    super(`Run stopped: ${human}`);
    this.name = 'BudgetExceeded';
    this.kind = kind;
    this.limit = limit;
    this.used = used;
    this.retryable = false;
  }
}

class Budget {
  /**
   * @param {object} [cfg]  reads MAX_ITERATIONS / MAX_RUNTIME_MS / MAX_TOOL_CALLS
   */
  constructor(cfg = {}) {
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    this.maxSteps     = num(cfg.MAX_ITERATIONS, DEFAULTS.MAX_ITERATIONS);
    this.maxRuntimeMs = num(cfg.MAX_RUNTIME_MS, DEFAULTS.MAX_RUNTIME_MS);
    this.maxToolCalls = num(cfg.MAX_TOOL_CALLS, DEFAULTS.MAX_TOOL_CALLS);

    this.steps     = 0;
    this.toolCalls = 0;
    this.startedAt = Date.now();
  }

  /**
   * Count one loop iteration and enforce every limit.
   * `steps` counts iterations that were ALLOWED to run, so after the budget
   * throws it still reads as the limit that was reached.
   */
  tick() {
    if (this.steps + 1 > this.maxSteps) {
      throw new BudgetExceeded('steps', this.maxSteps, this.steps);
    }
    this.steps++;
    if (this.maxRuntimeMs > 0) {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed > this.maxRuntimeMs) {
        throw new BudgetExceeded('runtime', this.maxRuntimeMs, elapsed);
      }
    }
  }

  /** Count executed tool calls and enforce the tool-call limit. */
  recordToolCalls(n = 1) {
    this.toolCalls += n;
    if (this.maxToolCalls > 0 && this.toolCalls > this.maxToolCalls) {
      throw new BudgetExceeded('tool_calls', this.maxToolCalls, this.toolCalls - 1);
    }
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  /** Fraction of the step budget used, 0..1. */
  usedFraction() {
    return this.maxSteps > 0 ? Math.min(1, this.steps / this.maxSteps) : 0;
  }

  /** Short human summary, e.g. "12/100 steps · 340s". */
  describe() {
    const parts = [`${this.steps}/${this.maxSteps} steps`];
    if (this.maxRuntimeMs > 0) {
      parts.push(`${Math.round(this.elapsedMs() / 1000)}/${Math.round(this.maxRuntimeMs / 1000)}s`);
    }
    if (this.maxToolCalls > 0) {
      parts.push(`${this.toolCalls}/${this.maxToolCalls} tools`);
    }
    return parts.join(' · ');
  }
}

module.exports = { Budget, BudgetExceeded, DEFAULTS };
