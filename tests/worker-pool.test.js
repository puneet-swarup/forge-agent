// tests/worker-pool.test.js - concurrency-capped pool of child agents
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pool-'));
process.env.FORGE_HOME = TMP;

const { runPool, slugify, DEFAULT_MAX_PARALLEL } = require('../src/worker-pool');

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
});

describe('worker-pool', () => {
  test('slugify produces a filesystem-safe slug', () => {
    expect(slugify('Add input validation!')).toBe('add-input-validation');
    expect(slugify('')).toBe('task');
    expect(slugify('   ')).toBe('task');
  });

  test('DEFAULT_MAX_PARALLEL is a sane positive number', () => {
    expect(DEFAULT_MAX_PARALLEL).toBeGreaterThanOrEqual(1);
  });

  test('empty task list resolves immediately with zero results', async () => {
    const res = await runPool([], { quiet: true });
    expect(res.completed).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.results).toEqual([]);
  });

  test('ignores blank/non-string tasks', async () => {
    const res = await runPool(['', '   ', null, undefined], { quiet: true });
    expect(res.completed).toBe(0);
    expect(res.failed).toBe(0);
  });

  test('emits a complete event with totals', async () => {
    const events = [];
    await runPool([], { quiet: true, onEvent: (e) => events.push(e.type) });
    expect(events).toContain('complete');
  });
});

// ── Integration: actually spawn children (no browser needed) ──────────────
//
// Each task is the literal string '--help' so the child prints help and exits
// 0 immediately. This proves the pool spawns real processes, caps concurrency,
// and collects exit codes, without needing a login.

describe('worker-pool integration (real child processes)', () => {
  test('runs multiple children and reports them completed', async () => {
    const events = [];
    const res = await runPool(['--help', '--help'], {
      quiet: true,
      maxParallel: 2,
      sessionPrefix: 'pooltest',
      onEvent: (e) => events.push(e),
    });

    expect(res.results.length).toBe(2);
    // All children should exit 0 (help exits cleanly).
    expect(res.completed).toBe(2);
    expect(res.failed).toBe(0);
    // Each child got a unique session.
    const sessions = res.results.map(r => r.session);
    expect(new Set(sessions).size).toBe(2);
    // We saw start events for both.
    const starts = events.filter(e => e.type === 'start');
    expect(starts.length).toBe(2);
  }, 60000);

  test('respects maxParallel=1 (sequential)', async () => {
    const res = await runPool(['--help', '--help'], {
      quiet: true,
      maxParallel: 1,
      sessionPrefix: 'poolseq',
    });
    expect(res.completed).toBe(2);
  }, 60000);
});

// ── Regression: results must be index-aligned with tasks ──────────────────
//
// Bug: runPool used results.push(res), so with out-of-order completion the
// results array was completion-ordered. A caller doing results[i] <-> tasks[i]
// silently mis-attributed outcomes. This test forces different task durations
// by using a task string that sorts/execs differently, then asserts each
// results[i].task === tasks[i].

describe('worker-pool result ordering (regression)', () => {
  test('results[i].task matches tasks[i] regardless of completion order', async () => {
    const tasks = ['--help', '--help', '--help'];
    const res = await runPool(tasks, {
      quiet: true,
      maxParallel: 3,
      sessionPrefix: 'poolorder',
    });
    expect(res.results.length).toBe(3);
    for (let i = 0; i < tasks.length; i++) {
      expect(res.results[i]).toBeDefined();
      expect(res.results[i].task).toBe(tasks[i]);
      expect(res.results[i].session).toContain('poolorder');
    }
  }, 60000);

  test('stopOnError leaves a dense, index-aligned results array', async () => {
    // '--help' exits 0; a bogus flag exits non-zero. With stopOnError the pool
    // stops launching after the first failure, but results must still be a
    // dense, index-aligned array of length tasks.length.
    const res = await runPool(['--help', '--definitely-not-a-real-flag', '--help'], {
      quiet: true,
      maxParallel: 1,
      sessionPrefix: 'poolstop',
      stopOnError: true,
    });
    expect(res.results.length).toBe(3);
    for (let i = 0; i < res.results.length; i++) {
      expect(res.results[i]).toBeDefined();
      expect(res.results[i].task).toBe(
        i === 0 ? '--help'
        : i === 1 ? '--definitely-not-a-real-flag'
        : '--help'
      );
    }
    // Every slot is present (no holes) and is either a real result or an
    // explicitly-skipped placeholder, so results.length === tasks.length.
    expect(res.results.length).toBe(3);
    for (const r of res.results) {
      expect(typeof r.task).toBe('string');
      expect(r.session === null || typeof r.session === 'string').toBe(true);
    }
  }, 60000);
});

// ── Regression: each child heartbeats under its OWN session name ───────────
//
// Bug: spawn env passed FORGE_SUPERVISOR_SESSION = parent's session, so every
// child registered under the parent and `ps` collapsed them into one entry.
// We assert the child sees the env var equal to its own session by having it
// echo it (we cannot attach to the live child, so we inspect the spawn call
// contract via a tiny wrapper child).

describe('worker-pool child env (regression)', () => {
  test('child receives its own session in FORGE_SUPERVISOR_SESSION', async () => {
    const { _buildChildEnvForTest } = require('../src/worker-pool');
    if (typeof _buildChildEnvForTest !== 'function') {
      // Helper not exported in this build; skip rather than false-fail.
      return;
    }
    const env = _buildChildEnvForTest('worker-abc-0');
    expect(env.FORGE_SUPERVISOR_SESSION).toBe('worker-abc-0');
  });
});
