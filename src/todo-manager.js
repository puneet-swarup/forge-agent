// src/todo-manager.js — FORGE_TODO.md reader + startup resume detection.
//
// Phase 2: at session start we look for FORGE_TODO.md (a persistent,
// human-authored task list) and SESSION_CONTEXT.md (ephemeral working memory
// from a previous run). If either exists we notify the user and ask whether to
// continue. Phase 3 builds on this with `--auto` (unattended TODO execution).
'use strict';

const fs   = require('fs');
const path = require('path');

const TODO_FILE    = 'FORGE_TODO.md';
const CONTEXT_FILE = 'SESSION_CONTEXT.md';

// ─────────────────────────────────────────────
//  FORGE_TODO.md parsing
// ─────────────────────────────────────────────

/**
 * Parse FORGE_TODO.md into a list of items.
 * Recognises markdown task lines:
 *   - [ ] open task
 *   - [x] done task
 *   * [ ] open task
 *   - open task          (treated as open)
 *
 * @param {string} content
 * @returns {Array<{text:string, done:boolean, line:number}>}
 */
function parseTodo(content) {
  const items = [];
  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // - [ ] text   /   - [x] text
    let m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      items.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x', line: i + 1 });
      continue;
    }
    // - text  (no checkbox => open item)
    m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m && m[1].trim()) {
      items.push({ text: m[1].trim(), done: false, line: i + 1 });
    }
  }
  return items;
}

/** Read + parse FORGE_TODO.md from a project dir. Returns null if absent. */
function readTodo(projectDir) {
  const file = path.join(path.resolve(projectDir || process.cwd()), TODO_FILE);
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    const items = parseTodo(content);
    return {
      file,
      items,
      open: items.filter(i => !i.done),
      done: items.filter(i => i.done),
    };
  } catch (e) {
    return { file, items: [], open: [], done: [], error: e.message };
  }
}

// ─────────────────────────────────────────────
//  Startup detection
// ─────────────────────────────────────────────

/**
 * Detect pending work in the project directory.
 *
 * @param {string} projectDir
 * @returns {{
 *   todo: object|null,
 *   context: { file:string, sessionName:string|null, ageMs:number|null }|null,
 *   hasAny: boolean
 * }}
 */
function detectPendingWork(projectDir) {
  const dir = path.resolve(projectDir || process.cwd());

  const todo = readTodo(dir);

  let context = null;
  const ctxFile = path.join(dir, CONTEXT_FILE);
  try {
    if (fs.existsSync(ctxFile)) {
      const stat = fs.statSync(ctxFile);
      let sessionName = null;
      try {
        const raw = fs.readFileSync(ctxFile, 'utf8');
        const m = raw.match(/^#\s*SESSION_CONTEXT\s*-\s*(.+)$/m);
        if (m) sessionName = m[1].trim();
      } catch (_) {}
      context = {
        file: ctxFile,
        sessionName,
        ageMs: Date.now() - stat.mtimeMs,
      };
    }
  } catch (_) { /* ignore */ }

  return { todo, context, hasAny: !!todo || !!context };
}

// ─────────────────────────────────────────────
//  Human-readable formatting
// ─────────────────────────────────────────────

function formatAge(ms) {
  if (ms == null) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

/** Build the multi-line notice shown when pending work is detected. */
function formatNotice(pending) {
  const lines = ['', '📋 Pending work detected:'];
  if (pending.todo && pending.todo.open.length >= 0) {
    lines.push(`  • FORGE_TODO.md      — ${pending.todo.open.length} open item(s)`);
  }
  if (pending.context) {
    const who = pending.context.sessionName ? `'${pending.context.sessionName}'` : '(unknown session)';
    lines.push(`  • SESSION_CONTEXT.md — previous session ${who} (${formatAge(pending.context.ageMs)})`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  TODO write-back
// ─────────────────────────────────────────────

/** Mark the first open item matching `text` as done and rewrite the file. */
function markTodoDone(projectDir, text) {
  const dir = path.resolve(projectDir || process.cwd());
  const file = path.join(dir, TODO_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*[-*]\s+)\[ \](\s+)(.*)$/);
      if (m && m[3].trim() === text) {
        lines[i] = m[1] + '[x]' + m[2] + m[3];
        changed = true;
        break;
      }
    }
    if (changed) fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return changed;
  } catch (_) {
    return false;
  }
}

module.exports = {
  parseTodo,
  readTodo,
  detectPendingWork,
  formatNotice,
  formatAge,
  markTodoDone,
  TODO_FILE,
  CONTEXT_FILE,
};
