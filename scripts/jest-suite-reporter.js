// scripts/jest-suite-reporter.js — print the suite that is starting.
//
// Jest's verbose output prints a test when it *finishes*, so a suite that hangs
// before its first assertion leaves nothing behind but the previous suite's last
// line. That is exactly the state CI has been in since 2026-11-21: the log stops
// mid-suite and there is no way to tell which one.
//
// This reporter prints the start line immediately, with a timestamp, so the last
// line of a cancelled run names the suite that never finished.
'use strict';

const started = new Map();

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

class SuiteStartReporter {
  onTestFileStart(test) {
    const file = (test && test.path) || '(unknown)';
    started.set(file, Date.now());
    // Straight to stdout, unbuffered by jest's own reporter pipeline.
    process.stdout.write(`[suite-start ${stamp()}] ${file}\n`);
  }

  onTestFileResult(test, result) {
    const file = (test && test.path) || '(unknown)';
    const began = started.get(file);
    const ms = began ? Date.now() - began : 0;
    const status = result && result.numFailingTests > 0 ? 'FAIL' : 'ok';
    process.stdout.write(`[suite-end   ${stamp()}] ${file} (${ms} ms, ${status})\n`);
  }
}

module.exports = SuiteStartReporter;
