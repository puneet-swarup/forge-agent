// tests/agent-supervisor.test.js - Phase 4 spawn/monitor/kill
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sup-'));
process.env.FORGE_HOME = TMP;

const sup = require('../src/agent-supervisor');
const registry = require('../src/session-registry');

const NL = String.fromCharCode(10);

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.FORGE_HOME;
});

describe('agent-supervisor', () => {
  test('spawnAgent requires a session name', () => {
    expect(() => sup.spawnAgent({ task: 'x' })).toThrow(/session/);
  });

  test('spawnAgent requires a task', () => {
    expect(() => sup.spawnAgent({ session: 's' })).toThrow(/task/);
  });

  test('entryPoint resolves to an existing file', () => {
    expect(fs.existsSync(sup.entryPoint())).toBe(true);
  });

  test('killChild reports an error for an unknown instance', () => {
    const res = sup.killChild('does-not-exist-xyz');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No matching/);
  });

  test('listChildren delegates to the registry', () => {
    const list = sup.listChildren();
    expect(Array.isArray(list)).toBe(true);
  });

  test('readChildContext returns null when no SESSION_CONTEXT.md exists', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ctx-'));
    expect(sup.readChildContext('x', d)).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });
});
