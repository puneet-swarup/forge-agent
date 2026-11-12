// src/step-summary.js - Build short, deterministic step-line descriptors.
//
// A descriptor answers "what is this step doing?" for the terminal step line.
// Derived only from the tool call about to run, so it reflects current intent
// (not the previous step). No model round trip. No regex backslashes anywhere
// in this file, by design: it must survive the agent write transport intact.
'use strict';

const path = require('path');

const BS = String.fromCharCode(92);   // backslash
const ELLIPSIS = String.fromCharCode(8230);

const VERBS = {
  read_file: 'reading',
  write_file: 'writing',
  write_files: 'writing',
  append_to_file: 'appending to',
  replace_in_file: 'editing',
  delete_file: 'deleting',
  move_file: 'moving',
  copy_file: 'copying',
  list_directory: 'listing',
  search_in_files: 'searching',
  search_codebase: 'searching',
  find_files: 'finding',
  run_command: 'running',
  run_tests: 'testing',
  git_status: 'checking git',
  git_diff: 'diffing',
  git_log: 'reading git log',
  git_branches: 'listing branches',
  git_show: 'showing commit',
  git_blame: 'blaming',
  install_package: 'installing',
  start_process: 'starting process',
  stop_process: 'stopping process',
  list_processes: 'listing processes',
  read_process_logs: 'reading logs',
  spawn_agent: 'spawning agent',
  kill_agent: 'stopping agent',
  list_agents: 'listing agents',
  read_agent_task: 'reading agent task',
  show_info: 'answering',
  fetch_url: 'fetching',
  read_url: 'fetching',
  diff_files: 'diffing files',
  patch_file: 'patching',
  read_env: 'reading env',
  set_env_var: 'setting env',
  delete_env_var: 'clearing env',
  list_env_files: 'listing env files',
  check_env_vars: 'checking env',
  take_screenshot: 'capturing screen',
  read_clipboard: 'reading clipboard',
  write_clipboard: 'writing clipboard',
  call_user: 'calling user',
  raise_alarm: 'raising alarm',
  get_file_info: 'inspecting',
  create_directory: 'creating dir',
};

function _basename(p) {
  if (typeof p !== 'string' || !p) return '';
  try { return path.basename(p); } catch (e) { return p; }
}

// last two path segments, using BS-free splitting
function _pathBrief(p) {
  if (typeof p !== 'string' || !p) return '';
  const norm = p.split(BS).join('/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return norm;
  return parts.length === 1 ? parts[0] : parts.slice(-2).join('/');
}

// first shell clause: cut at && || ; or newline, via indexOf (no regex)
function _firstClause(cmd) {
  if (typeof cmd !== 'string') return '';
  const trimmed = cmd.trim();
  let cut = trimmed.length;
  const seps = ['&&', '||', ';'];
  for (let i = 0; i < seps.length; i++) {
    const at = trimmed.indexOf(seps[i]);
    if (at >= 0 && at < cut) cut = at;
  }
  const nl = trimmed.indexOf(String.fromCharCode(10));
  if (nl >= 0 && nl < cut) cut = nl;
  const clause = trimmed.slice(0, cut).trim();
  return clause || trimmed;
}

// collapse any whitespace run to a single space, via char codes (no regex)
function _squeeze(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  let prevSpace = false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const isSpace = (c === 32 || c === 9 || c === 10 || c === 13);
    if (isSpace) {
      if (!prevSpace && out.length > 0) out += ' ';
      prevSpace = true;
    } else {
      out += str[i];
      prevSpace = false;
    }
  }
  return out.trim();
}

function _clamp(s, maxLen) {
  const str = _squeeze(s);
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 1)).trimEnd() + ELLIPSIS;
}

/**
 * Summarise the TARGET of a tool call: what it acts on, in a few words.
 * Returns '' when there is nothing useful to show.
 */
function summariseTarget(name, args) {
  if (!args || typeof args !== 'object') return '';

  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'append_to_file':
    case 'delete_file':
    case 'get_file_info':
    case 'replace_in_file':
    case 'patch_file':
      return _basename(args.path);

    case 'move_file':
    case 'copy_file':
      return _basename(args.source) + (args.destination ? ' -> ' + _basename(args.destination) : '');

    case 'create_directory':
      return _pathBrief(args.path);

    case 'list_directory':
      return _pathBrief(args.path) || '.';

    case 'write_files':
      return Array.isArray(args.files) ? (args.files.length + ' files') : '';

    case 'run_command':
      return _firstClause(args.command);

    case 'run_tests':
      return args.file ? _basename(args.file) : (args.framework || 'suite');

    case 'install_package': {
      const pkgs = Array.isArray(args.packages) ? args.packages : [];
      const names = pkgs.map(function (p) { return typeof p === 'string' ? p : (p && p.name); }).filter(Boolean);
      return names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
    }

    case 'search_in_files':
      return (args.pattern ? String(args.pattern) : '') +
        (args.directory ? ' in ' + _pathBrief(args.directory) : '');

    case 'search_codebase':
      return String(args.query || '');

    case 'find_files':
      return String(args.pattern || '');

    case 'read_url':
    case 'fetch_url': {
      try { return new URL(args.url).hostname; } catch (e) { return String(args.url || ''); }
    }

    case 'start_process':
      return String(args.name || _firstClause(args.command));

    case 'stop_process':
    case 'read_process_logs':
      return String(args.name || '');

    case 'spawn_agent':
      return String(args.session || '');

    case 'kill_agent':
      return String(args.name || '');

    case 'git_diff':
      return String(args.file || args.target || '');

    case 'git_log':
      return String(args.file || '');

    default:
      if (args.path) return _basename(args.path);
      if (args.name) return String(args.name);
      return '';
  }
}

/**
 * Build a one-line descriptor for the step line.
 *
 * @param {object} opts
 * @param {string} [opts.tool]       tool about to run (current intent)
 * @param {object} [opts.args]       tool args
 * @param {string} [opts.lastTool]   previous tool name (fallback)
 * @param {string} [opts.lastTarget] previous tool target (fallback)
 * @param {string} [opts.state]      'waiting' | 'starting' | 'answering'
 * @param {number} [opts.maxLen]     hard length cap (default 60)
 * @returns {string}
 */
function describeStep(opts) {
  const o = opts || {};
  const maxLen = typeof o.maxLen === 'number' ? o.maxLen : 60;

  if (o.state === 'waiting') return 'waiting for model response';
  if (o.state === 'answering') return 'rendering answer';

  if (o.tool) {
    const verb = VERBS[o.tool] || ('using ' + o.tool);
    const target = summariseTarget(o.tool, o.args);
    return _clamp(verb + (target ? ' ' + target : ''), maxLen);
  }

  if (o.lastTool) {
    const verb = VERBS[o.lastTool] || ('using ' + o.lastTool);
    return _clamp(verb + (o.lastTarget ? ' ' + o.lastTarget : ''), maxLen);
  }

  return o.state === 'starting' ? 'starting - sending task to model' : 'working';
}

module.exports = { describeStep, summariseTarget, VERBS, _clamp, _squeeze };
