// tests/process-tree.test.js — a stopped process must actually be stopped.
//
// `spawn(command, {shell: true})` records the PID of `sh -c "<command>"`, not the
// command. Signalling that PID kills the shell and orphans the command, which
// then runs forever. Because the orphan holds the stdout/stderr pipes open, the
// process that spawned it never exits — CI sat for 19 minutes after the tests had
// finished, and 17 orphans had accumulated in a single session before anyone
// looked.
//
// The fix is detached + kill(-pid): the child leads its own process group, so one
// signal reaches the shell and everything it started.
'use strict';

const { execSync } = require('child_process');
const { startProcess, stopProcess, killTree } = require('../src/process-manager');

/** Is a process with this marker still alive? */
function survivors(marker) {
  try {
    const out = execSync(`ps -eo pid,args | grep ${marker} | grep -v grep || true`)
      .toString().trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

describe('stopping a process stops the command it started', () => {
  test('a shell-wrapped command leaves no orphan', async () => {
    const marker = 'FORGE_ORPHAN_CHECK_1';
    startProcess('orphan-1', `node -e "setInterval(()=>{},1000)" # ${marker}`);

    // Give the shell time to start the child.
    await new Promise((r) => setTimeout(r, 400));
    expect(survivors(marker).length).toBeGreaterThan(0);

    stopProcess('orphan-1', 'SIGKILL');
    await new Promise((r) => setTimeout(r, 400));

    expect(survivors(marker)).toEqual([]);
  }, 15000);

  test('a grandchild is killed with its parent', async () => {
    const marker = 'FORGE_ORPHAN_CHECK_2';
    // sh -> node -> sleep: the grandchild is the one that used to survive.
    startProcess('orphan-2', `node -e "require('child_process').spawn('sleep',['30'],{stdio:'inherit'}); setInterval(()=>{},1000)" # ${marker}`);

    await new Promise((r) => setTimeout(r, 600));
    stopProcess('orphan-2', 'SIGKILL');
    await new Promise((r) => setTimeout(r, 400));

    expect(survivors(marker)).toEqual([]);
  }, 15000);
});

describe('killTree', () => {
  test('returns false for nothing to kill', () => {
    expect(killTree(null)).toBe(false);
    expect(killTree({})).toBe(false);
  });

  test('does not throw when the process is already gone', () => {
    expect(() => killTree({ pid: 999999, kill() {} })).not.toThrow();
  });
});
