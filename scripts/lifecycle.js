#!/usr/bin/env node
// scripts/lifecycle.js - enforce the mandatory project artifacts protocol.
//
// Usage:
//   node scripts/lifecycle.js check-start   [--dir D]  task start: plan must exist
//   node scripts/lifecycle.js check-end     [--dir D]  TASK_COMPLETE gate
//   node scripts/lifecycle.js list                    show the artifact contract
//
// Exit codes: 0 = ok, 1 = protocol violation, 2 = usage error.
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ARTIFACTS,
  requiredAtStart,
  requiredCompleteAtEnd,
} = require('../src/lifecycle');

const PLAN_FILE = 'FORGE_PLAN.md';

function parseCheckboxItems(raw) {
  const out = [];
  const lines = String(raw || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    out.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x', line: i + 1 });
  }
  return out;
}

function readIfPresent(dir, file) {
  const p = path.join(path.resolve(dir), file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/** Task start: FORGE_PLAN.md must exist with at least one checkbox item. */
function checkStart(dir) {
  const errors = [];

  for (const file of requiredAtStart()) {
    const raw = readIfPresent(dir, file);
    if (raw === null) {
      // SESSION_CONTEXT.md is written by the framework; only FORGE_PLAN.md is
      // the agent's responsibility at this point. Flag only agent-owned files.
      const meta = ARTIFACTS.find(a => a.file === file);
      if (meta && meta.owner === 'agent') errors.push('missing ' + file + ' (agent-owned, required at task start)');
      continue;
    }
    if (file === PLAN_FILE) {
      const items = parseCheckboxItems(raw);
      if (items.length === 0) {
        errors.push(PLAN_FILE + ' has no "- [ ]" steps');
      }
    }
  }

  return errors;
}

/** Sign-off gate: every step in FORGE_PLAN.md must be ticked. */
function checkEnd(dir) {
  const errors = [];

  for (const file of requiredCompleteAtEnd()) {
    const raw = readIfPresent(dir, file);
    if (raw === null) {
      errors.push('missing ' + file + ' (required at TASK_COMPLETE)');
      continue;
    }
    const items = parseCheckboxItems(raw);
    if (items.length === 0) {
      errors.push(file + ' has no "- [ ]" steps');
      continue;
    }
    const open = items.filter(i => !i.done);
    if (open.length > 0) {
      errors.push(
        PLAN_FILE + ' still has ' + open.length + ' unchecked step(s): ' +
        open.map(i => '#' + i.line + ' ' + i.text).join('; ')
      );
    }
  }

  return errors;
}

function listContract() {
  return ARTIFACTS.map(function (a) {
    return [
      a.file,
      '  owner:     ' + a.owner,
      '  phase:     ' + a.phase,
      '  purpose:   ' + a.purpose,
      '  lifecycle: ' + a.lifecycle,
      '  start:     ' + (a.requiredAtStart ? 'REQUIRED' : 'optional'),
      '  end:       ' + (a.mustBeCompleteAtEnd ? 'ALL STEPS DONE' : 'n/a'),
    ].join('\n');
  }).join('\n\n');
}

function main(argv) {
  const cmd = argv[2] || 'list';
  const dirIdx = argv.indexOf('--dir');
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : process.cwd();

  if (cmd === 'list') {
    console.log(listContract());
    return 0;
  }

  let errors;
  if (cmd === 'check-start') {
    errors = checkStart(dir);
  } else if (cmd === 'check-end') {
    errors = checkEnd(dir);
  } else {
    console.error('usage: lifecycle.js <check-start|check-end|list> [--dir D]');
    return 2;
  }

  if (errors.length > 0) {
    console.error('LIFECYCLE VIOLATION (' + cmd + '):');
    errors.forEach(e => console.error('  - ' + e));
    return 1;
  }

  console.log('lifecycle ok (' + cmd + ')');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { checkStart, checkEnd, listContract, parseCheckboxItems, PLAN_FILE };
