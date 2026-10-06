// src/session-context.js — Durable, gitignored working memory for a session.
//
// Writes a SESSION_CONTEXT.md file at the project root that records what a
// session is doing: its goal, decisions, progress, and the current git state.
// The file survives remote context compaction, so it can be re-fed to the model
// after the model has forgotten earlier turns.
//
// Lifecycle:
//   create()  at session start
//   update()  after tool batches / git operations
//   read()    to re-feed the model after compaction
//   destroy() at session end (cleanup)
//
// The file is ALWAYS gitignored and is NEVER meant to be committed.
'use strict';

const fs   = require('fs');
const path = require('path');

const FILENAME = 'SESSION_CONTEXT.md';
const GITIGNORE_ENTRY = 'SESSION_CONTEXT.md';

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function contextPath(projectDir) {
  return path.join(path.resolve(projectDir || process.cwd()), FILENAME);
}

/** Format a Date/ISO string as a short HH:MM time for bullet prefixes. */
function shortTime(d) {
  const date = d instanceof Date ? d : new Date(d || Date.now());
  if (isNaN(date.getTime())) return '--:--';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

/** Collapse a multi-line string into a single safe line. */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────
//  Git state (best-effort, never throws)
// ─────────────────────────────────────────────

/**
 * Collect current git state for the project. Never throws; returns nulls if
 * git is unavailable or the directory is not a repo.
 */
function readGitState(projectDir) {
  const cwd = path.resolve(projectDir || process.cwd());
  try {
    const branch = _git(cwd, 'rev-parse --abbrev-ref HEAD');
    const head   = _git(cwd, 'rev-parse --short HEAD');
    const subject = _git(cwd, 'log -1 --pretty=%s');
    const dirty  = _git(cwd, 'status --porcelain');
    const dirtyFiles = dirty
      ? dirty.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 20)
      : [];
    return {
      branch: branch || null,
      head: head || null,
      subject: subject || null,
      dirty: dirtyFiles,
    };
  } catch (_) {
    return { branch: null, head: null, subject: null, dirty: [] };
  }
}

function _git(cwd, args) {
  try {
    const { execSync } = require('child_process');
    return execSync('git ' + args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch (_) {
    return '';
  }
}

// ─────────────────────────────────────────────
//  .gitignore guard
// ─────────────────────────────────────────────

/**
 * Ensure SESSION_CONTEXT.md is present in the project's .gitignore.
 * Creates .gitignore if missing. Returns a status object.
 *
 * @returns {{ status: 'present'|'added'|'created'|'error', path: string, error?: string }}
 */
function ensureGitignored(projectDir) {
  const dir = path.resolve(projectDir || process.cwd());
  const gi  = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(gi)) {
      fs.writeFileSync(gi, '# Added by Forge Agent\n' + GITIGNORE_ENTRY + '\n', 'utf8');
      return { status: 'created', path: gi };
    }
    const content = fs.readFileSync(gi, 'utf8');
    const lines = content.split(/\r?\n/).map(l => l.trim());
    const already = lines.some(l => l === GITIGNORE_ENTRY || l === '/' + GITIGNORE_ENTRY);
    if (already) return { status: 'present', path: gi };
    const sep = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gi, sep + '\n# Forge Agent session memory (never commit)\n' + GITIGNORE_ENTRY + '\n', 'utf8');
    return { status: 'added', path: gi };
  } catch (e) {
    return { status: 'error', path: gi, error: e.message };
  }
}

// ─────────────────────────────────────────────
//  SessionContext
// ─────────────────────────────────────────────

class SessionContext {
  /**
   * @param {Object} opts
   * @param {string} opts.projectDir  project root (default: cwd)
   * @param {string} opts.sessionName session/instance name
   * @param {string} opts.task        the task being worked on
   * @param {boolean} opts.autoGitignore  add entry to .gitignore (default true)
   */
  constructor(opts = {}) {
    this.projectDir   = path.resolve(opts.projectDir || process.cwd());
    this.sessionName  = opts.sessionName || process.env.FORGE_SESSION_NAME || 'default';
    this.task         = oneLine(opts.task || '');
    this.autoGitignore = opts.autoGitignore !== false;
    this.file         = contextPath(this.projectDir);

    this.data = {
      session : this.sessionName,
      started : nowIso(),
      working : this.projectDir,
      task    : this.task,
      goal    : this.task,
      decisions: [],   // { time, text }
      progress : [],   // { done, text }
      open     : [],   // string
      git      : { branch: null, head: null, subject: null, dirty: [] },
    };
  }

  exists() {
    try { return fs.existsSync(this.file); } catch (_) { return false; }
  }

  /**
   * Create the file at session start. If a file already exists it is read into
   * memory first (so a resumed session keeps its history), then rewritten.
   */
  create() {
    try {
      if (this.autoGitignore) {
        this.gitignore = ensureGitignored(this.projectDir);
      }
      if (this.exists()) {
        const prior = this.read();
        if (prior && prior.data) {
          // Preserve prior decisions/progress/open questions, keep new task.
          this.data.decisions = prior.data.decisions || [];
          this.data.progress  = prior.data.progress  || [];
          this.data.open      = prior.data.open      || [];
          this.data.started   = prior.data.started   || this.data.started;
        }
      }
      this.refreshGit();
      this._write();
      return { ok: true, file: this.file, resumed: this._resumed };
    } catch (e) {
      return { ok: false, error: e.message, file: this.file };
    }
  }

  /** Refresh git state from the repo. */
  refreshGit() {
    this.data.git = readGitState(this.projectDir);
    return this.data.git;
  }

  /** Record a decision (used by the model/agent). */
  addDecision(text) {
    const t = oneLine(text);
    if (!t) return;
    this.data.decisions.push({ time: shortTime(), text: t });
  }

  /** Record a progress item. */
  addProgress(text, done = false) {
    const t = oneLine(text);
    if (!t) return;
    this.data.progress.push({ done: !!done, text: t });
  }

  /** Mark the Nth (1-based, or by substring) progress item done. */
  completeProgress(match) {
    const item = typeof match === 'number'
      ? this.data.progress[match - 1]
      : this.data.progress.find(p => p.text.includes(match));
    if (item) item.done = true;
    return !!item;
  }

  addOpenQuestion(text) {
    const t = oneLine(text);
    if (t) this.data.open.push(t);
  }

  /** Persist current state to disk. */
  update() {
    try {
      this.refreshGit();
      this._write();
      return { ok: true, file: this.file };
    } catch (e) {
      return { ok: false, error: e.message, file: this.file };
    }
  }

  /** Read the file from disk back into memory. */
  read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ok: true, file: this.file, data: this._parse(raw), raw };
    } catch (e) {
      return { ok: false, error: e.message, file: this.file, data: null, raw: null };
    }
  }

  /** Return the file text suitable for re-feeding the model. */
  asContextString() {
    try {
      if (this.exists()) return fs.readFileSync(this.file, 'utf8');
    } catch (_) { /* fall through */ }
    return this._render();
  }

  /** Delete the file (session-end cleanup). */
  destroy() {
    try {
      if (this.exists()) fs.unlinkSync(this.file);
      return { ok: true, file: this.file };
    } catch (e) {
      return { ok: false, error: e.message, file: this.file };
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  _write() {
    fs.writeFileSync(this.file, this._render(), 'utf8');
  }

  _render() {
    const d = this.data;
    const L = [];
    L.push('<!-- AUTO-GENERATED by Forge Agent. DO NOT COMMIT. Deleted at session end. -->');
    L.push('# SESSION_CONTEXT - ' + d.session);
    L.push('');
    L.push('- Session : ' + d.session);
    L.push('- Started : ' + d.started);
    L.push('- Working : ' + d.working);
    L.push('- Task    : "' + d.task + '"');
    L.push('');
    L.push('## Goal');
    L.push(d.goal || d.task || '(not set)');
    L.push('');
    L.push('## Decisions');
    L.push(d.decisions.length ? d.decisions.map(x => '- [' + x.time + '] ' + x.text).join('\n') : '- (none yet)');
    L.push('');
    L.push('## Progress');
    L.push(d.progress.length ? d.progress.map(p => '- [' + (p.done ? 'x' : ' ') + '] ' + p.text).join('\n') : '- [ ] (none yet)');
    L.push('');
    L.push('## Current State (auto-synced with git)');
    const g = d.git || {};
    L.push('- Branch : ' + (g.branch || '(unknown)'));
    L.push('- HEAD   : ' + (g.head ? g.head + (g.subject ? ' "' + g.subject + '"' : '') : '(none)'));
    L.push('- Dirty  : ' + (g.dirty && g.dirty.length ? g.dirty.join(', ') : '(clean)'));
    L.push('');
    L.push('## Open Questions');
    L.push(d.open.length ? d.open.map(q => '- ' + q).join('\n') : '- (none)');
    L.push('');
    return L.join('\n');
  }

  _parse(raw) {
    // Minimal round-trip parser: recover decisions/progress/open lines.
    const out = { session: this.sessionName, decisions: [], progress: [], open: [] };
    const section = { current: null };
    for (const line of raw.split(/\r?\n/)) {
      if (/^##\s+Decisions/i.test(line)) { section.current = 'decisions'; continue; }
      if (/^##\s+Progress/i.test(line))  { section.current = 'progress';  continue; }
      if (/^##\s+Open Questions/i.test(line)) { section.current = 'open'; continue; }
      if (/^##\s+/.test(line)) { section.current = null; continue; }
      const m = line.match(/^-\s+(.*)$/);
      if (!m) continue;
      const body = m[1];
      if (section.current === 'decisions') {
        const dm = body.match(/^\[(\d{2}:\d{2})\]\s+(.*)$/);
        out.decisions.push({ time: dm ? dm[1] : '--:--', text: dm ? dm[2] : body });
      } else if (section.current === 'progress') {
        const pm = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (pm) out.progress.push({ done: pm[1].toLowerCase() === 'x', text: pm[2] });
      } else if (section.current === 'open') {
        if (body !== '(none)') out.open.push(body);
      }
    }
    return out;
  }
}

// ─────────────────────────────────────────────
//  Singleton factory (one per project dir)
// ─────────────────────────────────────────────

let _instance = null;

/**
 * Get (or create) the SessionContext for a project directory.
 * @param {string} projectDir
 * @param {Object} [opts]  extra opts when creating a new instance
 */
function getSessionContext(projectDir, opts = {}) {
  const dir = path.resolve(projectDir || process.cwd());
  if (!_instance || _instance.projectDir !== dir) {
    _instance = new SessionContext({ projectDir: dir, ...opts });
  }
  return _instance;
}

/** Reset the cached singleton (for tests). */
function resetSessionContext() {
  _instance = null;
}

module.exports = {
  SessionContext,
  getSessionContext,
  resetSessionContext,
  ensureGitignored,
  readGitState,
  contextPath,
  FILENAME,
  GITIGNORE_ENTRY,
};
