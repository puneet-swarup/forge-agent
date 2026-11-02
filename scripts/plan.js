#!/usr/bin/env node
// scripts/plan.js - create/list/tick a FORGE_PLAN.md baby-step plan.
//
// Reuses src/todo-manager.js for parsing and write-back, so the plan file uses
// the same "- [ ]" / "- [x]" format as FORGE_TODO.md. No new parser, no drift.
//
// Usage:
//   node scripts/plan.js status            show progress (n/m done)
//   node scripts/plan.js list              list items with numbers
//   node scripts/plan.js tick <n>          mark item n done
//   node scripts/plan.js untick <n>        mark item n not done
//   node scripts/plan.js next              print the first open item
'use strict';

const fs = require('fs');
const path = require('path');
const todo = require('../src/todo-manager');

const PLAN_FILE = 'FORGE_PLAN.md';

function planPath(dir) {
  return path.join(path.resolve(dir || process.cwd()), PLAN_FILE);
}

// Read plan items using todo-manager's parser (same checkbox semantics).
function readPlan(dir) {
  const file = planPath(dir);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const items = todo.parseTodo(raw);
  return {
    file: file,
    items: items,
    open: items.filter(function (i) { return !i.done; }),
    done: items.filter(function (i) { return i.done; }),
  };
}

// Tick or untick the Nth item (1-based, as shown by `list`).
function setDone(dir, n, done) {
  const file = planPath(dir);
  if (!fs.existsSync(file)) throw new Error('no plan file: ' + file);
  const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));

  // Re-scan with the same regex todo-manager uses, keeping line numbers.
  const idx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) idx.push(i);
  }
  if (n < 1 || n > idx.length) {
    throw new Error('item ' + n + ' out of range (1..' + idx.length + ')');
  }
  const at = idx[n - 1];
  const mark = done ? '[x]' : '[ ]';
  lines[at] = lines[at].replace(/\[[ xX]\]/, mark);
  fs.writeFileSync(file, lines.join(String.fromCharCode(10)), 'utf8');
  return lines[at].trim();
}

function formatStatus(p) {
  if (!p) return 'No ' + PLAN_FILE + ' in this directory.';
  const total = p.items.length;
  const done = p.done.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = progressBar(done, total, 20);
  return 'Plan: ' + done + '/' + total + ' (' + pct + '%)  ' + bar;
}

function progressBar(done, total, width) {
  if (!total) return '';
  const filled = Math.round((done / total) * width);
  let s = '';
  for (let i = 0; i < width; i++) s += (i < filled ? '#' : '.');
  return '[' + s + ']';
}

function main(argv) {
  const cmd = argv[2] || 'status';
  const dir = process.argv.indexOf('--dir') >= 0
    ? process.argv[process.argv.indexOf('--dir') + 1]
    : process.cwd();

  try {
    if (cmd === 'status') {
      console.log(formatStatus(readPlan(dir)));
      return 0;
    }
    if (cmd === 'list') {
      const p = readPlan(dir);
      if (!p) { console.log('No ' + PLAN_FILE + '.'); return 0; }
      p.items.forEach(function (it, i) {
        console.log((i + 1) + '. ' + (it.done ? '[x]' : '[ ]') + ' ' + it.text);
      });
      return 0;
    }
    if (cmd === 'tick' || cmd === 'untick') {
      const n = parseInt(argv[3], 10);
      if (!n || n < 1) { console.error('usage: plan.js ' + cmd + ' <n>'); return 2; }
      const line = setDone(dir, n, cmd === 'tick');
      console.log((cmd === 'tick' ? 'ticked' : 'unticked') + ': ' + line);
      return 0;
    }
    if (cmd === 'next') {
      const p = readPlan(dir);
      if (!p || p.open.length === 0) { console.log('nothing open'); return 0; }
      console.log(p.open[0].text);
      return 0;
    }
    console.error('unknown command: ' + cmd);
    return 2;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { readPlan, setDone, formatStatus, progressBar, planPath, PLAN_FILE };
