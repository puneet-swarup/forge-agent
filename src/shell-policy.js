// src/shell-policy.js — what the agent may run, and with what environment.
//
// Why this exists
// ---------------
// The guard was six literal substrings ("rm -rf /", "mkfs", ...) matched with
// String.includes(). `rm -rf $HOME`, `git reset --hard`, `find . -delete`,
// `chmod -R 777 /` and `curl … | sh` all walked straight past it. Meanwhile the
// shell inherited the full `process.env`, so any command the model wrote could
// read every token in the operator's environment.
//
// This module replaces the blocklist with three verdicts:
//
//   allow    a common, non-destructive development command — no prompt
//   confirm  anything unrecognised, or known-destructive — the user is asked
//   deny     catastrophic and irreversible — never runs
//
// The verdict is advisory for `confirm` (the permission menu decides) and
// binding for `deny`. `tools.js` enforces deny and the scrubbed environment;
// `agent.js` uses `allow` to skip the permission prompt.
'use strict';

// ── deny: catastrophic, irreversible, or a remote-code-execution primitive ──

const DENY_RULES = [
  { rule: 'rm-root', re: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:\/|~|\$HOME|\/\*|\.\.?)(?:\s|$)/i },
  { rule: 'rm-glob-root', re: /\brm\s+-[rf]{1,2}\s+\*(\s|$)/i },
  { rule: 'mkfs', re: /\bmkfs(?:\.\w+)?\b/i },
  { rule: 'dd-to-device', re: /\bdd\b[^\n]*\bof=\/dev\//i },
  { rule: 'fork-bomb', re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/ },
  { rule: 'chmod-root', re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i },
  { rule: 'power', re: /^\s*(?:shutdown|reboot|halt|poweroff)\b/i },
  { rule: 'pipe-to-shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i },
  { rule: 'eval-remote', re: /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i },
  { rule: 'force-push-protected', re: /\bgit\s+push\b[^\n]*(?:--force|-f)\b[^\n]*\b(?:main|master|release\/\S+)\b/i },
  { rule: 'windows-format', re: /\bformat\s+[a-z]:/i },
  { rule: 'windows-del-root', re: /\b(?:del|rd|rmdir)\b[^\n]*\/s[^\n]*[a-z]:\\(?:\s|$)/i },
];

// ── allow: development commands that are safe to run unattended ────────────

/** Binaries allowed outright, with no subcommand inspection. */
const ALLOW_BINARIES = new Set([
  // inspection
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep',
  'findstr', 'rg', 'jq', 'pwd', 'echo', 'printf', 'which', 'where', 'whoami',
  'diff', 'sort', 'uniq', 'basename', 'dirname', 'realpath', 'stat', 'file',
  'tree', 'less', 'more', 'column', 'cut', 'tr', 'date', 'env', 'find',
  // shell builtins and utilities with no destructive effect
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'true', 'false', 'sleep',
  'tee', 'xargs', 'test', '[', 'source', '.',
  // toolchains and package managers
  'npm', 'npx', 'yarn', 'pnpm', 'node', 'tsc', 'tsx', 'jest', 'vitest', 'mocha',
  'eslint', 'prettier', 'webpack', 'vite', 'rollup', 'babel',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'ruff', 'mypy', 'black', 'uv',
  'cargo', 'rustc', 'go', 'gofmt', 'make', 'cmake', 'gradle', 'gradlew', 'mvn',
  'dotnet', 'php', 'composer', 'ruby', 'bundle', 'java', 'javac',
  // filesystem, non-destructive
  'mkdir', 'touch', 'cp', 'copy', 'mv', 'move', 'ln', 'mklink', 'tar', 'unzip',
  'zip', 'gzip', 'gunzip', 'nano', 'vi', 'vim',
]);

/** `git` subcommands. Destructive ones are held for confirmation. */
const GIT_ALLOW = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree',
  'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'fetch', 'pull',
  'merge', 'rebase', 'tag', 'describe', 'blame', 'remote', 'config', 'init',
  'clone', 'worktree', 'show-ref', 'cat-file', 'rev-list', 'shortlog',
]);

/** `git` subcommands that discard work — allowed, but the user is asked. */
const GIT_CONFIRM = new Set(['push', 'reset', 'clean', 'revert', 'cherry-pick', 'rm', 'mv', 'gc', 'prune']);

/** Flags that turn an otherwise-allowed command destructive. */
const DESTRUCTIVE_FLAGS = /(?:^|\s)(?:-rf|-fr|-r\s+-f|-f\s+-r)(?:\s|$)/;

const DEFAULTS = Object.freeze({
  policy: 'standard',   // 'standard' | 'strict' | 'off'
  scrubEnv: true,
});

// ── environment scrubbing ──────────────────────────────────────────────────

/** Variables that are safe and usually necessary for a build to work. */
const ENV_KEEP = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'USER',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR',
  'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

/** Anything matching this is dropped even if it is on the keep list. */
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|APIKEY|AUTH|SESSION|COOKIE)/i;

/**
 * A minimal environment for a child process: no tokens, no provider keys.
 *
 * @param {object} [extra]  explicitly requested variables (tool `env` argument)
 * @param {object} [opts]   { base, scrub }
 * @returns {object}
 */
function scrubbedEnv(extra = {}, opts = {}) {
  const base = opts.base || process.env;
  const scrub = opts.scrub !== false;

  if (!scrub) return Object.assign({}, base, extra);

  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (!ENV_KEEP.has(key.toUpperCase())) continue;
    if (SECRET_NAME.test(key)) continue;
    out[key] = value;
  }

  // Explicitly requested variables are honoured, but a secret-looking name is
  // still refused — the model should not be able to read a token back out.
  for (const [key, value] of Object.entries(extra || {})) {
    if (SECRET_NAME.test(key)) continue;
    out[key] = value;
  }

  return out;
}

// ── command evaluation ─────────────────────────────────────────────────────

/** Split a command line into simple commands, respecting quotes. */
function segments(command) {
  const parts = [];
  let buf = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      buf += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }

    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(buf); buf = ''; i++; continue; }
    if (ch === ';' || ch === '|' || ch === '\n') { parts.push(buf); buf = ''; continue; }

    buf += ch;
  }
  parts.push(buf);

  return parts.map((s) => s.trim()).filter(Boolean);
}

/** First meaningful token of a segment, skipping `VAR=x` prefixes and wrappers. */
function binaryOf(segment) {
  // A quoted first token is one token even when it contains spaces, which
  // matters for Windows paths like "C:\\Program Files\\nodejs\\node.exe".
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }   // FOO=bar
    if (/^(?:sudo|doas|command|exec|time|nohup)$/i.test(t)) { i++; continue; }
    if (/^env$/i.test(t)) { i++; continue; }
    break;
  }

  const raw = tokens[i] || '';
  return {
    bin: raw.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, ''),
    args: tokens.slice(i + 1),
    index: i,
  };
}

/**
 * Evaluate a command line.
 *
 * @param {string} command
 * @param {object} [opts] { policy: 'standard'|'strict'|'off' }
 * @returns {{verdict: 'allow'|'confirm'|'deny', rule: string, reason: string, segments: string[]}}
 */
function evaluate(command, opts = {}) {
  const policy = opts.policy || DEFAULTS.policy;

  if (policy === 'off') {
    return { verdict: 'allow', rule: 'policy-off', reason: 'shell policy disabled', segments: [] };
  }

  const text = String(command || '');
  if (!text.trim()) {
    return { verdict: 'deny', rule: 'empty', reason: 'empty command', segments: [] };
  }

  // 1. Deny rules are checked against the whole line, so quoting and pipes
  //    cannot hide the shape.
  for (const { rule, re } of DENY_RULES) {
    if (re.test(text)) {
      return {
        verdict: 'deny',
        rule,
        reason:
          `Refused by the shell policy (${rule}). This command can destroy data ` +
          `irreversibly. If you are certain, run it yourself outside the agent.`,
        segments: [],
      };
    }
  }

  const parts = segments(text);

  // 2. A pipeline into a shell is a remote-code primitive even when the fetch
  //    looks harmless, so it is denied above; here we only need the binaries.
  for (const part of parts) {
    const { bin, args } = binaryOf(part);
    if (!bin) continue;

    if (bin === 'git') {
      const sub = (args[0] || '').toLowerCase();
      if (GIT_CONFIRM.has(sub)) {
        return {
          verdict: 'confirm',
          rule: 'git-destructive',
          reason: `\`git ${sub}\` can discard work`,
          segments: parts,
        };
      }
      if (!GIT_ALLOW.has(sub)) {
        return { verdict: 'confirm', rule: 'git-unknown', reason: `\`git ${sub || ''}\` is not a known-safe subcommand`, segments: parts };
      }
      continue;
    }

    // `find` is read-only until it is given an action that mutates or executes.
    if (bin === 'find' && /\s-(?:delete|exec|execdir|ok|okdir)\b/.test(part)) {
      return { verdict: 'confirm', rule: 'find-action', reason: 'find with a mutating or executing action', segments: parts };
    }

    if (bin === 'rm' || bin === 'del' || bin === 'rd' || bin === 'rmdir') {
      if (DESTRUCTIVE_FLAGS.test(part) || /\s-[rf]{1,2}\s/.test(part)) {
        return { verdict: 'confirm', rule: 'delete-recursive', reason: 'recursive delete', segments: parts };
      }
      continue;                                   // a plain single-file rm is fine
    }

    if (ALLOW_BINARIES.has(bin)) continue;

    // Windows shells: `powershell -c`, `cmd /c` wrap another command.
    if (bin === 'powershell' || bin === 'pwsh' || bin === 'cmd') {
      return { verdict: 'confirm', rule: 'shell-wrapper', reason: `nested shell (${bin})`, segments: parts };
    }

    return {
      verdict: policy === 'strict' ? 'deny' : 'confirm',
      rule: 'unknown-binary',
      reason: `\`${bin}\` is not in the allowlist`,
      segments: parts,
    };
  }

  return { verdict: 'allow', rule: 'allowlisted', reason: 'all commands allowlisted', segments: parts };
}

/** Convenience: is this command safe to run without asking? */
function isAllowed(command, opts = {}) {
  return evaluate(command, opts).verdict === 'allow';
}

module.exports = {
  evaluate,
  isAllowed,
  scrubbedEnv,
  segments,
  binaryOf,
  DENY_RULES,
  ALLOW_BINARIES,
  GIT_ALLOW,
  GIT_CONFIRM,
  ENV_KEEP,
  DEFAULTS,
};
