// tests/loom/config.test.js — spec §11: parse, validate, never throw.

'use strict';

const config = require('../../src/loom/config');

describe('loom/config', () => {
  beforeEach(() => config.resetWarnings());

  it('returns the spec defaults for an empty environment', () => {
    const cfg = config.load({}, { silent: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.digestTokens).toBe(1200);
    expect(cfg.maxFiles).toBe(2000);
    expect(cfg.maxFileBytes).toBe(512000);
    expect(cfg.modelSummaries).toBe(false);
    expect(cfg.summaryModel).toBe('ollama');
    expect(cfg.worker).toBe(true);
    expect(cfg.watch).toBe(false);
    expect(cfg.heatHalfLifeDays).toBe(14);
    expect(cfg.rebuildThreshold).toBe(0.3);
    expect(cfg.rehashDays).toBe(7);
    expect(cfg.warnings).toEqual([]);
  });

  it('reads valid overrides', () => {
    const cfg = config.load({
      LOOM_ENABLED: '0',
      LOOM_DIGEST_TOKENS: '2000',
      LOOM_MAX_FILES: '50',
      LOOM_MAX_FILE_BYTES: '4096',
      LOOM_MODEL_SUMMARIES: '1',
      LOOM_SUMMARY_MODEL: 'deepseek',
      LOOM_WORKER: '0',
      LOOM_WATCH: '1',
      LOOM_HEAT_HALFLIFE_DAYS: '30',
      LOOM_REBUILD_THRESHOLD: '0.5',
      LOOM_REHASH_DAYS: '3',
      LOOM_DIR: '/somewhere/loom',
    }, { silent: true });

    expect(cfg.enabled).toBe(false);
    expect(cfg.digestTokens).toBe(2000);
    expect(cfg.maxFiles).toBe(50);
    expect(cfg.maxFileBytes).toBe(4096);
    expect(cfg.modelSummaries).toBe(true);
    expect(cfg.summaryModel).toBe('deepseek');
    expect(cfg.worker).toBe(false);
    expect(cfg.watch).toBe(true);
    expect(cfg.heatHalfLifeDays).toBe(30);
    expect(cfg.rebuildThreshold).toBe(0.5);
    expect(cfg.rehashDays).toBe(3);
    expect(cfg.dir).toBe('/somewhere/loom');
    expect(cfg.warnings).toEqual([]);
  });

  it('accepts true/false as booleans', () => {
    const cfg = config.load({ LOOM_ENABLED: 'false', LOOM_WATCH: 'true' }, { silent: true });
    expect(cfg.enabled).toBe(false);
    expect(cfg.watch).toBe(true);
  });

  it('falls back to the default and records a warning for each invalid value', () => {
    const cfg = config.load({
      LOOM_ENABLED: 'yes',
      LOOM_DIGEST_TOKENS: '10',
      LOOM_MAX_FILES: 'abc',
      LOOM_REBUILD_THRESHOLD: '2',
      LOOM_REHASH_DAYS: '0',
    }, { silent: true });

    expect(cfg.enabled).toBe(true);
    expect(cfg.digestTokens).toBe(1200);
    expect(cfg.maxFiles).toBe(2000);
    expect(cfg.rebuildThreshold).toBe(0.3);
    expect(cfg.rehashDays).toBe(7);
    expect(cfg.warnings).toHaveLength(5);
    expect(cfg.warnings.join('\n')).toMatch(/LOOM_DIGEST_TOKENS="10"/);
  });

  it('names the variable and the offending value in the warning', () => {
    const cfg = config.load({ LOOM_MAX_FILES: '0' }, { silent: true });
    expect(cfg.warnings[0]).toContain('LOOM_MAX_FILES');
    expect(cfg.warnings[0]).toContain('"0"');
    expect(cfg.warnings[0]).toContain('using default');
  });

  it('rejects a non-integer where an integer is required', () => {
    const cfg = config.load({ LOOM_MAX_FILES: '1.5' }, { silent: true });
    expect(cfg.maxFiles).toBe(2000);
    expect(cfg.warnings).toHaveLength(1);
  });

  it('never throws, whatever the environment holds', () => {
    expect(() => config.load({
      LOOM_DIGEST_TOKENS: '',
      LOOM_MAX_FILES: '   ',
      LOOM_REBUILD_THRESHOLD: 'NaN',
      LOOM_DIR: '',
    }, { silent: true })).not.toThrow();

    expect(() => config.load(null, { silent: true })).not.toThrow();
    expect(config.load(undefined, { silent: true }).enabled).toBe(true);
  });

  it('treats an empty string as unset', () => {
    const cfg = config.load({ LOOM_MAX_FILES: '' }, { silent: true });
    expect(cfg.maxFiles).toBe(2000);
    expect(cfg.warnings).toEqual([]);
  });

  it('logs each bad value at most once per process', () => {
    config.resetWarnings();
    const spy = jest.spyOn(require('../../src/logger'), 'warn').mockImplementation(() => {});
    config.load({ LOOM_MAX_FILES: '0' }, { silent: false });
    config.load({ LOOM_MAX_FILES: '0' }, { silent: false });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    config.resetWarnings();
  });

  it('exposes the env var names it reads', () => {
    const names = config.envNames();
    expect(names).toContain('LOOM_ENABLED');
    expect(names).toContain('LOOM_DIGEST_TOKENS');
    expect(names).toHaveLength(config.SPEC.length);
  });
});
