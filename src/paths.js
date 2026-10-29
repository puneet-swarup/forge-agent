// @ts-check
// src/paths.js - Single source of truth for Forge Agent's on-disk locations.
//
// Historically these lived under ~/.deepseek-agent (a model-specific name),
// but the agent talks to multiple models (DeepSeek, Gemini) and a session can
// resume on a different model, so the name is now model-agnostic: ~/.forge-agent.
//
// To avoid orphaning existing users' config/history/sessions/login profile, we
// migrate the legacy directory ONCE (best-effort copy) and fall back to reading
// the legacy location if migration has not happened yet.
//
// Override the whole root with the FORGE_HOME environment variable.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const NEW_DIR_NAME = '.forge-agent';
const LEGACY_DIR_NAME = '.deepseek-agent';

/** Absolute path to the current (model-agnostic) Forge home directory. */
function forgeHome() {
  if (process.env.FORGE_HOME) return path.resolve(process.env.FORGE_HOME);
  return path.join(os.homedir(), NEW_DIR_NAME);
}

/** Absolute path to the legacy (pre-rename) directory. */
function legacyHome() {
  return path.join(os.homedir(), LEGACY_DIR_NAME);
}

/**
 * Migrate the legacy home to the new home, once, best-effort.
 * - If the new dir already exists, do nothing (already migrated or fresh).
 * - If legacy exists and new does not, COPY legacy -> new (non-destructive;
 *   we copy rather than move so a partial failure cannot lose data).
 * Returns { migrated: boolean, from, to }.
 */
function migrateIfNeeded() {
  const to = forgeHome();
  const from = legacyHome();
  // Respect an explicit FORGE_HOME - never migrate into a custom location.
  if (process.env.FORGE_HOME) return { migrated: false, from, to };
  try {
    if (fs.existsSync(to)) return { migrated: false, from, to };
    if (!fs.existsSync(from)) return { migrated: false, from, to };
    _copyDirSync(from, to);
    return { migrated: true, from, to };
  } catch (_) {
    return { migrated: false, from, to };
  }
}

function _copyDirSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      _copyDirSync(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  // Symlinks and special files are intentionally skipped (best-effort).
}

/** Resolve a path inside the Forge home, e.g. forgePath('logs'). */
function forgePath(...parts) {
  return path.join(forgeHome(), ...parts);
}

/**
 * Resolve a path that may still live under the legacy dir. Returns the NEW
 * path if it exists there, else the legacy path if that exists, else the NEW
 * path (for a fresh create). This keeps pre-migration data readable.
 */
function resolveExisting(relPath) {
  const neu = path.join(forgeHome(), relPath);
  try { if (fs.existsSync(neu)) return neu; } catch (_) {}
  const old = path.join(legacyHome(), relPath);
  try { if (!process.env.FORGE_HOME && fs.existsSync(old)) return old; } catch (_) {}
  return neu;
}

module.exports = {
  NEW_DIR_NAME,
  LEGACY_DIR_NAME,
  forgeHome,
  legacyHome,
  forgePath,
  resolveExisting,
  migrateIfNeeded,
};
