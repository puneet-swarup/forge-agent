// src/planner.js — Task planning module
'use strict';

/**
 * Build the prompt asking the AI to generate a numbered plan.
 */
function buildPlanningPrompt(task) {
  return `Before executing, create a numbered plan for this task:

TASK: ${task}

Respond with ONLY a numbered plan in this format:
PLAN:
1. [specific action]
2. [specific action]
...

Do not start executing yet. Just output the plan.
Aim for 5-10 concrete steps. The last step should always be running tests.`;
}

/**
 * Parse the AI's plan response into a structured object.
 */
function parsePlan(text) {
  if (!text) return { steps: [], raw: '' };

  const steps = [];
  const lines = String(text).split('\n');

  // Models format plans differently. Accept the shapes that appear in practice
  // rather than only "1. step", which was strict enough that a real Gemini plan
  // was rejected outright:
  //   1. step        1) step        Step 1: step
  //   - step         * step         **1.** step
  //   1. **step**    • step
  const NUMBERED = /^\s*(?:\*\*)?(\d+)[.)\]]?(?:\*\*)?\s*[:\-–]?\s+(.*)$/;
  const BULLET   = /^\s*[-*•]\s+(.*)$/;
  const STEPWORD = /^\s*step\s*\d+\s*[:\-–]\s*(.*)$/i;

  for (const line of lines) {
    let match = line.match(NUMBERED) || line.match(STEPWORD) || line.match(BULLET);
    if (!match) continue;

    // The numbered regex captures the text in group 2; the others in group 1.
    let step = (match[2] !== undefined ? match[2] : match[1]) || '';
    step = step.replace(/\*\*/g, '').trim();

    // Skip headings and empty fragments.
    if (!step || /^plan\b/i.test(step) || step.length < 3) continue;

    steps.push(step);
  }

  return {
    steps,
    raw: text
  };
}

/**
 * Format the plan for terminal display.
 */
function formatPlanDisplay(plan) {
  if (!plan || !plan.steps || plan.steps.length === 0) {
    return '  (No valid steps found in plan)';
  }

  const lines = plan.steps.map((step, i) => `  \x1b[36m${i + 1}.\x1b[0m ${step}`);
  return [
    '\x1b[1m\x1b[35mProposed Execution Plan:\x1b[0m',
    ...lines,
    ''
  ].join('\n');
}

/**
 * Legacy compatibility
 */
function buildPlanPrompt(task) { return buildPlanningPrompt(task); }
function formatPlanForDisplay(steps) { return formatPlanDisplay({ steps }); }
function formatPlanForContext(steps) {
  if (!steps || steps.length === 0) return '';
  const list = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `Your established plan:\n${list}\n\nPlease proceed with Step 1.`;
}
function isPlanResponse(text) {
  if (!text) return false;
  return text.includes('PLAN:') || /^\s*1\.\s+/.test(text);
}

module.exports = {
  buildPlanningPrompt,
  parsePlan,
  formatPlanDisplay,
  // Legacy exports
  buildPlanPrompt,
  formatPlanForDisplay,
  formatPlanForContext,
  isPlanResponse
};