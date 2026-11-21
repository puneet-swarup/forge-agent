#!/usr/bin/env node
// Sanity check for the system prompt.
//
// This used to validate src/system-prompt.js — a prompt the agent never sent.
// It now validates the message the agent actually builds, through
// src/prompt.js -> ConversationManager, so it cannot certify the wrong file.
//
// Run: node scripts/verify-prompt.js   (exit 0 = ok)
'use strict';

const path = require('path');

const promptModule = require('../src/prompt');
const systemPromptModule = require('../src/system-prompt');

// The first message of a fresh chat, exactly as agent.js builds it.
const message = promptModule.buildFirstMessage(
  'VERIFY_PROMPT_SENTINEL',
  null,
  'default',
  ''
);

const checks = {
  // ── the response envelope (the adapter detects completion from it) ──────
  'envelope: START marker': message.includes('<<<FORGE_START>>>'),
  'envelope: END marker': message.includes('<<<FORGE_END>>>'),

  // ── the one call format ────────────────────────────────────────────────
  'call format: <tool_call> block': message.includes('<tool_call>') && message.includes('</tool_call>'),
  'call format: {"tool": ...} payload': /"tool"\s*:/.test(message),
  'call format: no fenced ```tool_call style': !/```tool_call/.test(message),

  // ── stopping ───────────────────────────────────────────────────────────
  'stop: TASK_COMPLETE stated': message.includes('TASK_COMPLETE'),

  // ── artifact protocol (enforced by scripts/lifecycle.js) ───────────────
  'artifacts: protocol heading': message.includes('MANDATORY ARTIFACTS PROTOCOL'),
  'artifacts: FORGE_PLAN.md named': message.includes('FORGE_PLAN.md'),
  'artifacts: ARCHITECTURE.md named': message.includes('ARCHITECTURE.md'),
  'artifacts: plan-before-write rule': /before your first write\/edit\/command/i.test(message),
  'artifacts: tick-per-step rule': /after each step is verified/i.test(message),
  'artifacts: completion gate': /TASK_COMPLETE while FORGE_PLAN\.md has unchecked/i.test(message),

  // ── the catalogue is generated, so nothing can be orphaned ─────────────
  'tools: catalogue present': message.includes('AVAILABLE TOOLS'),
  'tools: run_command documented': message.includes('run_command('),
  'tools: show_info documented': message.includes('show_info('),

  // ── the task itself ────────────────────────────────────────────────────
  'task: user task included': message.includes('VERIFY_PROMPT_SENTINEL'),

  // ── no contradictory instructions ──────────────────────────────────────
  'encoding: no base64-for-code instruction': !/must\s+base64/i.test(message) && !/base64-encode the/i.test(message),

  // ── one builder, not two ───────────────────────────────────────────────
  'single source: prompt.js re-exports system-prompt.js':
    promptModule.buildSystemPrompt === systemPromptModule.buildSystemPrompt,

  // ── context budget (a 22.5k first message was costing every new chat) ──
  'budget: first message under 16000 chars': message.length < 16000,
};

let ok = true;
for (const [name, value] of Object.entries(checks)) {
  if (!value) ok = false;
  console.log((value ? 'OK   ' : 'FAIL ') + name);
}

console.log('');
console.log('first message: ' + message.length + ' chars (~' + Math.ceil(message.length / 4) + ' tokens)');
console.log('file: ' + path.relative(process.cwd(), require.resolve('../src/prompt')));

process.exit(ok ? 0 : 1);
