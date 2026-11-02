#!/usr/bin/env node
// scripts/check-syntax.js - the gate that prevents corrupted writes from shipping.
//
// Runs `node --check` on every changed/untracked .js file in the repo. Exits
// non-zero if any file fails to parse. Designed to be cheap (<2s) so it can run
// before every claim of "done".
//
// Usage:
//   node scripts/check-syntax.js            check git-changed + untracked .js
//   node scripts/check-syntax.js --all      check every .js under src/ and tests/
//   node scripts/check-syntax.js a.js b.js  check specific files
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_EXT = '.js';

function isJs(p) {
  return p.endsWith(JS_EXT);
}

// Collect files from git (changed + untracked), excluding deleted ones.
function gitChangedFiles() {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const files = [];
  for (const line of out.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    if (status.indexOf('D') >= 0) continue; // deleted - nothing to check
    const file = line.slice(3).trim();
    if (file && isJs(file)) files.push(file);
  }
  return files;
}

// Walk a directory for .js files, skipping node_modules and dot dirs.
function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (isJs(e.name)) acc.push(path.relative(ROOT, full));
  }
  return acc;
}

function checkOne(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return { file: relPath, ok: true, skipped: true };
  const res = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (res.status === 0) return { file: relPath, ok: true };
  const msg = (res.stderr || res.stdout || '').trim();
  return { file: relPath, ok: false, error: msg };
}

function main(argv) {
  let files;
  if (argv.includes('--all')) {
    files = walk(path.join(ROOT, 'src'), []).concat(walk(path.join(ROOT, 'tests'), []));
  } else {
    const explicit = argv.filter(function (a) { return !a.startsWith('--'); });
    files = explicit.length > 0 ? explicit.filter(isJs) : gitChangedFiles();
  }

  if (files.length === 0) {
    console.log('check-syntax: no changed .js files to check');
    return 0;
  }

  const results = files.map(checkOne);
  const bad = results.filter(function (r) { return !r.ok; });

  for (const r of results) {
    if (r.skipped) continue;
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.file);
  }

  console.log('');
  console.log('check-syntax: ' + (results.length - bad.length) + '/' + results.length + ' files parse cleanly');

  if (bad.length > 0) {
    console.log('');
    for (const r of bad) {
      console.log('--- ' + r.file + ' ---');
      console.log(r.error);
      console.log('');
    }
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { gitChangedFiles, walk, checkOne, isJs };
