// tests/parallel-tools.test.js — Item 5: parallel tool groups
'use strict';

const { parseResponse } = require('../src/parser');
const {
  classifyEffect,
  conflictKeys,
  planWaves,
  executeBatch,
} = require('../src/parallel-executor');

// ─────────────────────────────────────────────
//  Parser: batch detection
// ─────────────────────────────────────────────

describe('parser — tool batches', () => {
  test('single <tool_call> stays a tool_call (backward compatible)', () => {
    const r = parseResponse('<tool_call>{"tool":"read_file","args":{"path":"a"}}</tool_call>');
    expect(r.type).toBe('tool_call');
    expect(r.name).toBe('read_file');
  });

  test('two <tool_call> tags become a tool_batch', () => {
    const text =
      '<tool_call>{"tool":"write_file","args":{"path":"a","content":"x"}}</tool_call>\n' +
      '<tool_call>{"tool":"read_file","args":{"path":"b"}}</tool_call>';
    const r = parseResponse(text);
    expect(r.type).toBe('tool_batch');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].name).toBe('write_file');
    expect(r.calls[1].name).toBe('read_file');
  });

  test('{"tool_calls":[...]} JSON becomes a tool_batch', () => {
    const r = parseResponse('{"tool_calls":[{"tool":"read_file","args":{"path":"a"}},{"tool":"read_file","args":{"path":"b"}}]}');
    expect(r.type).toBe('tool_batch');
    expect(r.calls).toHaveLength(2);
  });

  test('single-entry tool_calls collapses to tool_call', () => {
    const r = parseResponse('{"tool_calls":[{"tool":"read_file","args":{"path":"a"}}]}');
    expect(r.type).toBe('tool_call');
    expect(r.name).toBe('read_file');
  });
});

// ─────────────────────────────────────────────
//  Effect classification
// ─────────────────────────────────────────────

describe('parallel-executor — classification', () => {
  test('read tools are reads, write tools are writes', () => {
    expect(classifyEffect('read_file')).toBe('read');
    expect(classifyEffect('search_in_files')).toBe('read');
    expect(classifyEffect('write_file')).toBe('write');
    expect(classifyEffect('run_command')).toBe('write');
  });
});

// ─────────────────────────────────────────────
//  Conflict keys
// ─────────────────────────────────────────────

describe('parallel-executor — conflict keys', () => {
  test('same file path produces the same key', () => {
    const a = conflictKeys('write_file', { path: 'a.txt' }, 'D:/proj');
    const b = conflictKeys('read_file', { path: 'a.txt' }, 'D:/proj');
    expect(a).toEqual(b);
  });

  test('different files produce different keys', () => {
    const a = conflictKeys('write_file', { path: 'a.txt' }, 'D:/proj');
    const b = conflictKeys('read_file', { path: 'b.txt' }, 'D:/proj');
    expect(a).not.toEqual(b);
  });

  test('clipboard is a global single key', () => {
    expect(conflictKeys('write_clipboard', {}, 'D:/proj')).toEqual(['clipboard']);
  });
});

// ─────────────────────────────────────────────
//  Wave planning
// ─────────────────────────────────────────────

describe('parallel-executor — wave planning', () => {
  test('independent calls share wave 0', () => {
    const waves = planWaves([
      { name: 'write_file', args: { path: 'a.txt' } },
      { name: 'read_file', args: { path: 'b.txt' } },
    ], 'D:/proj');
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  test('same-file calls are serialised into separate waves', () => {
    const waves = planWaves([
      { name: 'write_file', args: { path: 'a.txt' } },
      { name: 'read_file', args: { path: 'a.txt' } },
    ], 'D:/proj');
    expect(waves).toHaveLength(2);
    expect(waves[0][0]._index).toBe(0);
    expect(waves[1][0]._index).toBe(1);
  });

  test('diamond: writes serialised, independent read in wave 0', () => {
    const waves = planWaves([
      { name: 'write_file', args: { path: 'a.txt' } },
      { name: 'read_file', args: { path: 'b.txt' } },
      { name: 'write_file', args: { path: 'a.txt' } },
    ], 'D:/proj');
    expect(waves[0].map(w => w._index).sort()).toEqual([0, 1]);
    expect(waves[1].map(w => w._index)).toEqual([2]);
  });
});

// ─────────────────────────────────────────────
//  Batch execution
// ─────────────────────────────────────────────

describe('parallel-executor — executeBatch', () => {
  test('results are returned in original order', async () => {
    const calls = [
      { name: 'slow', args: { id: 1 } },
      { name: 'fast', args: { id: 2 } },
    ];
    const exec = async (name, args) => {
      if (name === 'slow') await new Promise(r => setTimeout(r, 30));
      return name + ':' + args.id;
    };
    const results = await executeBatch(calls, { executeTool: exec, cwd: '.', maxParallel: 4 });
    expect(results[0].result).toBe('slow:1');
    expect(results[1].result).toBe('fast:2');
  });

  test('errors are captured per-call, not thrown', async () => {
    const exec = async (name) => { if (name === 'boom') throw new Error('kaboom'); return 'ok'; };
    const results = await executeBatch(
      [{ name: 'ok', args: {} }, { name: 'boom', args: {} }],
      { executeTool: exec, cwd: '.', maxParallel: 4 }
    );
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true);
    expect(results[1].result).toContain('kaboom');
  });

  test('maxParallel=1 forces strictly sequential execution', async () => {
    const order = [];
    const exec = async (name) => { order.push('start:' + name); await new Promise(r => setTimeout(r, 5)); order.push('end:' + name); return name; };
    await executeBatch(
      [{ name: 'a', args: {} }, { name: 'b', args: {} }],
      { executeTool: exec, cwd: '.', maxParallel: 1 }
    );
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('same-file writes never overlap', async () => {
    let active = 0, maxActive = 0;
    const exec = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return 'ok';
    };
    await executeBatch(
      [
        { name: 'write_file', args: { path: 'same.txt' } },
        { name: 'write_file', args: { path: 'same.txt' } },
      ],
      { executeTool: exec, cwd: '.', maxParallel: 4 }
    );
    expect(maxActive).toBe(1);
  });

  test('independent calls do run concurrently', async () => {
    let active = 0, maxActive = 0;
    const exec = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 15));
      active--;
      return 'ok';
    };
    await executeBatch(
      [
        { name: 'write_file', args: { path: 'a.txt' } },
        { name: 'read_file', args: { path: 'b.txt' } },
        { name: 'read_file', args: { path: 'c.txt' } },
      ],
      { executeTool: exec, cwd: '.', maxParallel: 4 }
    );
    expect(maxActive).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────
//  Concurrency cap enforcement (regression)
// ─────────────────────────────────────────────

describe('parallel-executor — maxParallel cap', () => {
  test('never exceeds maxParallel concurrent calls in one wave', async () => {
    const calls = [];
    for (let i = 0; i < 10; i++) {
      calls.push({ name: 'read_file', args: { path: 'file' + i + '.txt' } });
    }
    let active = 0, maxActive = 0;
    const exec = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return 'ok';
    };
    await executeBatch(calls, { executeTool: exec, cwd: '.', maxParallel: 3 });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  test('maxParallel=2 with 5 independent calls runs in ceil(5/2)=3 waves', async () => {
    const calls = [];
    for (let i = 0; i < 5; i++) calls.push({ name: 'read_file', args: { path: 'f' + i + '.txt' } });
    let active = 0, maxActive = 0;
    const exec = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return 'ok';
    };
    await executeBatch(calls, { executeTool: exec, cwd: '.', maxParallel: 2 });
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
