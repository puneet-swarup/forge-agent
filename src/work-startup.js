// src/work-startup.js — Startup orchestration for FORGE_TODO.md / SESSION_CONTEXT.md.
//
// Phase 2: detect pending work and prompt the user to continue.
// Phase 3: `--auto` (-a) runs FORGE_TODO.md items unattended. Auto mode applies
//          to FORGE_TODO.md ONLY — never to SESSION_CONTEXT.md, which is always
//          advisory/read-only context.
'use strict';

const {
  detectPendingWork,
  readTodo,
  formatNotice,
  markTodoDone,
  TODO_FILE,
  CONTEXT_FILE,
} = require('./todo-manager');

// ─────────────────────────────────────────────
//  Interactive yes/no prompt
// ─────────────────────────────────────────────

/**
 * Ask a yes/no question on the terminal. Returns true for yes.
 * In a non-TTY environment (piped/CI) it defaults to `def`.
 */
function askYesNo(question, def = false) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || !stdout.isTTY) {
      return resolve(def);
    }

    stdout.write(question + (def ? ' [Y/n] ' : ' [y/N] '));
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode && stdin.setRawMode(false); } catch (_) {}
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk) => {
      const s = chunk.toString();
      const answer = s.trim().toLowerCase();
      stdin.removeListener('data', onData);
      try { stdin.setRawMode && stdin.setRawMode(!!wasRaw); } catch (_) {}
      stdin.pause();
      stdout.write('\n');
      if (answer === '') return resolve(def);
      resolve(answer === 'y' || answer === 'yes');
    };
    stdin.on('data', onData);
  });
}

// ─────────────────────────────────────────────
//  Main entry
// ─────────────────────────────────────────────

/**
 * Called from index.js main() BEFORE the browser launches.
 * Mutates `args` to inject the pending-work context and, in auto mode, sets
 * `args.autoTask` to the first open TODO item so the agent can run it.
 *
 * @param {Object} ctx
 * @param {Object} ctx.args    parsed CLI args (mutated)
 * @param {Object} ctx.config  live config
 * @param {Object} ctx.logger
 * @returns {Promise<{ proceed:boolean, mode:string, todo?:object, context?:object }>}
 */
async function preparePendingWork({ args, config, logger }) {
  const projectDir = (config && config.WORKING_DIR) || process.cwd();
  const pending = detectPendingWork(projectDir);

  if (!pending.hasAny) {
    return { proceed: true, mode: 'normal' };
  }

  // ── Auto mode: FORGE_TODO.md only ──────────────────────────────────────────
  if (args.auto) {
    if (pending.todo && pending.todo.open.length > 0) {
      const first = pending.todo.open[0];
      logger.info('\n🤖 --auto: ' + pending.todo.open.length + ' open TODO item(s). Starting with: "' + first.text + '"\n');
      args.autoTask = first.text;
      args.todoFile = pending.todo.file;
      // Keep any advisory context available (read-only) if present.
      if (pending.context) args.contextFile = pending.context.file;
      return { proceed: true, mode: 'auto', todo: pending.todo, context: pending.context };
    }
    // Auto requested but no open TODO items.
    if (!args.task) {
      logger.warn('\
🤖 --auto: no open FORGE_TODO.md items and no task given. Nothing to do.\
');
      return { proceed: false, mode: 'auto-empty', todo: pending.todo, context: pending.context };
    }
    return { proceed: true, mode: 'auto-noop', todo: pending.todo, context: pending.context };
  }

  // ── Interactive mode: prompt ───────────────────────────────────────────────
  logger.info(formatNotice(pending));

  const yes = await askYesNo('\
Continue from this work?');

  if (!yes) {
    // On "no": offer to remove a stale SESSION_CONTEXT.md so it doesn't nag.
    if (pending.context) {
      try {
        const fs = require('fs');
        fs.unlinkSync(pending.context.file);
        logger.dim('  Removed stale SESSION_CONTEXT.md.');
      } catch (_) { /* ignore */ }
    }
    return { proceed: true, mode: 'declined', todo: pending.todo, context: pending.context };
  }

  // User said yes: expose the files so the agent can seed context.
  if (pending.todo)    args.todoFile    = pending.todo.file;
  if (pending.context) args.contextFile = pending.context.file;

  return { proceed: true, mode: 'resumed', todo: pending.todo, context: pending.context };
}

module.exports = {
  preparePendingWork,
  askYesNo,
  // re-exported helpers for convenience/testing
  detectPendingWork,
  readTodo,
  markTodoDone,
  TODO_FILE,
  CONTEXT_FILE,
};
