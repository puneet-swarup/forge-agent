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


describe('run-summary - read + list', () => {
  test('readSummary returns null when no summary exists', () => {
    const s = summary.readSummary('nope-' + Date.now());
    expect(s).toBeNull();
  });

  test('readSummary reads a written summary', () => {
    const res = summary.writeSummary({ task: 'readable', status: 'completed', finalOutput: 'x' });
    expect(res).not.toBeNull();
    // resolveSummaryDir honours FORGE_SESSION_DIR; readSummary uses session name.
    // Write under the canonical session dir for the current session name too.
    const fs = require('fs');
    const path = require('path');
    const reg = require('../src/session-registry');
    const name = 'read-' + Date.now();
    const dir = reg.sessionDirFor(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ session: name, task: 'readable', status: 'completed' }), 'utf8');
    const got = summary.readSummary(name);
    expect(got).not.toBeNull();
    expect(got.task).toBe('readable');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('listSummaries returns an array', () => {
    expect(Array.isArray(summary.listSummaries())).toBe(true);
  });
});
