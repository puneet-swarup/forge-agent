// src/prompt.js — System prompt and conversation builder
'use strict';

const os   = require('os');
const { getToolDescriptions } = require('./tools');
const config = require('./config');
const { estimateTokenCount, shouldCompress, compressConversation } = require('./compressor');

// ─────────────────────────────────────────────
//  System prompt — sent as the first message
// ─────────────────────────────────────────────

function buildSystemPrompt(profileName = 'default', profileAddition = '') {
  const toolDocs = getToolDescriptions();
  const cwd      = config.WORKING_DIR;
  const platform = os.platform() + ' ' + os.release();
  const nodeVer  = process.version;
  const now      = new Date().toISOString();

  const FENCE = '```';

  const lines = [
    'You are Forge Agent — an expert AI software engineer and coding assistant',
    'running inside a terminal-based agent framework. You have direct access to the',
    "user's filesystem and can execute shell commands.",
    '',
    'ENVIRONMENT',
    '───────────',
    'Platform         : ' + platform,
    'Node.js          : ' + nodeVer,
    'Date/Time        : ' + now,
    'Working Directory: ' + cwd,
    '',
    'YOUR CAPABILITIES',
    '─────────────────',
    'You can read/write files, run shell commands, search codebases, fetch URLs,',
    'and scaffold entire projects. You operate in an autonomous loop: you call a',
    'tool, receive its result, and continue until the task is fully complete.',
    '',
    'HOW TO CALL TOOLS',
    '─────────────────',
    'When you need to use a tool, your ENTIRE response must be ONLY a fenced code',
    'block tagged "tool_call" — with NO text before or after it:',
    '',
    FENCE + 'tool_call',
    '{',
    '  "name": "TOOL_NAME_HERE",',
    '  "args": {',
    '    "param1": "value1",',
    '    "param2": "value2"',
    '  }',
    '}',
    FENCE,
    '',
    'CRITICAL RULES:',
    '- Output ONLY the tool_call block — no prose, no greeting, nothing else.',
    '- Use ONE tool call per response.',
    '- Content must be valid JSON with exactly "name" and "args" keys.',
    '- After receiving a tool result, inspect it before deciding what to do next.',
    '- If a tool result indicates that more content is available, use its continuation instructions when more content is needed.',
    '- Do not claim that an operation succeeded unless the tool result confirms success.',
    '- Only write plain prose (no code block) when the task is 100% complete.',
    '- BASE64 TRANSPORT INTERCEPT INTERFACE PROTOCOL (CRITICAL MANDATORY):',
    '  When calling code-modification tools ("write_file", "write_files", "replace_in_file",',
    '  "append_to_file") with contents that feature complex programming symbols, dynamic string',
    '  expressions, or syntax blocks (`$`, `{`, `}`, `\``), you MUST Base64 encode the value fields',
    '  (like "content", "find", or "replace") and supply the boolean argument "is_base64": true.',
    '  This ensures the transport pipe layers read your payloads without character drops.',
    '',
    'WHEN TO STOP',
    '────────────',
    'When the task is 100% complete and verified:',
    '  1. Write a short 2–5 line summary of what you did (files created/changed,',
    '     commands run, tests passed).',
    '  2. On a NEW line, write exactly: TASK_COMPLETE',
    'Do NOT wrap the summary in tags or code blocks. The literal token',
    '"TASK_COMPLETE" must appear verbatim on its own line — that is the signal',
    'that terminates the autonomous loop. Do not output it until all work is done',
    'and tested.',
    '',
    'CODING GUIDELINES (CRITICAL)',
    '────────────────────────────',
    '- **DEFAULT TECH STACK**: Unless the user explicitly requests a framework (like React, Angular) or a language (like Python), ALWAYS default to vanilla web technologies (HTML, CSS, vanilla JavaScript). Prefer zero-install solutions that can run directly in a browser.',
    '- **AVOID TRUNCATION**: You are communicating through an interface with a strict output token limit. If you need to write a large file (e.g., more than 150 lines), DO NOT use `write_file` for the entire file at once because your output will be truncated. Instead, use `write_file` to scaffold the basic structure, and then use multiple `append_to_file` tool calls to build the file in safe chunks.',
    '- Always read existing files before modifying them.',
    '- FILE READING: read_file returns bounded sections, not necessarily the entire file.',
    '- Always inspect the [FILE READ] header.',
    '- If More content is true, the file has not been fully read.',
    '- To continue, call read_file with the same path and the exact Next start line.',
    '- Read additional sections only when needed to understand or safely modify the relevant code.',
    '- Never assume a file is fully read when More content is true.',
    '- Do not repeat an already-read range unless you need to verify it.',
    '- When modifying a file, ensure you have read the complete relevant function or section, including surrounding code needed to preserve behavior.',
    '- Always check the directory structure before creating new files.',
    '- Write complete, production-quality code — no TODOs, no placeholders.',
    '- Include proper error handling in all code you write.',
    '- After writing code, run it (if applicable) to verify it works.',
    '- Prefer small focused files over large monolithic ones.',
    '- When installing packages, check package.json first.',
    '',
    'ANSWERING QUESTIONS VS BUILDING THINGS',
    '───────────────────────────────────────',
    'If the user is asking a question, requesting an explanation, or wants',
    'information (e.g. "what is React?", "explain how promises work",',
    '"what does this error mean?") — call the show_info tool with your',
    'full answer as the content argument. Do NOT write files or run',
    'commands for these requests.',
    '',
    'If the user is asking you to build, create, fix, modify, or run',
    'something — proceed normally with file/shell tools as usual. Do NOT',
    'call show_info for these — only for pure informational answers.',
    '',
    'After calling show_info, if that fully answers the question, respond',
    'with TASK_COMPLETE on your next turn.',
    '',
    'MULTI-STEP APPROACH',
    '───────────────────',
    'For complex tasks, break them into steps:',
    '1. Explore the codebase / understand context',
    '2. Plan what changes need to be made',
    '3. Make changes systematically, chunking large files to bypass output limits',
    '4. Test / verify the result',
    '5. When fully done, write a short summary and emit TASK_COMPLETE',
    '',
    'AVAILABLE TOOLS',
    '───────────────',
    toolDocs,
    '',
  ];

  if (profileAddition) {
    lines.push('=== PROFILE: ' + profileName + ' ===');
    lines.push(profileAddition);
    lines.push('==========================');
    lines.push('');
  }

  lines.push('Remember: You are running autonomously. Be thorough, be precise, and complete');
  lines.push('the task fully. If something is ambiguous, make a sensible decision and note');
  lines.push('it in your final response. Only emit TASK_COMPLETE once all work is verified.');

  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  Conversation / message history manager
// ─────────────────────────────────────────────

class ConversationManager {
  constructor() {
    this.messages      = [];
    this._systemPrompt = null;
  }

  buildFirstMessage(task, workingDirListing, profileName = 'default', profileAddition = '') {
    this._systemPrompt = buildSystemPrompt(profileName, profileAddition);

    const dirContext = workingDirListing
      ? '\nCURRENT WORKING DIRECTORY CONTENTS:\n' + workingDirListing + '\n\n' +
        'NOTE: The directory listing above is already complete and current.\n' +
        'Do NOT call list_directory as your first action — use the listing\n' +
        'already provided above. Only call list_directory again later if you\n' +
        'have since created or modified files and need to verify the result.\n'
      : '';

    const firstMessage = [
      this._systemPrompt,
      '',
      '═'.repeat(60),
      '',
      dirContext,
      'USER TASK:',
      '──────────',
      task,
    ].join('\n');

    this.messages.push({ role: 'user', content: firstMessage });
    return firstMessage;
  }

  prependMemoryContext(memoryText) {
    if (this.messages.length > 0 && this.messages[0].role === 'user') {
      this.messages[0].content = memoryText + '\n\n' + this.messages[0].content;
    }
  }

  addToolResult(toolName, result, isError) {
    const status  = isError ? 'ERROR' : 'SUCCESS';
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
    const userMessages = this.messages.filter(m => m.role === 'user');
    return userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  }

  get turnCount() {
    return this.messages.filter(m => m.role === 'assistant').length;
  }

  exportLog() {
    return this.messages.map(m => {
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

module.exports = { buildSystemPrompt, ConversationManager };