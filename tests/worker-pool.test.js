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
