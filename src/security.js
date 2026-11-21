// src/security.js — Centralised security utilities for Forge Agent
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const homedir = os.homedir();

/**
 * All paths that are always blocked regardless of sandbox settings.
 */
const BLOCKED_PATHS = [
  '/etc/passwd', 
  '/etc/shadow', 
  '/etc/sudoers',
  '/etc/hosts',
  path.join(homedir, '.ssh'),
  path.join(homedir, '.gnupg'),
  path.join(homedir, '.aws'),
  path.join(homedir, '.config', 'gcloud'),
  path.join(homedir, '.npmrc'),
  path.join(homedir, '.netrc'),
  path.join(homedir, '.git-credentials'),
  path.join(homedir, '.config', 'gh'),
  path.join(homedir, '.docker', 'config.json'),
];

/**
 * All command patterns that are blocked by default.
 */
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  ':(){ :|:& };:',
  'dd if=/dev/zero of=/',
];

/**
 * Comprehensive path validation.
 * 
 * @param {string} filePath - The path to validate
 * @param {Object} opts - Validation options
 * @returns {Object} { safe: boolean, reason: string | null }
 */
function validatePath(filePath, opts = {}) {
  const { 
    sandbox = config.STRICT_SANDBOX, 
    workingDir = config.WORKING_DIR
  } = opts;

  try {
    // Fix 3: Null byte injection
    if (filePath.includes('\0')) {
      return { safe: false, reason: 'Security: path contains null byte — rejected' };
    }

    // Fix 1: Path normalisation before validation
    // Use workingDir for relative path resolution to match agent's expected behaviour
    const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workingDir, filePath);

    // Fix 2: Block additional sensitive paths
    for (const blocked of BLOCKED_PATHS) {
      // Compare NORMALISED forms so platform-specific resolution can't bypass
      // the check: on Windows path.resolve('/etc/passwd') becomes 'D:\\etc\\passwd',
      // which never equals the literal '/etc/passwd' in BLOCKED_PATHS.
      const _norm = (p) => { try { return path.resolve(p).toLowerCase(); } catch { return String(p).toLowerCase(); } };
      const _absN = _norm(abs);
      const _blkN = _norm(blocked);
      if (_absN === _blkN || _absN.startsWith(_blkN + path.sep)) {
        return { safe: false, reason: `Security: access denied — "${filePath}" matches a protected path.` };
      }
    }

    // Fix 4: Sandbox check
    if (sandbox) {
      const rel = path.relative(workingDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { safe: false, reason: `Security: access denied — "${filePath}" is outside the working directory.` };
      }

      // Fix 4: Symlink escape detection
      if (fs.existsSync(abs)) {
        try {
          const real = fs.realpathSync(abs);
          const relReal = path.relative(workingDir, real);
          if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
            return { safe: false, reason: `Security: access denied — symlink points outside the working directory.` };
          }
        } catch (err) {
          // If realpathSync fails (e.g. permission denied), treat as unsafe
          return { safe: false, reason: `Security: could not verify symlink safety: ${err.message}` };
        }
      }
    }

    return { safe: true, reason: null };
  } catch (err) {
    return { safe: false, reason: err.message };
  }
}

/**
 * Command safety check.
 * 
 * @param {string} command - The command to validate
 * @returns {Object} { safe: boolean, reason: string | null }
 */
function validateCommand(command) {
  try {
    for (const pattern of BLOCKED_COMMANDS) {
      if (command.includes(pattern)) {
        return { 
          safe: false, 
          reason: `Security: command blocked — this command could cause irreversible damage.\n` +
                  `If you are sure, set ALLOW_DANGEROUS_COMMANDS: true in config.`
        };
      }
    }
    return { safe: true, reason: null };
  } catch (err) {
    return { safe: false, reason: err.message };
  }
}

/**
 * Redact secrets from text.
 * 
 * @param {string} text - The text to sanitise
 * @returns {string} Sanitised string
 */
function sanitiseOutput(text) {
  if (typeof text !== 'string') return text;
  try {
    let sanitised = text;
    // Fix 9: API key pattern
    sanitised = sanitised.replace(/sk-[A-Za-z0-9]{20,}/g, '[API_KEY]');
    // Fix 9: JWT tokens
    sanitised = sanitised.replace(/eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, '[JWT_TOKEN]');
    // Fix 9: Long hex strings (32+ chars)
    sanitised = sanitised.replace(/[a-f0-9]{32,}/gi, '[HEX_SECRET]');
    // Fix 9: Base64 blobs (40+ chars)
    sanitised = sanitised.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[BASE64_DATA]');
    
    return sanitised;
  } catch (err) {
    return text;
  }
}

/**
 * High-confidence secret patterns for EGRESS redaction.
 *
 * These run on everything the agent sends to a third-party chat UI, so they are
 * deliberately narrow: each pattern is a token shape that has no legitimate
 * reason to appear in ordinary source code. They must NOT match things like
 * hashes, lockfile integrity values or base64 assets — over-redacting code the
 * model is editing corrupts it (the model would write the placeholder back).
 *
 * `sanitiseOutput()` above stays as-is for stored logs, where lossy is fine.
 */
const SECRET_PATTERNS = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'openai-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

// key = value / key: value assignments whose value looks like a credential.
const ASSIGNMENT_RE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key)[ \t]*[:=][ \t]*)(["'])([^"'\n]{8,})\2/gi;

// .env style lines: NAME_WITH_SECRET_WORD=value
const ENV_LINE_RE =
  /^([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS)[A-Z0-9_]*[ \t]*=[ \t]*)([^\s]{6,})$/gm;

/**
 * Redact secrets from text that is about to leave the machine.
 *
 * @param {string} text
 * @returns {{ text: string, redactions: Array<{kind: string, count: number}> }}
 */
function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : String(text == null ? '' : text), redactions: [] };
  }

  const counts = new Map();
  const bump = (kind, n = 1) => counts.set(kind, (counts.get(kind) || 0) + n);

  let out = text;

  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      bump(kind);
      return `[REDACTED:${kind}]`;
    });
  }

  out = out.replace(ASSIGNMENT_RE, (match, prefix, quote, value) => {
    bump('credential-assignment');
    return `${prefix}${quote}[REDACTED]${quote}`;
  });

  out = out.replace(ENV_LINE_RE, (match, prefix, value) => {
    // Leave obvious placeholders and references alone.
    if (/^[\[\]$<{%]/.test(value) || /^(true|false|null|undefined)$/i.test(value)) return match;
    bump('env-file-value');
    return `${prefix}[REDACTED]`;
  });

  const redactions = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  return { text: out, redactions };
}

/**
 * Convenience wrapper: redact and return the text only.
 * @param {string} text
 * @returns {string}
 */
function redactSecretsText(text) {
  return redactSecrets(text).text;
}

/**
 * Check if a file is an environment file.
 */
function isEnvFile(filePath) {
  return /^\.env(\.\w+)?$/.test(path.basename(filePath));
}

/**
 * Check if a file type is sensitive and return a warning if so.
 */
function checkSensitiveFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  
  const sensitiveExtensions = ['.pem', '.key', '.p12', '.pfx'];
  const sensitiveNames = ['.secret', '.credentials'];

  if (sensitiveExtensions.includes(ext) || sensitiveNames.some(n => name.endsWith(n))) {
    return `⚠ [SECURITY WARNING: This file may contain sensitive credentials.\n` +
           `   The content below will be sent to the AI. Review carefully.]`;
  }
  return null;
}

/**
 * Generate a security posture report.
 */
function generateSecurityReport() {
  return {
    sandboxEnabled: true, // Basic sandbox (blocked paths) is always enabled
    strictSandbox: !!config.STRICT_SANDBOX,
    blockedPathsCount: BLOCKED_PATHS.length,
    blockedCommandsCount: BLOCKED_COMMANDS.length,
    auditLogEnabled: !!config.AUDIT_LOG,
    allowDangerousCommands: !!config.ALLOW_DANGEROUS_COMMANDS,
    envPlainReadAllowed: !!config.ALLOW_ENV_PLAIN_READ,
    paramValidationEnabled: config.PARAM_VALIDATION !== false,
    lastAuditDate: 'Day 45 — 2026',
  };
}

/**
 * Format the security report for terminal display.
 */
function formatSecurityReport(report) {
  const sandboxMode = report.strictSandbox ? 'STRICT (only working directory)' : 'standard (sensitive paths blocked)';
  
  return [
    '🔒 Forge Agent — Security Posture',
    '────────────────────────────────────',
    `Sandbox mode:           ${sandboxMode}`,
    `Strict sandbox:         ${report.strictSandbox ? 'enabled' : 'disabled'}`,
    `Blocked paths:          ${report.blockedPathsCount} sensitive paths always blocked`,
    `Blocked commands:       ${report.blockedCommandsCount} dangerous commands blocked`,
    `Parameter validation:   ${report.paramValidationEnabled ? 'enabled' : 'disabled'}`,
    `Secret masking:         enabled (.env files auto-masked)`,
    `Audit logging:          ${report.auditLogEnabled ? 'enabled' : 'disabled'}`,
    '────────────────────────────────────',
    'Run forge-agent --security for details'
  ].join('\n');
}

module.exports = {
  BLOCKED_PATHS,
  BLOCKED_COMMANDS,
  validatePath,
  validateCommand,
  sanitiseOutput,
  redactSecrets,
  redactSecretsText,
  SECRET_PATTERNS,
  isEnvFile,
  checkSensitiveFileType,
  generateSecurityReport,
  formatSecurityReport
};
