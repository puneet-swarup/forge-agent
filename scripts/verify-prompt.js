#!/usr/bin/env node
// Quick sanity check: the built system prompt must contain the mandatory
// artifacts protocol, the artifact table, and the non-negotiable rules.
'use strict';

const { buildSystemPrompt } = require('../src/system-prompt');

const prompt = buildSystemPrompt({ workingDir: 'D:/tmp/x' });
const checks = {
  protocol: prompt.includes('MANDATORY ARTIFACTS PROTOCOL'),
  table: prompt.includes('FORGE_PLAN.md') && prompt.includes('ARCHITECTURE.md'),
  rules: prompt.includes('BEFORE your first write/edit/command'),
  tickRule: prompt.includes('AFTER each step is verified'),
  endGate: prompt.includes('MUST NOT write TASK_COMPLETE while FORGE_PLAN.md has unchecked'),
};

let ok = true;
Object.entries(checks).forEach(([name, value]) => {
  console.log((value ? 'OK   ' : 'FAIL ') + name);
  if (!value) ok = false;
});

process.exit(ok ? 0 : 1);
