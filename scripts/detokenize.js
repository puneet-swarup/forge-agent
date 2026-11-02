#!/usr/bin/env node
// scripts/detokenize.js - decode @@TOKEN@@ placeholders into real characters.
//
// WHY THIS EXISTS: the agent tool transport corrupts backslashes and escaped
// asterisks when writing source files (a backslash consumes the next char).
// Write a .tpl file using the tokens below, then run this to materialize it.
//
//   @@BS@@  backslash
//   @@ST@@  asterisk
//   @@QM@@  question mark
//   @@BT@@  backtick
//   @@DQ@@  double quote
//   @@SQ@@  single quote
//   @@AT@@  at sign
'use strict';

const fs = require('fs');
const path = require('path');

const CH = {
  BS: String.fromCharCode(92),
  ST: String.fromCharCode(42),
  QM: String.fromCharCode(63),
  BT: String.fromCharCode(96),
  DQ: String.fromCharCode(34),
  SQ: String.fromCharCode(39),
  AT: String.fromCharCode(64),
};

const TOKENS = [
  ['@@BS@@', CH.BS],
  ['@@ST@@', CH.ST],
  ['@@QM@@', CH.QM],
  ['@@BT@@', CH.BT],
  ['@@DQ@@', CH.DQ],
  ['@@SQ@@', CH.SQ],
  ['@@AT@@', CH.AT],
];

function detokenize(text) {
  let out = text;
  for (const pair of TOKENS) {
    out = out.split(pair[0]).join(pair[1]);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('usage: node scripts/detokenize.js <input.tpl> [output]');
    process.exit(2);
  }
  const src = path.resolve(args[0]);
  let dst;
  if (args[1]) dst = path.resolve(args[1]);
  else dst = src.endsWith('.tpl') ? src.slice(0, -4) : src + '.out';

  if (!fs.existsSync(src)) {
    console.error('not found: ' + src);
    process.exit(1);
  }

  const raw = fs.readFileSync(src, 'utf8');
  const out = detokenize(raw);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, out, 'utf8');
  console.log('detokenize: ' + src + ' -> ' + dst + ' (' + out.length + ' chars)');
}

if (require.main === module) main();
module.exports = { detokenize: detokenize, TOKENS: TOKENS, CH: CH };
