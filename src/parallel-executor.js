// src/parallel-executor.js — Dependency-aware parallel tool execution
'use strict';

const path = require('path');
const { isReadOnly } = require('./permission-store');

function classifyEffect(name) {
  return isReadOnly(name) ? 'read' : 'write';
}

function _resolveFileKey(p, cwd) {
  if (!p || typeof p !== 'string') return null;
  try {
    const base = cwd || process.cwd();
    return 'file:' + path.resolve(base, p).replace(/\\/g, '/').toLowerCase();
  } catch (_) {
    return 'file:' + String(p).replace(/\\/g, '/').toLowerCase();
  }
}

function conflictKeys(name, args, cwd) {
  const keys = [];
  const a = args || {};
  const addFile = (p) => { const k = _resolveFileKey(p, cwd); if (k) keys.push(k); };

  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'write_file_range':
    case 'append_to_file':
    case 'replace_in_file':
    case 'patch_file':
    case 'delete_file':
    case 'get_file_info':
    case 'create_directory':
      addFile(a.path);
      break;
    case 'move_file':
    case 'copy_file':
      addFile(a.source);
      addFile(a.destination);
      break;
    case 'write_files':
      if (Array.isArray(a.files)) a.files.forEach(f => addFile(f && f.path));
      break;
    case 'diff_files':
      addFile(a.path_a || a.path);
      addFile(a.path_b);
      break;
    case 'run_command':
      keys.push('shell:' + String(a.command || '').trim());
      break;
    case 'install_package':
      keys.push('shell:install:' + JSON.stringify(a.packages || a.package || a.name || a));
      break;
    case 'start_process':
    case 'stop_process':
    case 'read_process_logs':
      keys.push('proc:' + String(a.name || ''));
      break;
    case 'set_env_var':
    case 'delete_env_var':
      keys.push('env:' + String(a.key || ''));
      break;
    case 'read_env':
    case 'list_env_files':
    case 'check_env_vars':
      keys.push('env:' + String(a.path || '.env'));
      break;
    case 'write_clipboard':
    case 'read_clipboard':
      keys.push('clipboard');
      break;
    default:
      keys.push('tool:' + name);
  }

  if (keys.length === 0) keys.push('tool:' + name);
  return keys;
}

function planWaves(calls, cwd) {
  const keyLastWave = new Map();
  const waves = [];
  calls.forEach((call, index) => {
    const keys = conflictKeys(call.name, call.args, cwd);
    let wave = 0;
    for (const k of keys) {
      const last = keyLastWave.has(k) ? keyLastWave.get(k) : -1;
      if (last + 1 > wave) wave = last + 1;
    }
    if (!waves[wave]) waves[wave] = [];
    waves[wave].push({ ...call, _index: index, _keys: keys });
    for (const k of keys) keyLastWave.set(k, wave);
  });
  return waves.filter(Boolean);
}

async function _runOne(call, executeTool) {
  try {
    const result = await executeTool(call.name, call.args);
    return { name: call.name, args: call.args, result, isError: false };
  } catch (err) {
    return { name: call.name, args: call.args, result: err.message || String(err), isError: true };
  }
}

/**
 * Run an array of work items with a bounded number of concurrent tasks,
 * preserving the original index order in the returned results array.
 * @returns {Promise<Array>} results aligned to the input order
 */
async function _runWithConcurrency(items, limit, executeTool) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await _runOne(items[i], executeTool);
    }
  }

  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function executeBatch(calls, opts = {}) {
  const { executeTool, cwd, maxParallel = Infinity } = opts;
  if (!Array.isArray(calls) || calls.length === 0) return [];
  if (typeof executeTool !== 'function') throw new Error('executeBatch: executeTool is required');

  const results = new Array(calls.length);
  const sequential = !(Number(maxParallel) > 1);

  if (sequential) {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (!call || !call.name) {
        results[i] = { name: 'unknown', args: {}, result: 'Invalid tool call', isError: true };
        continue;
      }
      results[i] = await _runOne(call, executeTool);
    }
    return results;
  }

  const limit = Math.max(1, Math.floor(Number(maxParallel) || 1));
  const waves = planWaves(calls, cwd);
  for (const wave of waves) {
    const settled = await _runWithConcurrency(wave, limit, executeTool);
    wave.forEach((call, i) => { results[call._index] = settled[i]; });
  }

  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      results[i] = { name: calls[i].name, args: calls[i].args, result: 'Not executed', isError: true };
    }
  }
  return results;
}

module.exports = { classifyEffect, conflictKeys, planWaves, executeBatch };
