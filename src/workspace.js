// src/workspace.js — every mutating file operation goes through here.
//
// Why this module exists
// ---------------------
// An autonomous agent will eventually write the wrong thing. The only question
// is whether the user can get back. Before this module, write_file called
// fs.writeFileSync() straight onto the target: a crash mid-write truncated the
// file, a model that "rewrote" a file it had never read destroyed its contents
// silently (the tool still reported success), and there was no undo.
//
// Guarantees
// ----------
//   1. Atomic  — content goes to a sibling temp file, is fsync'd, then renamed
//                over the target. A killed process leaves the original intact.
//   2. Snapshot — before the FIRST mutation of a path in a session, its
//                content is copied into the snapshot directory. Rolling back
//                therefore undoes everything this session did to that file
//                (a session baseline, not a single-step undo).
//   3. Read-before-write — overwriting an existing file the agent has neither
//                read nor written this session is refused, with an instruction
//                to read it first. This turns a prompt rule into a guarantee.
//   4. Diff    — every successful write returns a capped unified diff, so the
//                model gets a better signal and the user can see what changed.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { generateDiff } = require('./differ');

const MAX_DIFF_LINES = 40;

class WorkspaceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.retryable = false;
  }
}

class Workspace {
  /**
   * @param {object} opts
   * @param {string} opts.root         working directory (for relative labels)
   * @param {string} opts.snapshotDir  where pre-images are kept
   * @param {boolean} [opts.requireReadBeforeWrite]
   */
  constructor(opts = {}) {
    this.root = path.resolve(opts.root || process.cwd());
    this.snapshotDir = path.resolve(opts.snapshotDir || path.join(this.root, '.forge-snapshots'));
    this.requireReadBeforeWrite = opts.requireReadBeforeWrite !== false;

    this._seen = new Map();        // absolute path -> content hash last seen
    this._snapshots = new Map();   // absolute path -> snapshot file
  }

  // ── session bookkeeping ────────────────────────────────────────────────

  _key(abs) {
    return path.resolve(abs);
  }

  /**
   * Record that the agent has seen this file's contents, in its current state.
   * Storing the hash (not just the path) means an external change — a
   * run_command, a git checkout — invalidates the permission to overwrite.
   *
   * @param {string} absPath
   * @param {string} [content]  known content; read from disk when omitted
   */
  markSeen(absPath, content) {
    const abs = this._key(absPath);
    try {
      const body = content !== undefined
        ? String(content)
        : (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
      this._seen.set(abs, this._hash(body));
    } catch (_) {
      this._seen.set(abs, null);
    }
  }

  /** Has the agent seen this path's CURRENT content? */
  hasSeen(absPath) {
    const abs = this._key(absPath);
    if (!this._seen.has(abs)) return false;
    if (!fs.existsSync(abs)) return true;          // seen, then deleted
    try {
      return this._seen.get(abs) === this._hash(fs.readFileSync(abs, 'utf8'));
    } catch (_) {
      return false;
    }
  }

  _hash(text) {
    return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
  }

  reset() {
    this._seen.clear();
    this._snapshots.clear();
  }

  // ── snapshots ──────────────────────────────────────────────────────────

  /**
   * Copy the current content of `absPath` aside, once per session.
   *
   * Once per session, deliberately: the snapshot is the state the file was in
   * before the agent first touched it, so `--rollback` undoes the whole session
   * rather than one step. Repeated writes keep the original baseline.
   *
   * @returns {string|null} snapshot path, or null when the file did not exist
   */
  snapshot(absPath) {
    const abs = this._key(absPath);
    if (this._snapshots.has(abs)) return this._snapshots.get(abs);
    if (!fs.existsSync(abs)) return null;

    try {
      const dest = this.snapshotPathFor(abs);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      this._snapshots.set(abs, dest);
      return dest;
    } catch (_) {
      // A failed snapshot must not block the write; it only removes undo.
      return null;
    }
  }

  /**
   * Deterministic snapshot location for a path.
   *
   * Deterministic (not per-process) so `forge-agent --rollback <path>` can find
   * the pre-image from a NEW process, after the session that wrote it is gone.
   * Files inside the working directory keep their relative path; anything else
   * is flattened under a hash.
   */
  snapshotPathFor(absPath) {
    const abs = this._key(absPath);
    const rel = path.relative(this.root, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return path.join(this.snapshotDir, rel + '.bak');
    }
    const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16);
    return path.join(this.snapshotDir, '_external', hash + '.bak');
  }

  /** Is there a snapshot available for this path? */
  hasSnapshot(absPath) {
    const abs = this._key(absPath);
    if (this._snapshots.has(abs)) return true;
    return fs.existsSync(this.snapshotPathFor(abs));
  }

  /** Restore the pre-image of a path, if one was taken. */
  rollback(absPath) {
    const abs = this._key(absPath);
    const snap = this._snapshots.get(abs) || this.snapshotPathFor(abs);
    if (!snap || !fs.existsSync(snap)) {
      throw new WorkspaceError(
        `No snapshot for ${this.label(abs)}. Snapshots are taken on the first ` +
        `write to a file in a session.`,
        'no_snapshot'
      );
    }
    fs.copyFileSync(snap, abs);
    return { restored: abs, from: snap };
  }

  /** Every snapshot taken this session. */
  listSnapshots() {
    return [...this._snapshots.entries()].map(([file, snap]) => ({ file, snapshot: snap }));
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /**
   * Write (create or overwrite) a file atomically.
   *
   * @param {string} absPath
   * @param {Buffer|string} content
   * @param {object} [opts]
   * @param {boolean} [opts.allowUnread]  bypass the read-before-write guard
   * @returns {{created: boolean, bytes: number, lines: number, diff: string, snapshot: string|null}}
   */
  write(absPath, content, opts = {}) {
    const abs = this._key(absPath);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const exists = fs.existsSync(abs);

    if (
      exists &&
      this.requireReadBeforeWrite &&
      !opts.allowUnread &&
      !this.hasSeen(abs)
    ) {
      throw new WorkspaceError(
        `Refusing to overwrite ${this.label(abs)}: it exists and its current ` +
        `contents have not been read in this session (or have changed since you ` +
        `read them). Call read_file first, or use replace_in_file to change only ` +
        `the part you need.`,
        'read_before_write'
      );
    }

    const before = exists ? fs.readFileSync(abs, 'utf8') : null;
    const snapshot = exists ? this.snapshot(abs) : null;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this._atomicWrite(abs, buffer);
    this.markSeen(abs, buffer.toString('utf8'));

    const after = buffer.toString('utf8');
    const diff = exists ? this._diff(before, after, abs) : '';

    return {
      created: !exists,
      bytes: buffer.length,
      lines: after.split('\n').length,
      diff,
      snapshot,
    };
  }

  /**
   * Append to a file atomically (create when missing).
   * @returns {{created: boolean, bytes: number, totalBytes: number, diff: string, snapshot: string|null}}
   */
  append(absPath, content) {
    const abs = this._key(absPath);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const exists = fs.existsSync(abs);
    const before = exists ? fs.readFileSync(abs, 'utf8') : '';
    const snapshot = exists ? this.snapshot(abs) : null;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const combined = before + buffer.toString('utf8');
    this._atomicWrite(abs, Buffer.concat([Buffer.from(before, 'utf8'), buffer]));
    this.markSeen(abs, combined);

    return {
      created: !exists,
      bytes: buffer.length,
      totalBytes: before.length + buffer.length,
      diff: this._diff(before, before + buffer.toString('utf8'), abs),
      snapshot,
    };
  }

  /** Delete a file after taking a snapshot, so it can be restored. */
  remove(absPath) {
    const abs = this._key(absPath);
    if (!fs.existsSync(abs)) {
      throw new WorkspaceError(`File not found: ${this.label(abs)}`, 'not_found');
    }
    const snapshot = this.snapshot(abs);
    fs.unlinkSync(abs);
    return { removed: abs, snapshot };
  }

  // ── internals ──────────────────────────────────────────────────────────

  _atomicWrite(abs, buffer) {
    const tmp = path.join(
      path.dirname(abs),
      `.${path.basename(abs)}.forge-tmp-${process.pid}`
    );

    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    try {
      fs.renameSync(tmp, abs);          // atomic on POSIX and on NTFS
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  /** Unified diff, capped so it cannot flood the model's context. */
  _diff(before, after, abs) {
    if (before === null || before === after) return '';
    try {
      const label = this.label(abs);
      const full = generateDiff(before, after, `a/${label}`, `b/${label}`);
      const lines = full.split('\n');
      if (lines.length <= MAX_DIFF_LINES) return full.trimEnd();
      return (
        lines.slice(0, MAX_DIFF_LINES).join('\n') +
        `\n… (diff truncated, ${lines.length - MAX_DIFF_LINES} more lines)`
      );
    } catch (_) {
      return '';
    }
  }

  /** Path relative to the working directory, for readable labels. */
  label(abs) {
    const rel = path.relative(this.root, abs);
    return rel.startsWith('..') ? abs : rel.split(path.sep).join('/');
  }
}

module.exports = { Workspace, WorkspaceError };
