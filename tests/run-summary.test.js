// tests/run-summary.test.js — unit tests for durable per-run summaries.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const summary = require('../src/run-summary');

describe('run-summary', () => {
  let tmp;
  let prevDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-summary-'));
    prevDir = process.env.FORGE_SESSION_DIR;
    process.env.FORGE_SESSION_DIR = tmp;
    process.env.FORGE_SESSION_NAME = 'unit-sess';
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.FORGE_SESSION_DIR;
    else process.env.FORGE_SESSION_DIR = prevDir;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });

  test('buildSummary normalises fields', () => {
    const s = summary.buildSummary({
      task: 'do a thing', status: 'completed', durationMs: 65000,
      stepsCount: 4, filesWritten: ['a.js'], commandsRun: ['npm test'],
      errorCount: 1, finalOutput: 'done',
    });
    expect(s.session).toBe('unit-sess');
    expect(s.task).toBe('do a thing');
    expect(s.status).toBe('completed');
    expect(s.duration).toBe('1m5s');
    expect(s.steps).toBe(4);
    expect(s.filesWritten).toEqual(['a.js']);
    expect(s.errorCount).toBe(1);
  });

  test('renderMarkdown includes key sections', () => {
    const md = summary.renderMarkdown(summary.buildSummary({
      task: 'demo task', status: 'completed', filesWritten: ['x.js'], finalOutput: 'hello',
    }));
    expect(md).toContain('# Run summary');
    expect(md).toContain('demo task');
    expect(md).toContain('## Files written');
    expect(md).toContain('x.js');
    expect(md).toContain('hello');
  });

  test('writeSummary writes summary.md and summary.json', () => {
    const res = summary.writeSummary({
      task: 'write files', status: 'completed', filesWritten: ['a.txt', 'b.txt'],
      finalOutput: 'all done',
    });
    expect(res).not.toBeNull();
    expect(fs.existsSync(res.md)).toBe(true);
    expect(fs.existsSync(res.json)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(res.json, 'utf8'));
    expect(parsed.task).toBe('write files');
    expect(parsed.filesWritten).toEqual(['a.txt', 'b.txt']);
    expect(parsed.session).toBe('unit-sess');
    const md = fs.readFileSync(res.md, 'utf8');
    expect(md).toContain('write files');
    expect(md).toContain('a.txt');
  });

  test('writeSummary never throws on bad input', () => {
    expect(() => summary.writeSummary(null)).not.toThrow();
    expect(() => summary.writeSummary({ task: 123, filesWritten: 'notarray' })).not.toThrow();
  });
});
