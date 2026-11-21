// src/prompt.js — conversation state, plus the first-message assembly.
//
// This module used to contain a SECOND, different system prompt (fenced
// ```tool_call blocks, no response envelope, no artifact protocol) while
// src/system-prompt.js held the one the tests validated. agent.js sent this
// one, so the model was scored against a contract it had never seen.
//
// There is now one builder: src/system-prompt.js. This module owns only the
// conversation: the message array, token estimates, compression, and the
// wrapper that turns a task into the first message of a new chat.
'use strict';

const { buildSystemPrompt } = require('./system-prompt');
const { estimateTokenCount, shouldCompress, compressConversation } = require('./compressor');

// Re-exported so older importers keep working. There is exactly one
// implementation — see tests/prompt-single-source.test.js.
const { buildToolDocumentation, buildToolResultMessage, buildPlanningPrompt } = require('./system-prompt');

/**
 * Assemble the first message of a chat: system prompt + directory listing +
 * the user's task.
 *
 * @param {string} task
 * @param {string|null} workingDirListing
 * @param {string} profileName
 * @param {string} profileAddition  extra profile text (kept for callers that
 *                                  add their own; appended after the prompt)
 * @param {object} [options]        { projectContext, planMode, workingDir }
 * @returns {string}
 */
function buildFirstMessage(task, workingDirListing, profileName = 'default', profileAddition = '', options = {}) {
  const systemPrompt = buildSystemPrompt({
    profile: profileName === 'default' ? '' : profileName,
    projectContext: options.projectContext || '',
    planMode: !!options.planMode,
    workingDir: options.workingDir || process.cwd(),
  });

  const dirContext = workingDirListing
    ? '\nCURRENT WORKING DIRECTORY CONTENTS:\n' + workingDirListing + '\n\n' +
      'NOTE: the listing above is current. Do NOT call list_directory as your\n' +
      'first action. Call it later only if you have created or deleted files\n' +
      'and need to confirm the result.\n'
    : '';

  return [
    systemPrompt,
    profileAddition ? '\n' + profileAddition : '',
    '',
    '═'.repeat(60),
    '',
    dirContext,
    'USER TASK:',
    '──────────',
    task,
  ].join('\n');
}

class ConversationManager {
  constructor() {
    this.messages = [];
    this._systemPrompt = null;
  }

  buildFirstMessage(task, workingDirListing, profileName = 'default', profileAddition = '', options = {}) {
    const firstMessage = buildFirstMessage(
      task, workingDirListing, profileName, profileAddition, options
    );
    this._systemPrompt = firstMessage;
    this.messages.push({ role: 'user', content: firstMessage });
    return firstMessage;
  }

  /**
   * Build the message that restarts a chat WITHOUT losing the contract.
   *
   * Used by the stall-recovery path and by deliberate context rotation: a new
   * chat has no system prompt, no tool list and no format, so re-sending only
   * "continue the task" guarantees the next reply is prose.
   *
   * @param {object} opts
   * @param {string} opts.task        the original task
   * @param {string} [opts.plan]      current plan state (FORGE_PLAN.md body or summary)
   * @param {string} [opts.progress]  one-line progress summary
   * @param {string[]} [opts.recentErrors]
   * @param {string} [opts.reason]    why the chat was restarted
   * @returns {string}
   */
  buildResumeMessage({ task, plan, progress, sessionContext = '', recentErrors = [], reason = 'the previous chat stalled', profile = '', workingDir }) {
    const systemPrompt = buildSystemPrompt({
      profile: profile === 'default' ? '' : profile,
      workingDir: workingDir || process.cwd(),
    });

    const parts = [
      systemPrompt,
      '',
      '═'.repeat(60),
      'CONTEXT RESET',
      '═══════════════════════════════════════════',
      `This is a fresh chat because ${reason}. You are continuing the SAME task.`,
      'The tool contract above is unchanged and still in force.',
      '',
      'ORIGINAL TASK:',
      '──────────────',
      task,
    ];

    if (progress) {
      parts.push('', 'PROGRESS SO FAR:', '────────────────', progress);
    }

    if (plan) {
      parts.push('', 'CURRENT PLAN (from FORGE_PLAN.md):', '─────────────────────────────────', plan);
    }

    if (sessionContext) {
      parts.push('', 'SESSION NOTES (durable working memory):', '──────────────────────────────────────', sessionContext);
    }

    if (recentErrors.length) {
      parts.push('', 'RECENT ERRORS:', '──────────────', ...recentErrors.slice(-3));
    }

    parts.push(
      '',
      'Resume from the next unfinished step. Do not repeat work already done.',
      'Reply with a tool call, not prose.'
    );

    const content = parts.join('\n');
    this.messages.push({ role: 'user', content });
    return content;
  }

  /**
   * Replace the conversation with a single message — used when the chat is
   * rotated, so the local log mirrors the new remote chat instead of growing
   * without bound across rotations.
   *
   * @param {string} message
   */
  resetTo(message) {
    this.messages = [{ role: 'user', content: message }];
    return this.messages;
  }

  prependMemoryContext(memoryText) {
    if (this.messages.length > 0 && this.messages[0].role === 'user') {
      this.messages[0].content = memoryText + '\n\n' + this.messages[0].content;
    }
  }

  addToolResult(toolName, result, isError) {
    const status = isError ? 'ERROR' : 'SUCCESS';
    const content = [
      '[TOOL RESULT: ' + toolName + ' | ' + status + ']',
      String(result),
      '[END TOOL RESULT]',
      '',
      'Continue with the next step, or provide your final response if the task is complete.',
    ].join('\n');

    this.messages.push({ role: 'user', content });
    return content;
  }

  addAssistantMessage(content) {
    this.messages.push({ role: 'assistant', content });
  }

  getLatestUserMessage() {
    const userMessages = this.messages.filter((m) => m.role === 'user');
    return userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  }

  get turnCount() {
    return this.messages.filter((m) => m.role === 'assistant').length;
  }

  exportLog() {
    return this.messages.map((m) => {
      const header = m.role === 'user' ? 'USER' : 'ASSISTANT';
      return '\n' + '─'.repeat(40) + '\n' + header + '\n' + '─'.repeat(40) + '\n' + m.content;
    }).join('\n');
  }

  compress(opts = {}) {
    this.messages = compressConversation(this.messages, opts);
  }

  estimatedTokens() {
    return this.messages.reduce((sum, msg) => sum + estimateTokenCount(msg.content), 0);
  }

  shouldCompress(threshold) {
    return shouldCompress(this.messages, threshold);
  }
}

module.exports = {
  buildSystemPrompt,
  buildFirstMessage,
  buildToolDocumentation,
  buildToolResultMessage,
  buildPlanningPrompt,
  ConversationManager,
};
