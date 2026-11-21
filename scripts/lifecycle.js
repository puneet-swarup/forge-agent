#!/usr/bin/env node
// scripts/lifecycle.js - enforce the mandatory project artifacts protocol.
//
// Usage:
//   node scripts/lifecycle.js check-start   [--dir D]  task start: plan must exist
//   node scripts/lifecycle.js check-end     [--dir D]  TASK_COMPLETE gate
//   node scripts/lifecycle.js list                     show the artifact contract
//
// Exit codes: 0 = ok, 1 = protocol violation, 2 = usage error.
//
// The checks themselves live in src/lifecycle.js: the agent loop calls the same
// functions before the first mutating tool and at TASK_COMPLETE, so the CLI and
// the loop can never disagree about what "done" means.
'use strict';

const {
  ARTIFACTS,
  checkStart,
  checkEnd,
  parseCheckboxItems,
  PLAN_FILE,
} = require('../src/lifecycle');

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
