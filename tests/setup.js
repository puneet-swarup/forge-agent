// tests/setup.js — suite-wide defaults.
//
// The verification gate (src/verify.js) runs the project's own check before
// accepting TASK_COMPLETE. Most tests run agent.run() inside a temp directory
// with no package.json, where the gate is a no-op — but any test that leaves
// WORKING_DIR at the repo root would make jest spawn jest. Disabling it here
// keeps that impossible, and tests/verify-gate.test.js turns it back on for the
// directories it controls.
'use strict';

const config = require('../src/config');
config.VERIFY_BEFORE_COMPLETE = false;
