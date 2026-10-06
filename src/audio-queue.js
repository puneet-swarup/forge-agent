// src/audio-queue.js — Cross-process async audio queue (Items 3 & 4)
//
// Problems solved:
//   Item 4 — speech/alarm must NOT block the agent loop. Tools enqueue and
//            return immediately; a detached drainer process does playback.
//   Item 3 — multiple instances must play SEQUENTIALLY (never overlap) and
//            each utterance is prefixed with its session name so the user
//            knows which agent is reporting.
//
// Design:
//   - Items are individual files in a queue directory (race-free: appenders
//     only create new files; the drainer only reads+unlinks old ones).
//   - A single cross-process lock guarantees only one drainer plays at once.
//   - The drainer is spawned detached, so it outlives the tool call and does
//     not occupy the agent's event loop.
//
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { speak, raiseAlarm, audioDisabled } = require('./audio');

// ─────────────────────────────────────────────
//  Paths & configuration
// ─────────────────────────────────────────────

const BASE_DIR = process.env.FORGE_AUDIO_DIR
  ? path.resolve(process.env.FORGE_AUDIO_DIR)
  : path.join(os.homedir(), '.deepseek-agent');

const QUEUE_DIR = path.join(BASE_DIR, 'audio-queue');
const LOCK_FILE = path.join(BASE_DIR, 'audio.lock');

const LOCK_STALE_MS = 60_000; // steal a lock older than this
const GAP_MS = 150;           // pause between utterances (avoids overlap artifacts)
// How long a drainer waits for follow-up items before exiting. Keeps it hot
// across a turn so back-to-back announcements avoid repeated cold starts.
const LINGER_MS = Number(process.env.FORGE_AUDIO_LINGER_MS || 800);

/** Base directory holding the queue + lock (exposed for tests/diagnostics). */
function queueDir() { return QUEUE_DIR; }
function lockFile() { return LOCK_FILE; }

/** Human label for the current instance. */
function sessionLabel() {
  return process.env.FORGE_SESSION_NAME
    || process.env.FORGE_ROLE
    || 'agent';
}

/** True when the user asked for synchronous (blocking) playback. */
function syncForced() {
  const v = process.env.FORGE_AUDIO_SYNC;
  return v === '1' || v === 'true' || v === 'yes';
}

function _ensureDirs() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  } catch (_) { /* ignore */ }
}

let _seq = 0;
function _itemFileName() {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = String(Date.now()).padStart(15, '0');
  const pid = process.pid;
  const seq = String(_seq++).padStart(4, '0');
  return `${ts}-${pid}-${seq}-${rand}.json`;
}

/** Append an item to the queue (race-free: creates one new file). */
function enqueue(item) {
  _ensureDirs();
  const record = {
    kind: item.kind || 'speak',
    text: item.text || '',
    duration: item.duration || 5,
    session: item.session || sessionLabel(),
    ts: Date.now(),
  };
  const file = path.join(QUEUE_DIR, _itemFileName());
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  return record;
}

function enqueueSpeak(text, opts = {}) {
  return enqueue({ kind: 'speak', text, session: opts.session });
}

function enqueueAlarm(duration = 5, opts = {}) {
  return enqueue({ kind: 'alarm', duration, session: opts.session });
}

// ─────────────────────────────────────────────
//  Cross-process lock
// ─────────────────────────────────────────────

function _lockAgeMs() {
  try {
    const st = fs.statSync(LOCK_FILE);
    return Date.now() - st.mtimeMs;
  } catch (_) {
    return Infinity;
  }
}

function _tryAcquireLock() {
  _ensureDirs();
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx'); // exclusive create — atomic
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Steal a stale lock left by a crashed drainer.
      if (_lockAgeMs() > LOCK_STALE_MS) {
        try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
        try {
          const fd = fs.openSync(LOCK_FILE, 'wx');
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
          fs.closeSync(fd);
          return true;
        } catch (_) { return false; }
      }
      return false;
    }
    return false;
  }
}

function _releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
}

/** Refresh the lock mtime so long playback isn't mistaken for a stale lock. */
function _touchLock() {
  try { const now = new Date(); fs.utimesSync(LOCK_FILE, now, now); } catch (_) {}
}

// ─────────────────────────────────────────────
//  Queue draining (runs inside the drainer process)
// ─────────────────────────────────────────────

/** List queue item files, oldest first. */
function _listItems() {
  let names = [];
  try { names = fs.readdirSync(QUEUE_DIR); } catch (_) { return []; }
  return names
    .filter(n => n.endsWith('.json'))
    .sort() // filename is zero-padded timestamp prefix => chronological
    .map(n => path.join(QUEUE_DIR, n));
}

function _sleep(ms) {
  // Synchronous sleep (Atomics.wait) — the drainer is detached and owns no
  // agent event loop, so a blocking wait is fine and CPU-cheap.
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, Math.max(0, ms));
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy fallback */ }
  }
}

function _playOne(record) {
  const label = record.session ? '[' + record.session + '] ' : '';
  try {
    if (record.kind === 'alarm') {
      return raiseAlarm(record.duration || 5);
    }
    const text = label + (record.text || 'Task complete.');
    return speak(text);
  } catch (_) {
    return 'error';
  }
}

/**
 * Drain the whole queue sequentially. Returns the number of items played.
 * Safe to call from any process; only the lock holder actually plays.
 */
function drain(opts = {}) {
  if (audioDisabled()) return 0;
  if (!_tryAcquireLock()) return 0;

  // Linger briefly after the queue empties so a drainer stays "hot" across a
  // single turn (speak + alarm, or two rapid call_user invocations). Without
  // this, each utterance would pay a fresh detached-process cold start.
  const lingerMs = opts.lingerMs != null ? opts.lingerMs : LINGER_MS;

  let played = 0;
  try {
    for (;;) {
      const items = _listItems();

      if (items.length === 0) {
        // Wait out the linger window, then re-check once more before exiting.
        if (lingerMs > 0) {
          _touchLock();
          _sleep(lingerMs);
          if (_listItems().length === 0) break;
          continue;
        }
        break;
      }

      for (const file of items) {
        let record;
        try {
          record = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (_) {
          try { fs.unlinkSync(file); } catch (__) {}
          continue;
        }

        _touchLock();
        _playOne(record);
        played++;
        try { fs.unlinkSync(file); } catch (_) {}
        _sleep(GAP_MS);
        _touchLock();
      }
    }
  } finally {
    _releaseLock();
  }
  return played;
}

// ─────────────────────────────────────────────
//  Detached drainer
// ─────────────────────────────────────────────

/**
 * Spawn a detached process that drains the queue, then returns immediately.
 * Detached + unref'd so it never keeps the agent process alive.
 *
 * IMPORTANT: we spawn on EVERY enqueue rather than once per process. The
 * previous one-shot latch meant that after the first drainer exited (which it
 * does as soon as the queue is momentarily empty), no later item was ever
 * played until some other process happened to drain — which is why
 * announcements arrived a step late. drain() takes a cross-process lock, so a
 * redundant drainer simply finds the lock held and exits immediately; it is
 * cheap and cannot cause overlap or dropped items.
 */
function _spawnDrainer() {
  try {
    const modulePath = require.resolve('./audio-queue');
    const script =
      'try{require(' + JSON.stringify(modulePath) + ').drain();}catch(e){}';

    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (_) {
    // If spawning fails, fall back to draining inline (still non-fatal).
    try { drain(); } catch (__) { /* ignore */ }
  }
}

// ─────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────

/**
 * Speak without blocking the caller. Enqueues and kicks the drainer.
 * Returns a status string describing what was queued.
 */
function speakAsync(text, opts = {}) {
  if (audioDisabled()) return '[call_user] Audio is disabled (FORGE_NO_AUDIO).';

  const record = enqueueSpeak(text, opts);

  // Optional escape hatch: block for deterministic/CI playback.
  if (syncForced()) {
    const backend = speak((record.session ? '[' + record.session + '] ' : '') + text);
    return '[call_user] Spoke (sync) via ' + backend + ': ' + text;
  }

  _spawnDrainer();
  return '[call_user] Queued speech for session "' + record.session + '": ' + text;
}

/**
 * Play an alarm without blocking the caller. Enqueues and kicks the drainer.
 */
function alarmAsync(duration = 5, opts = {}) {
  if (audioDisabled()) return '[raise_alarm] Audio is disabled (FORGE_NO_AUDIO).';

  const record = enqueueAlarm(duration, opts);

  if (syncForced()) {
    const backend = raiseAlarm(duration);
    if (backend === 'disabled') return '[raise_alarm] Audio is disabled (FORGE_NO_AUDIO).';
    return '[raise_alarm] Alarm played (sync) via ' + backend + ' for ' + duration + 's.';
  }

  _spawnDrainer();
  return '[raise_alarm] Queued alarm for session "' + record.session + '" (' + duration + 's).';
}

module.exports = {
  speakAsync,
  alarmAsync,
  enqueueSpeak,
  enqueueAlarm,
  drain,
  queueDir,
  lockFile,
  sessionLabel,
};

// Allow `node src/audio-queue.js` to act as a manual drainer.
if (require.main === module) {
  try { drain(); } catch (_) { /* ignore */ }
}
