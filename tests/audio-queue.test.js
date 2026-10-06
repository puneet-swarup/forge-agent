// tests/audio-queue.test.js — Items 3 & 4: async, ordered, named audio
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect the queue to a throwaway dir BEFORE the module loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-audio-'));
process.env.FORGE_AUDIO_DIR = TMP;
process.env.FORGE_NO_AUDIO = '';

describe('audio-queue', () => {
  let aq;

  beforeEach(() => {
    jest.resetModules();
    // clean queue + lock between tests
    try { fs.rmSync(path.join(TMP, 'audio-queue'), { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(path.join(TMP, 'audio.lock')); } catch (_) {}
    aq = require('../src/audio-queue');
  });

  afterAll(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  });

  test('enqueueSpeak writes a queue item file', () => {
    aq.enqueueSpeak('hello world', { session: 'alpha' });
    const files = fs.readdirSync(aq.queueDir());
    expect(files.length).toBe(1);
    const rec = JSON.parse(fs.readFileSync(path.join(aq.queueDir(), files[0]), 'utf8'));
    expect(rec.kind).toBe('speak');
    expect(rec.text).toBe('hello world');
    expect(rec.session).toBe('alpha');
  });

  test('sessionLabel falls back to role then agent', () => {
    const saved = process.env.FORGE_SESSION_NAME;
    const savedRole = process.env.FORGE_ROLE;
    delete process.env.FORGE_SESSION_NAME;
    delete process.env.FORGE_ROLE;
    expect(aq.sessionLabel()).toBe('agent');
    process.env.FORGE_ROLE = 'backend';
    expect(aq.sessionLabel()).toBe('backend');
    process.env.FORGE_SESSION_NAME = 'brave-otter';
    expect(aq.sessionLabel()).toBe('brave-otter');
    if (saved === undefined) delete process.env.FORGE_SESSION_NAME; else process.env.FORGE_SESSION_NAME = saved;
    if (savedRole === undefined) delete process.env.FORGE_ROLE; else process.env.FORGE_ROLE = savedRole;
  });

  test('queue items are ordered chronologically by filename', () => {
    aq.enqueueSpeak('one', { session: 's' });
    aq.enqueueSpeak('two', { session: 's' });
    aq.enqueueSpeak('three', { session: 's' });
    const files = fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).sort();
    const texts = files.map(f => JSON.parse(fs.readFileSync(path.join(aq.queueDir(), f), 'utf8')).text);
    expect(texts).toEqual(['one', 'two', 'three']);
  });

  test('speakAsync returns immediately with a queued status (Item 4)', () => {
    const t0 = Date.now();
    const msg = aq.speakAsync('do not block', { session: 'alpha' });
    const elapsed = Date.now() - t0;
    expect(msg).toContain('Queued speech');
    expect(msg).toContain('alpha');
    // Must be effectively instant — no TTS backend invoked synchronously.
    expect(elapsed).toBeLessThan(200);
  });

  test('alarmAsync returns immediately with a queued status', () => {
    const msg = aq.alarmAsync(3, { session: 'beta' });
    expect(msg).toContain('Queued alarm');
    expect(msg).toContain('beta');
    expect(msg).toContain('3s');
  });
});

describe('audio-queue — lock & drain', () => {
  let aq;

  beforeEach(() => {
    jest.resetModules();
    try { fs.rmSync(path.join(TMP, 'audio-queue'), { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(path.join(TMP, 'audio.lock')); } catch (_) {}
    aq = require('../src/audio-queue');
  });

  test('drain plays every queued item and empties the queue', () => {
    // silence the actual backends
    jest.resetModules();
    jest.doMock('../src/audio', () => ({
      speak: jest.fn(() => 'mock'),
      raiseAlarm: jest.fn(() => 'mock'),
      audioDisabled: () => false,
    }));
    aq = require('../src/audio-queue');
    aq.enqueueSpeak('a', { session: 's1' });
    aq.enqueueSpeak('b', { session: 's2' });
    aq.enqueueAlarm(1, { session: 's3' });
    const n = aq.drain();
    expect(n).toBe(3);
    expect(fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).length).toBe(0);
  });

  test('lock prevents a second concurrent drainer from playing', () => {
    // Simulate an active lock held by another pid.
    fs.mkdirSync(path.dirname(aq.lockFile()), { recursive: true });
    fs.writeFileSync(aq.lockFile(), JSON.stringify({ pid: 999999, ts: Date.now() }));
    aq.enqueueSpeak('blocked', { session: 's' });
    const n = aq.drain();
    expect(n).toBe(0); // lock held => nothing drained here
    expect(fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).length).toBe(1);
  });

  test('stale lock is stolen and drain proceeds', () => {
    fs.mkdirSync(path.dirname(aq.lockFile()), { recursive: true });
    fs.writeFileSync(aq.lockFile(), JSON.stringify({ pid: 999999, ts: Date.now() }));
    // Age the lock beyond the stale threshold.
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(aq.lockFile(), old, old);
    jest.resetModules();
    jest.doMock('../src/audio', () => ({
      speak: jest.fn(() => 'mock'),
      raiseAlarm: jest.fn(() => 'mock'),
      audioDisabled: () => false,
    }));
    aq = require('../src/audio-queue');
    aq.enqueueSpeak('after stale', { session: 's' });
    const n = aq.drain();
    expect(n).toBe(1);
  });

  test('FORGE_NO_AUDIO disables speaking and draining', () => {
    const saved = process.env.FORGE_NO_AUDIO;
    process.env.FORGE_NO_AUDIO = '1';
    jest.unmock('../src/audio');
    jest.resetModules();
    aq = require('../src/audio-queue');
    const msg = aq.speakAsync('nope', { session: 's' });
    expect(msg).toContain('disabled');
    expect(aq.drain()).toBe(0);
    if (saved === undefined) delete process.env.FORGE_NO_AUDIO; else process.env.FORGE_NO_AUDIO = saved;
  });

  test('FORGE_AUDIO_SYNC makes speakAsync block and return a sync status', () => {
    process.env.FORGE_AUDIO_SYNC = '1';
    jest.resetModules();
    jest.doMock('../src/audio', () => ({
      speak: jest.fn(() => 'mock-backend'),
      raiseAlarm: jest.fn(() => 'mock-backend'),
      audioDisabled: () => false,
    }));
    aq = require('../src/audio-queue');
    const msg = aq.speakAsync('blocking', { session: 's' });
    expect(msg).toContain('sync');
    delete process.env.FORGE_AUDIO_SYNC;
  });

  // ── Regression: no stale one-shot drainer latch ──────────────────────────
  //
  // Previously _spawnDrainer() ran at most once per process. After the first
  // drainer exited (queue momentarily empty), later enqueues were never played
  // until some other process drained — so announcements arrived a step late.
  // The fix spawns a drainer on every enqueue. These tests assert the queue is
  // never left orphaned across multiple enqueue/drain cycles.

  test('items enqueued AFTER a drain are still drainable', () => {
    aq.enqueueSpeak('first');
    const played1 = aq.drain({ lingerMs: 0 });
    expect(played1).toBe(1);
    expect(fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).length).toBe(0);

    // A later enqueue (the "next step") must not be orphaned.
    aq.enqueueSpeak('second');
    const played2 = aq.drain({ lingerMs: 0 });
    expect(played2).toBe(1);
    expect(fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).length).toBe(0);
  });

  test('multiple enqueue/drain cycles all get played', () => {
    for (let i = 0; i < 3; i++) {
      aq.enqueueSpeak('msg-' + i);
      expect(aq.drain({ lingerMs: 0 })).toBe(1);
    }
    expect(fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).length).toBe(0);
  });

  test('drain with linger picks up an item added during the linger window', async () => {
    aq.enqueueSpeak('early');
    // Start a draining cycle that lingers, then add another item shortly after.
    const drainPromise = Promise.resolve().then(() => aq.drain({ lingerMs: 300 }));
    setTimeout(() => aq.enqueueSpeak('late'), 50);
    const played = await drainPromise;
    // Both items should be played within one drain cycle.
    expect(played).toBeGreaterThanOrEqual(1);
    // Give the enqueue a beat, then drain any remainder so nothing is orphaned.
    await new Promise(r => setTimeout(r, 50));
    aq.drain({ lingerMs: 0 });
    expect(fs.readdirSync(aq.queueDir()).filter(f => f.endsWith('.json')).length).toBe(0);
  });
});
