#!/usr/bin/env node
// Forge Agent — cross-platform reinstall / verify helper.
// Single source of truth. install.bat and install.sh are 3-line wrappers.
'use strict';

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { spawnSync } = require('child_process');

const PROJECT_DIR  = path.resolve(__dirname, '..');
const IS_WIN       = process.platform === 'win32';
const IS_TTY       = process.stdout.isTTY;

const C = {
    red   : IS_TTY ? '\x1b[31m' : '',
    green : IS_TTY ? '\x1b[32m' : '',
    yellow: IS_TTY ? '\x1b[33m' : '',
    dim   : IS_TTY ? '\x1b[90m' : '',
    reset : IS_TTY ? '\x1b[0m'  : '',
};

// ── Read package metadata (real, scoped name) ──────────────────────────
let PKG;
try {
    PKG = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
} catch (err) {
    console.error(`${C.red}[FATAL] Cannot read package.json: ${err.message}${C.reset}`);
    process.exit(1);
}
const PACKAGE_NAME = PKG.name;                              // "@puneet-swarup/forge-agent"
const BIN_NAMES    = Object.keys(PKG.bin || {});            // ["forge-agent", "fa"]

// ── Helpers ────────────────────────────────────────────────────────────

function step(n, total, msg) {
    console.log(`[${n}/${total}] ${msg}`);
}

function spawn(cmd, args, opts = {}) {
    return spawnSync(cmd, args, {
        cwd  : PROJECT_DIR,
        stdio: opts.quiet ? 'ignore' : 'inherit',
        shell: IS_WIN,
        env  : { ...process.env, ...(opts.env || {}) },
    });
}

function ok(cmd, args) {
    return spawnSync(cmd, args, {
        cwd: PROJECT_DIR, stdio: 'ignore', shell: IS_WIN,
    }).status === 0;
}

function capture(cmd, args) {
    const r = spawnSync(cmd, args, {
        cwd: PROJECT_DIR, encoding: 'utf8', shell: IS_WIN,
    });
    return {
        status: r.status,
        stdout: (r.stdout || '').trim(),
        stderr: (r.stderr || '').trim(),
    };
}

function removePath(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (_) {
        if (IS_WIN) spawnSync('cmd', ['/c', `rmdir /s /q "${target}"`], { stdio: 'ignore' });
        else        spawnSync('rm',  ['-rf', target],                     { stdio: 'ignore' });
    }
}

// Windows symlink capability probe. Creating a throwaway symlink is the
// only reliable test — reading Developer Mode registry keys is flaky.
function canCreateSymlinks() {
    if (!IS_WIN) return true;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-symtest-'));
    const target  = path.join(tmpRoot, 't.txt');
    const link    = path.join(tmpRoot, 'l.txt');
    try {
        fs.writeFileSync(target, '');
        fs.symlinkSync(target, link);
        return true;
    } catch (_) {
        return false;
    } finally {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
}

// In-process Playwright Chromium check — no subprocess, no shell escaping.
function checkPlaywrightChromium() {
    try {
        const pw = require(path.join(PROJECT_DIR, 'node_modules', 'playwright'));
        const execPath = pw.chromium.executablePath();
        if (!execPath) return { ok: false, reason: 'executablePath() returned empty string' };
        if (!fs.existsSync(execPath)) return { ok: false, reason: 'binary missing at ' + execPath };
        return { ok: true, path: execPath };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
    console.log('========================================================');
    console.log('  Forge Agent — cross-platform reinstall');
    console.log('========================================================');
    console.log(`${C.dim}  project : ${PROJECT_DIR}${C.reset}`);
    console.log(`${C.dim}  package : ${PACKAGE_NAME}${C.reset}`);
    console.log(`${C.dim}  platform: ${process.platform}/${process.arch}  node ${process.version}${C.reset}`);
    console.log('');

    process.chdir(PROJECT_DIR);

    // ── 0. prerequisites ─────────────────────────────────────────────
    step(0, 6, 'Checking prerequisites...');
    if (!ok('node', ['-v'])) { console.error(`${C.red}[FATAL] node not on PATH.${C.reset}`); process.exit(1); }
    if (!ok('npm',  ['-v'])) { console.error(`${C.red}[FATAL] npm not on PATH.${C.reset}`);  process.exit(1); }
    console.log(`  - npm ${capture('npm', ['-v']).stdout}`);

    // ── 1. clean slate ───────────────────────────────────────────────
    step(1, 6, 'Removing node_modules, lockfile, and any previous global install...');
    const nm  = path.join(PROJECT_DIR, 'node_modules');
    const lck = path.join(PROJECT_DIR, 'package-lock.json');
    if (fs.existsSync(nm)) {
        removePath(nm);
        if (fs.existsSync(nm)) {
            console.warn(
                `${C.yellow}[WARN]${C.reset} node_modules not fully removed — ` +
                `close any terminals / editors / running "${BIN_NAMES[1] || 'fa'}" processes and retry.`
            );
        }
    }
    if (fs.existsSync(lck)) {
        try { fs.unlinkSync(lck); } catch (_) { /* ignore */ }
    }
    // Uninstall both the real (possibly scoped) name AND any legacy unscoped
    // name from earlier broken runs. Both are best-effort — failures are fine.
    spawn('npm', ['uninstall', '-g', PACKAGE_NAME, '--force'], { quiet: true });
    if (PACKAGE_NAME !== 'forge-agent') {
        spawn('npm', ['uninstall', '-g', 'forge-agent', '--force'], { quiet: true });
    }

    // ── 2. install deps (runs postinstall.js → downloads Chromium) ───
    step(2, 6, 'Installing dependencies (postinstall.js will run)...');
    if (spawn('npm', ['install']).status !== 0) {
        console.error(`${C.red}[FATAL] npm install failed.${C.reset}`);
        process.exit(1);
    }

    // ── 3. link globally ─────────────────────────────────────────────
    step(3, 6, 'Linking package globally...');

    const symlinksPossible = canCreateSymlinks();
    let installMode = 'link';

    if (IS_WIN && !symlinksPossible) {
        console.warn(`${C.yellow}[WARN]${C.reset} Windows symlink permissions not available in this shell.`);
        console.warn(`       npm link needs symlinks, which require one of:`);
        console.warn(`         • Run this script from an elevated (Administrator) terminal, OR`);
        console.warn(`         • Enable Developer Mode:`);
        console.warn(`             Settings → Privacy & Security → For developers → Developer Mode = On`);
        console.warn(`       Falling back to "npm install -g ." (COPY mode — source edits`);
        console.warn(`       will NOT be picked up until this script is re-run).`);
        installMode = 'copy';
    }

    if (installMode === 'link') {
        const linkRes = capture('npm', ['link']);
        if (linkRes.status === 0) {
            console.log('  - npm link succeeded (source edits are live)');
        } else {
            console.warn(`${C.yellow}[WARN]${C.reset} npm link reported an error:`);
            if (linkRes.stderr) console.warn(`${C.dim}${linkRes.stderr}${C.reset}`);
            console.warn(`       Falling back to "npm install -g ." (COPY mode).`);
            installMode = 'copy';
        }
    }

    if (installMode === 'copy') {
        const copyRes = capture('npm', ['install', '-g', '.', '--force']);
        if (copyRes.status !== 0) {
            console.error(`${C.red}[FATAL] Global install failed.${C.reset}`);
            if (copyRes.stderr) console.error(`${C.dim}${copyRes.stderr}${C.reset}`);
            if (IS_WIN) {
                console.error('        Re-run install.bat from an Administrator terminal, or set:');
                console.error('          npm config set prefix "%APPDATA%\\npm"');
                console.error('          then add that folder to PATH.');
            } else {
                console.error('        Either run with sudo, or use a user-scoped prefix:');
                console.error('          npm config set prefix "$HOME/.npm-global"');
                console.error('          export PATH="$HOME/.npm-global/bin:$PATH"');
            }
            process.exit(1);
        }
        console.log('  - Installed globally in COPY mode');
    }

    // ── 4. Playwright Chromium check (in-process, reliable) ──────────
    step(4, 6, 'Checking Playwright Chromium availability...');
    const pw = checkPlaywrightChromium();
    if (pw.ok) {
        console.log(`  - Chromium binary present`);
        console.log(`${C.dim}    ${pw.path}${C.reset}`);
    } else {
        console.warn(`${C.yellow}[WARN]${C.reset} Playwright Chromium not detected: ${pw.reason}`);
        console.warn('       To install it, run:');
        console.warn('         npx playwright install chromium');
    }

    // ── 5. verify CLI responds ───────────────────────────────────────
    step(5, 6, 'Verifying CLI responds...');
    let cliOk = false;
    for (const bin of BIN_NAMES) {
        const v = capture(bin, ['--version']);
        if (v.status === 0 && v.stdout) {
            console.log(`  - ${bin} --version: ${v.stdout.split('\n')[0]}`);
            cliOk = true;
            continue;
        }
        const h = capture(bin, ['--help']);
        if (h.status === 0) {
            console.log(`  - ${bin} --help responded`);
            cliOk = true;
        }
    }

    // ── 6. verdict ───────────────────────────────────────────────────
    step(6, 6, 'Done.');

    if (!cliOk) {
        console.warn('');
        console.warn(`${C.yellow}[WARN]${C.reset} Package installed, but CLI did not respond in this shell.`);
        console.warn('       This is almost always a PATH-refresh issue — npm writes the');
        console.warn('       command shims, but only newly-spawned shells pick them up.');
        if (BIN_NAMES[1]) console.warn(`       Open a NEW terminal and run:  ${BIN_NAMES[1]} --help`);
        process.exit(0);
    }

    console.log('');
    console.log('========================================================');
    console.log(`${C.green}  SUCCESS — ${PACKAGE_NAME} is installed and verified.${C.reset}`);
    console.log('========================================================');

    if (installMode === 'copy') {
        console.log('');
        console.log(`${C.yellow}[NOTE]${C.reset} Installed in COPY mode (not linked).`);
        console.log('       Any code change you make must be followed by re-running this script,');
        console.log('       OR you can enable Developer Mode once on Windows so that');
        console.log('       `npm link` works properly and edits are live automatically.');
    }

    process.exit(0);
}

main();