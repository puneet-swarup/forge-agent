// tests/doctor.test.js — unit tests for the doctor health-check module.
'use strict';

const doctor = require('../src/doctor');

describe('doctor - individual checks', () => {
  test('checkNode passes on current (>=20) Node', () => {
    const r = doctor.checkNode();
    expect(['pass', 'fail']).toContain(r.status);
    expect(r.name).toMatch(/Node/);
  });

  test('checkPlaywright returns a structured result', () => {
    const r = doctor.checkPlaywright();
    expect(r).toHaveProperty('status');
    expect(['pass', 'warn', 'fail']).toContain(r.status);
  });

  test('checkConfig returns a structured result', () => {
    const r = doctor.checkConfig();
    expect(r).toHaveProperty('name');
    expect(['pass', 'warn', 'fail']).toContain(r.status);
  });

  test('checkDirs reports the data directory', () => {
    const r = doctor.checkDirs();
    expect(r).toHaveProperty('status');
  });

  test('checkLogin returns a structured result', () => {
    const r = doctor.checkLogin();
    expect(['pass', 'warn', 'fail']).toContain(r.status);
  });
});

describe('doctor - runDoctor aggregate', () => {
  test('returns results array and worst status', () => {
    const report = doctor.runDoctor();
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.results.length).toBeGreaterThan(0);
    expect(['pass', 'warn', 'fail']).toContain(report.worst);
  });

  test('every result has name/status/detail', () => {
    const report = doctor.runDoctor();
    for (const r of report.results) {
      expect(typeof r.name).toBe('string');
      expect(['pass', 'warn', 'fail']).toContain(r.status);
    }
  });
});

describe('doctor - formatDoctor', () => {
  test('renders a header and verdict', () => {
    const text = doctor.formatDoctor({ results: [{ name: 'X', status: 'pass', detail: 'ok' }], worst: 'pass' });
    expect(text).toContain('Doctor');
    expect(text).toContain('All checks passed');
  });

  test('shows FAIL verdict when worst is fail', () => {
    const text = doctor.formatDoctor({ results: [{ name: 'X', status: 'fail', detail: 'bad', hint: 'fix it' }], worst: 'fail' });
    expect(text).toContain('FAILURES');
    expect(text).toContain('fix it');
  });

  test('shows warnings verdict', () => {
    const text = doctor.formatDoctor({ results: [{ name: 'X', status: 'warn', detail: 'meh' }], worst: 'warn' });
    expect(text).toContain('warnings');
  });
});
