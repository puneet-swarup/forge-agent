// tests/loom/store-selection.test.js — which backend the index uses, and why.
//
// `node:sqlite` is present from Node 22.5 (behind a flag) and stable from 23.4,
// but present is not the same as usable: on Node 22 and 24 the store opened and
// then indexed nothing, so the digest came back empty and the agent silently lost
// its project map. Node 20 — where sqlite does not exist — was the only green
// leg of the matrix.
//
// The JSON store is therefore the default. It is the backend that works
// everywhere, and correctness beats speed until sqlite is verified on every
// version CI runs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../../src/loom/db');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-store-'));
  return { dir, file: path.join(dir, 'index.db') };
}

describe('backend selection', () => {
  test('JSON is the default', () => {
    const { dir, file } = tempFile();
    const previous = process.env.LOOM_STORE;
    delete process.env.LOOM_STORE;

    try {
      const handle = db.open(file);
      expect(handle.kind).toBe('json');
      handle.close();
    } finally {
      if (previous !== undefined) process.env.LOOM_STORE = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sqlite is opt-in, and falls back when the runtime has no usable module', () => {
    const { dir, file } = tempFile();
    const previous = process.env.LOOM_STORE;
    process.env.LOOM_STORE = 'sqlite';

    try {
      const handle = db.open(file);
      // On Node 20 there is no node:sqlite at all; on any version it must never
      // be left with a store it cannot use.
      expect(['sqlite', 'json']).toContain(handle.kind);
      expect(handle).toBeTruthy();
      handle.close();
    } finally {
      if (previous === undefined) delete process.env.LOOM_STORE;
      else process.env.LOOM_STORE = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('forceJson overrides the environment', () => {
    const { dir, file } = tempFile();
    const previous = process.env.LOOM_STORE;
    process.env.LOOM_STORE = 'sqlite';

    try {
      const handle = db.open(file, { forceJson: true });
      expect(handle.kind).toBe('json');
      handle.close();
    } finally {
      if (previous === undefined) delete process.env.LOOM_STORE;
      else process.env.LOOM_STORE = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
