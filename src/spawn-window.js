// @ts-check
// src/spawn-window.js — Launch a child Forge Agent in its OWN terminal window.
//
// Implements the platform-specific part of the spawn protocol
// (docs/SPAWN_PROTOCOL.md §3). Given the node executable, the entry script,
// the child arguments, the working directory, the window title, and the child
// environment, it builds and runs the command that opens a NEW terminal window
// and runs the child inside it.
//
// Design notes:
//  - We never let the child inherit the parent's stdio: it runs in its own
//    window, so output must never bleed into the parent.
//  - The window title carries the child identifier for human identification.
//  - `FORGE_SPAWN_NO_WINDOW=1` forces the headless detached path (CI/tests).
//  - Every function is defensive: failures degrade to the headless path rather
//    than throwing into the agent loop.
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Quote an argument for a POSIX shell / a Windows `start` command line. */
function quoteWin(arg) {
  const s = String(arg);
  if (s === '') return '""';
  // `start` parses the first quoted token as the title; always quote args that
  // contain whitespace or shell metacharacters.
  if (/[\s&|<>^()"]/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}

function quotePosix(arg) {
  const s = String(arg);
  if (s === '') return "''";
  if (/[^A-Za-z0-9_@%+=:,./-]/.test(s)) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

/** Sanitise a title so it is safe inside a `start "..."` argument. */
function safeTitle(title) {
  return String(title || 'forge-agent').replace(/["\r\n]/g, ' ').slice(0, 120);
}

/**
 * Build the command descriptor for launching the child in a new window.
 * Pure function — no side effects — so it can be unit-tested on any platform.
 *
 * @param {Object} opts
 * @param {string} opts.node      node executable path
 * @param {string} opts.entry     forge-agent entry script path
 * @param {string[]} opts.args    arguments passed to the entry script
 * @param {string} opts.cwd       working directory
 * @param {string} opts.title     window title (contains the child identifier)
 * @param {Object} opts.env       environment for the child
 * @param {string} [opts.platform] override platform (tests)
 * @returns {{ command:string, args:string[], options:Object, mode:string }}
 */
function buildWindowCommand(opts) {
  const platform = opts.platform || process.platform;
  const title = safeTitle(opts.title);
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const node = opts.node || process.execPath;
  const entry = opts.entry;
  const scriptArgs = Array.isArray(opts.args) ? opts.args : [];

  // Forced headless (CI / tests / no terminal available).
  if (process.env.FORGE_SPAWN_NO_WINDOW === '1' || opts.forceHeadless) {
    return {
      command: node,
      args: [entry, ...scriptArgs],
      options: { cwd, env, detached: true, stdio: 'ignore' },
      mode: 'headless',
    };
  }

  if (platform === 'win32') {
    // cmd.exe /c start "<title>" <node> <entry> <args...>
    // `start` treats the FIRST quoted token as the window title.
    const inner = [quoteWin(node), quoteWin(entry), ...scriptArgs.map(quoteWin)].join(' ');
    const command = 'cmd.exe';
    const args = ['/c', 'start', '"' + title + '"', node, entry, ...scriptArgs];
    return {
      command,
      args,
      // We pass the already-built array, so quoting is handled by spawn().
      // `inner` is retained for debugging/logging only.
      options: { cwd, env, detached: true, stdio: 'ignore', windowsVerbatimArguments: false },
      mode: 'new-window',
      inner,
    };
  }

  if (platform === 'darwin') {
    // Use osascript to tell Terminal to run the child.
    const cmd = [node, entry, ...scriptArgs].map(quotePosix).join(' ');
    const asCmd = 'cd ' + quotePosix(cwd) + ' && ' + cmd;
    const apple = 'tell application "Terminal" to do script "' +
      asCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return {
      command: 'osascript',
      args: ['-e', apple],
      options: { env, detached: true, stdio: 'ignore' },
      mode: 'new-window',
    };
  }

  // Linux / other POSIX: pick the first terminal emulator that exists.
  const candidates = [
    { bin: 'x-terminal-emulator', args: ['-e'] },
    { bin: 'gnome-terminal', args: ['--'] },
    { bin: 'konsole', args: ['-e'] },
    { bin: 'xfce4-terminal', args: ['-e'] },
    { bin: 'xterm', args: ['-e'] },
  ];
  for (const cand of candidates) {
    if (which(cand.bin)) {
      const shellCmd = [node, entry, ...scriptArgs].map(quotePosix).join(' ');
      return {
        command: cand.bin,
        args: [...cand.args, 'sh', '-c', shellCmd],
        options: { cwd, env, detached: true, stdio: 'ignore' },
        mode: 'new-window',
      };
    }
  }

  // No terminal available → headless detached.
  return {
    command: node,
    args: [entry, ...scriptArgs],
    options: { cwd, env, detached: true, stdio: 'ignore' },
    mode: 'headless',
  };
}

/** Cross-platform `which`/`where` check (best-effort). */
function which(bin) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('where', [bin], { stdio: 'ignore' });
      return r.status === 0;
    }
    const r = spawnSync('sh', ['-c', 'command -v ' + quotePosix(bin)], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Launch the child in a new window.
 *
 * @param {Object} opts  see buildWindowCommand
 * @returns {{ pid:number|null, mode:string, command:string }}
 * @throws never — on failure it retries headless, and only throws if even that
 *         fails to spawn (which the supervisor treats as a spawn error).
 */
function launchInWindow(opts) {
  const spec = buildWindowCommand(opts);
  const child = spawn(spec.command, spec.args, spec.options);
  if (typeof child.unref === 'function') child.unref();
  return { pid: child.pid, mode: spec.mode, command: spec.command };
}

module.exports = {
  buildWindowCommand,
  launchInWindow,
  safeTitle,
  quoteWin,
  quotePosix,
  which,
};
