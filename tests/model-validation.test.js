// tests/model-validation.test.js — an unknown model must not silently become
// deepseek.
//
// `--diagnose=sarvam` printed "Sarvam AI (Indus)" and then launched deepseek:
// config's MODEL validator held a hand-written list that predated the adapter,
// so the assignment was rejected with a warning and the run continued on the
// previous value. A command naming one model drove another, and nothing failed.
'use strict';

const factory = require('../src/adapter-factory');

function setModel(value) {
  const config = require('../src/config');
  config.MODEL = 'deepseek';   // known-good starting point
  config.MODEL = value;
  return config.MODEL;
}

describe('MODEL validation', () => {
  test('every model the factory supports is accepted', () => {
    for (const model of factory.SUPPORTED_MODELS) {
      expect(setModel(model)).toBe(model);
    }
  });

  test('aliases are accepted, because the factory resolves them', () => {
    for (const alias of ['indus', 'gpt', 'r1', 'search', 'tunnel']) {
      expect(setModel(alias)).toBe(alias);
    }
  });

  test('sarvam is accepted — the regression that started this', () => {
    expect(setModel('sarvam')).toBe('sarvam');
    expect(setModel('sarvam-api')).toBe('sarvam-api');
  });

  test('an unknown model is rejected and leaves the previous value intact', () => {
    expect(setModel('definitely-not-a-model')).toBe('deepseek');
  });

  test('the whitelist is derived, not hand-maintained', () => {
    // If someone re-adds a literal list, adding an adapter silently breaks it
    // again. Assert the config delegates to the factory.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'config.js'), 'utf8');

    expect(src).toContain('isKnownModel');
    expect(src).toContain("require('./adapter-factory')");
    // The old literal whitelist must not come back.
    expect(src).not.toMatch(/MODEL\s*:\s*v => \['deepseek'/);
  });

  test('case is irrelevant', () => {
    expect(setModel('SARVAM')).toBe('SARVAM');
  });
});
