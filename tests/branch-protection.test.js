// tests/branch-protection.test.js — the required status checks cannot drift.
//
// Branch protection on `main` requires these checks by name. A job rename would
// silently stop enforcing it: the rule would still say "wait for CI", and CI
// would never report the name it is waiting for. That is the same failure as a
// hand-maintained whitelist — so the names are pinned here, next to the workflow
// that produces them.
//
// The check names are what GitHub reports; the job keys are what the YAML calls
// them. Both are asserted, because a `name:` rename changes the check without
// changing the key.
'use strict';

const fs = require('fs');
const path = require('path');

const CI = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

/** Check names GitHub creates from this workflow. */
function producedChecks() {
  const names = [];

  // Matrix jobs expand to one check per value.
  const matrixJob = CI.match(/name:\s*Test \(Node \$\{\{\s*matrix\.node-version\s*\}\}\)/);
  if (matrixJob) {
    const matrixLine = CI.match(/node-version:\s*\[([^\]]+)\]/);
    const versions = matrixLine
      ? matrixLine[1].split(',').map((v) => v.trim())
      : [];
    for (const v of versions) names.push(`Test (Node ${v})`);
  }

  // Plain named jobs.
  for (const m of CI.matchAll(/^ {4}name:\s*([^\n$]+)$/gm)) {
    names.push(m[1].trim());
  }

  return [...new Set(names)];
}

describe('required status checks', () => {
  const checks = producedChecks();

  test('the workflow still produces the checks protection waits for', () => {
    // These four are configured in GitHub branch protection. If a rename lands,
    // this test fails and the rule is updated in the same commit.
    expect(checks).toContain('Test (Node 20)');
    expect(checks).toContain('Test (Node 22)');
    expect(checks).toContain('Test (Node 24)');
    expect(checks).toContain('Integration (browser E2E)');
  });

  test('every job in the workflow has a name GitHub can report', () => {
    // Only the block under `jobs:` holds jobs; the top-level keys (on, push,
    // permissions, concurrency) sit at the same indentation.
    const jobsBlock = CI.split(/^jobs:$/m)[1] || '';
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);

    expect(jobs.length).toBeGreaterThan(0);

    for (const job of jobs) {
      const block = jobsBlock.split(new RegExp(`^ {2}${job}:$`, 'm'))[1] || '';
      expect(block.slice(0, 200)).toMatch(/name:/);
    }
  });

  test('the documented list matches the workflow', () => {
    // docs/RELIABILITY.md names the checks so a reader can verify the rule.
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RELIABILITY.md'), 'utf8');
    for (const check of ['Test (Node 20)', 'Test (Node 22)', 'Test (Node 24)', 'Integration (browser E2E)']) {
      expect(doc).toContain(check);
    }
  });
});
