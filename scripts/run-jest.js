#!/usr/bin/env node
// scripts/run-jest.js - thin wrapper so we never have to pass long paths inline.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const jestBin = path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js');
const args = [jestBin, '--runInBand'].concat(process.argv.slice(2));

const res = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});
process.exit(res.status === null ? 1 : res.status);
