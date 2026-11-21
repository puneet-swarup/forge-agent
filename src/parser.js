// @ts-check
// src/parser.js — Parse DeepSeek's text responses to extract tool calls
'use strict';

/**
 * Parse a DeepSeek/ChatGPT/Gemini response into a structured result.
 *
 * Return shapes:
 *   { type: 'tool_call', name: string, args: object, rawText: string }
 *   { type: 'tool_batch', calls: [{name,args}], rawText: string }
 *   { type: 'invalid_tool', name, args, suggestion, rawText }  // unknown tool
 *   { type: 'task_complete' }
 *   { type: 'text', content: string }
 *   { type: 'final', content: string }   // kept for backward compat
 *   { type: 'error', message: string }
 *   { type: 'empty' }
 *
 * @param {string} rawText
 * @param {object} [opts]
 * @param {string[]} [opts.toolNames]   registered tool names (enables suggestions)
 * @param {(name: string) => boolean} [opts.isKnownTool]
 *        When supplied, a candidate whose tool name is not in the registry is
 *        reported as `invalid_tool` (with a nearest-name suggestion) instead of
 *        being returned as a call. This is what stops prose that happens to
 *        contain `{"name": "my-app"}` from executing, and what turns a typo
 *        into one targeted repair instead of a registry dump.
 */
function parseResponse(rawText, opts = {}) {
  if (!rawText || typeof rawText !== 'string') return { type: 'empty' };

  const text = rawText.trim();
  if (!text) return { type: 'empty' };

  const toolNames = Array.isArray(opts.toolNames) ? opts.toolNames : null;
  const isKnownTool = toolNames
    ? (n) => toolNames.includes(n)
    : (typeof opts.isKnownTool === 'function' ? opts.isKnownTool : null);

  // ── Strategy 1: <tool_call> XML tags ─────────────────────────────────────
  const _xmlAll = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  if (_xmlAll.length > 0) {
    const _xc = [];
    for (const _m of _xmlAll) { const _p = _parseToolJSON(_m[1], text); if (_p) _xc.push({ name: _p.name, args: _p.args }); }
    const _xb = _buildBatch(_xc, text);
    if (_xb) return _finalise(_xb, isKnownTool, toolNames, text);
  }
  const xmlMatch = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (xmlMatch) {
    const result = _parseToolJSON(xmlMatch[1], text);
    if (result) return _finalise(result, isKnownTool, toolNames, text);
  }

  // ── Strategy 2: backtick code block tagged tool_call ─────────────────────
  // A block tagged with a data language (```json, ```js, ...) is an
  // ILLUSTRATION unless it is the entire response. Models routinely show an
  // example call while explaining something; executing that example is how an
  // explanation of a write becomes a write.
  // A UI may render the block with newlines (```tool_call\n{...}) or collapse
  // them entirely (```tool_call {...}), so whitespace after the label is
  // optional and may be spaces, tabs, CR/LF or nothing.
  const codeBlockRe = /```([A-Za-z0-9_+-]*)[ \t\r\n]*([\s\S]*?)[ \t\r\n]*```/g;
  let cbMatch;
  const _cbCalls = [];
  while ((cbMatch = codeBlockRe.exec(text)) !== null) {
    let info = (cbMatch[1] || '').toLowerCase();
    let body = cbMatch[2];

    // Some UIs render the language label on its own line, so the scrape looks
    // like ```\ntool_call\n{...}. Treat a leading tag word as the info string.
    const labelOnOwnLine = body.match(/^[ \t]*(tool_call|json)[ \t]*\r?\n/i);
    if (!info && labelOnOwnLine) {
      info = labelOnOwnLine[1].toLowerCase();
      body = body.slice(labelOnOwnLine[0].length);
    }

    body = body.trim();
    const before = text.slice(0, cbMatch.index).trim();
    const after = text.slice(codeBlockRe.lastIndex).trim();
    const wholeResponse = before === '' && after === '';

    const tagSaysCall = info === 'tool_call';
    const untaggedCall = info === '' ;
    const dataFence = /^(json|jsonc|javascript|js|ts|typescript|python|py|html|css|bash|sh|shell|yaml|yml|sql|xml|diff|toml)$/.test(info);

    if (!tagSaysCall && !(untaggedCall || dataFence) ) continue;
    if (dataFence && !wholeResponse) continue;      // prose around it => example
    if (!tagSaysCall && !wholeResponse && info !== '') continue;

    const _cp = _parseToolJSON(body, text);
    if (_cp) _cbCalls.push({ name: _cp.name, args: _cp.args });
  }
  if (_cbCalls.length > 0) {
    const _cbBatch = _buildBatch(_cbCalls, text);
    if (_cbBatch) return _finalise(_cbBatch, isKnownTool, toolNames, text);
  }

  // ── Strategy 3: function‑call style: tool_name("arg") or tool_name(key="value", ...)
  const funcMatch = text.match(
    /^\s*([a-zA-Z_][\w]*)\s*\(\s*((?:["'][^"']*["']|[^)])*?)\s*\)\s*$/s
  );
  if (funcMatch) {
    const toolName = funcMatch[1];
    const argsStr = funcMatch[2].trim();
    const args = _parseFunctionArgs(argsStr);
    if (args !== null) {
      return _finalise({ type: 'tool_call', name: toolName, args, rawText: text }, isKnownTool, toolNames, text);
    }
  }

  // ── Strategy 4: TASK_COMPLETE ─────────────────────────────────────────────
  if (_containsTaskComplete(text)) {
    return { type: 'task_complete' };
  }

  // ── Strategy 5: bare JSON object outside any code fence ───────────────────
  // Fenced content is an illustration unless Strategy 2 already accepted it as
  // a call, so it is excluded here. Otherwise an example inside ```json would
  // be executed on the second pass.
  const outsideFences = text.replace(/```[\s\S]*?```/g, ' ');
  const bareResult = _extractBareJSON(outsideFences, isKnownTool);
  if (bareResult) return bareResult;

  // ── Strategy 6: plain text / conversational response ─────────────────────
  return { type: 'text', content: text };
}

function _buildBatch(calls, rawText) {
  const valid = (calls || []).filter(c => c && typeof c.name === 'string' && c.name.trim());
  if (valid.length === 0) return null;
  if (valid.length === 1) {
    return { type: 'tool_call', name: valid[0].name, args: valid[0].args || {}, rawText };
  }
  return {
    type: 'tool_batch',
    calls: valid.map(c => ({ name: c.name, args: c.args || {} })),
    rawText,
  };
}

function _parseBatchJSON(obj, rawText) {
  if (!obj || typeof obj !== 'object') return null;
  const arr = obj.tool_calls || obj.tools || obj.calls || obj.actions;
  if (!Array.isArray(arr)) return null;
  const calls = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const name = item.tool || item.name || item.function;
    if (!name || typeof name !== 'string') continue;
    let args = item.args || item.arguments || item.parameters || item.input || item.params || null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      args = { ...item };
      delete args.tool; delete args.name; delete args.function;
      delete args.args; delete args.arguments; delete args.parameters;
      delete args.input; delete args.params;
    }
    calls.push({ name: name.trim(), args: args || {} });
  }
  return _buildBatch(calls, rawText);
}

// ─────────────────────────────────────────────
//  Core JSON parser — handles both "tool" and "name" key styles
//  and attempts repair of broken JSON
// ─────────────────────────────────────────────

function _parseToolJSON(jsonStr, rawText) {
  if (!jsonStr || typeof jsonStr !== 'string') return null;

  const clean = jsonStr.trim();
  if (!clean || clean[0] !== '{') return null;

  let parsed = _tryJSONParse(clean);
  if (!parsed) parsed = _tryJSONParse(_repairJSON(clean));
  if (!parsed) return _regexExtractToolCall(clean, rawText);

  const _batch = _parseBatchJSON(parsed, rawText);
  if (_batch) return _batch;

  const toolName = parsed.tool || parsed.name || parsed.function;
  if (!toolName || typeof toolName !== 'string') return null;

  let args = parsed.args
    || parsed.arguments
    || parsed.parameters
    || parsed.input
    || parsed.params
    || null;

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    args = { ...parsed };
    delete args.tool;
    delete args.name;
    delete args.function;
    delete args.args;
    delete args.arguments;
    delete args.parameters;
    delete args.input;
    delete args.params;
  }

  return {
    type   : 'tool_call',
    name   : toolName.trim(),
    args   : args || {},
    rawText: rawText,
  };
}

function _tryJSONParse(str) {
  try { return JSON.parse(str); }
  catch { return null; }
}

function _repairJSON(str) {
  // 1. Drop trailing commas before } or ].
  let s = str.replace(/,(\s*[}\]])/g, '$1');

  // 2. Quote unquoted object keys, but ONLY when the key is a bare identifier
  //    immediately followed by `:` at a structural position. This never
  //    touches text inside an existing quoted string because the regex
  //    requires `{` or `,` before the identifier.
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // 3. Convert single-quoted JSON strings to double-quoted ONLY when they
  //    are a value (preceded by :, [ or ,) or a key (followed by :).
  //    Uses a small state machine so quote contents are preserved verbatim.
  let out = '';
  let inDouble = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inDouble = !inDouble; out += ch; continue; }
    if (!inDouble && ch === "'") { out += '"'; continue; }
    out += ch;
  }
  return out;
}

/**
 * Last‑resort extraction when JSON.parse fails (e.g., huge unescaped content).
 * Keeps the robust write_file / append_to_file content extraction.
 */
function _regexExtractToolCall(str, rawText) {
  const nameMatch = str.match(/"(?:tool|name|function)"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const toolName = nameMatch[1].trim();
  if (!toolName) return null;

  const argsMatch = str.match(/"args"\s*:\s*(\{[\s\S]*)/);
  if (!argsMatch) {
    return {
      type   : 'tool_call',
      name   : toolName,
      args   : {},
      rawText: rawText,
    };
  }

  let argsStr = argsMatch[1];

  // Find balanced closing brace
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (esc)          { esc = false; continue; }
    if (ch === '\\')  { esc = true;  continue; }
    if (ch === '"')   { inStr = !inStr; continue; }
    if (inStr)        continue;
    if (ch === '{')   depth++;
    if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end !== -1) argsStr = argsStr.slice(0, end + 1);

  let args = _tryJSONParse(argsStr) || _tryJSONParse(_repairJSON(argsStr));

  if (!args) {
    args = {};
    const simpleKV = /"\s*([^"]+)\s*"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = simpleKV.exec(argsStr)) !== null) {
      args[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
  }

  // Special case: write_file / append_to_file — always extract content fully
  if ((toolName === 'write_file' || toolName === 'append_to_file') && args) {
    const pathM = argsStr.match(/"path"\s*:\s*"([^"]+)"/);
    if (pathM) args.path = pathM[1];

    const contentMatch = argsStr.match(/"content"\s*:\s*"([\s\S]*)/);
    if (contentMatch) {
      let raw = contentMatch[1];
      
      const closingMatch = raw.match(/"\s*\}?\s*\}?\s*$/);
      if (closingMatch) {
        raw = raw.slice(0, -closingMatch[0].length);
      } else if (raw.endsWith('"')) {
        raw = raw.slice(0, -1);
      }

      try {
        raw = JSON.parse('"' + raw + '"');
      } catch (_) {
        // leave raw as-is; regex fallback is best-effort
      }
        
      args.content = raw;
    }
  }

  return {
    type   : 'tool_call',
    name   : toolName,
    args   : args || {},
    rawText: rawText,
  };
}

/**
 * Parses function‑call arguments like `"path/to/file"` or `key="value", count=3`.
 */
function _parseFunctionArgs(argsStr) {
  if (!argsStr) return {};
  const args = {};
  const pairRe = /([a-zA-Z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  const singleRe = /^"([^"]*)"$|^'([^']*)'$/;

  let remainder = argsStr;
  let match;

  // First try key=value pairs
  while ((match = pairRe.exec(argsStr)) !== null) {
    const key = match[1];
    const val = match[2] ?? match[3] ?? match[4];
    args[key] = val;
    remainder = remainder.replace(match[0], '').replace(/^,?\s*/, '');
  }

  // If nothing captured but there is content, treat it as a single "path" argument
  if (Object.keys(args).length === 0 && argsStr.trim().length > 0) {
    const single = singleRe.exec(argsStr.trim());
    if (single) {
      args.path = single[1] || single[2];
    } else {
      // Fallback: treat the whole thing as a path if it looks like a filename
      if (/^[\w./-]+$/.test(argsStr.trim())) {
        args.path = argsStr.trim();
      } else {
        return null; // unrecognised
      }
    }
  }

  return args;
}

function _extractBareJSON(text, isKnownTool) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc)         { esc = false; continue; }
      if (ch === '\\') { esc = true;  continue; }
      if (ch === '"')  { inStr = !inStr; continue; }
      if (inStr)       continue;
      if (ch === '{')  depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const result = _parseToolJSON(text.slice(i, j + 1), text);

          // A bare JSON object whose "name" is not a registered tool is prose
          // (a package.json, a config sample, a data structure). Keep looking
          // for a real call further down instead of executing it.
          const unknownName = result
            && isKnownTool
            && result.type === 'tool_call'
            && !isKnownTool(result.name);

          if (result && !unknownName) return result;

          i = j;                       // skip past this object, keep scanning
          break;
        }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
//  Validation: unknown tool names
// ─────────────────────────────────────────────

/**
 * @typedef {object} ParsedResult
 * @property {string} type
 * @property {string} [name]
 * @property {object} [args]
 * @property {Array<{name: string, args: object}>} [calls]
 * @property {string|null} [suggestion]
 * @property {string} [rawText]
 * @property {string} [content]
 * @property {string} [message]
 */

/**
 * Reject calls whose tool name is not in the registry, and suggest the nearest
 * real tool. Without this a typo ("read_fle") reached the executor, which
 * replied with the entire 45-tool registry (~2k characters) every time.
 *
 * @param {object} parsed
 * @param {((name: string) => boolean)|null} isKnownTool
 * @param {string[]|null} toolNames
 * @param {string} rawText
 */
function _finalise(
  /** @type {ParsedResult|null} */ parsed,
  /** @type {((name: string) => boolean)|null} */ isKnownTool,
  /** @type {string[]|null} */ toolNames,
  /** @type {string} */ rawText
) {
  if (!parsed || !isKnownTool) return parsed;

  const bad = (c) => !c || typeof c.name !== 'string' || !isKnownTool(c.name);

  if (parsed.type === 'tool_call') {
    if (!bad(parsed)) return parsed;
    return {
      type: 'invalid_tool',
      name: parsed.name,
      args: parsed.args || {},
      suggestion: _nearestTool(parsed.name, toolNames),
      rawText,
    };
  }

  if (parsed.type === 'tool_batch') {
    const offender = (parsed.calls || []).find(bad);
    if (!offender) return parsed;
    // Nothing executes: a partially-valid batch would surprise the model about
    // ordering. Report the first offender and let it retry.
    return {
      type: 'invalid_tool',
      name: offender.name,
      args: offender.args || {},
      suggestion: _nearestTool(offender.name, toolNames),
      rawText,
    };
  }

  return parsed;
}

/**
 * Nearest registered tool name within edit distance 2, or null.
 * @param {string} name
 * @param {string[]|null} toolNames
 * @returns {string|null}
 */
function _nearestTool(name, toolNames) {
  if (!Array.isArray(toolNames) || !name) return null;

  let best = null;
  let bestDist = 3;

  for (const candidate of toolNames) {
    const d = _editDistance(String(name).toLowerCase(), String(candidate).toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  if (bestDist <= 2) return best;

  // Fall back to a prefix / containment match: "list_dir" -> "list_directory",
  // "git_st" -> "git_status".
  const lower = String(name).toLowerCase();
  const prefix = toolNames.find((n) => n.toLowerCase().startsWith(lower));
  if (prefix) return prefix;

  return null;
}

/** Levenshtein distance, iterative, bounded by short tool names. */
function _editDistance(a, b) {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }

  return prev[b.length];
}

// ─────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────

function _containsTaskComplete(text) {
  return /(?:^|\n)\s*TASK_COMPLETE\s*(?:\n|$)/m.test(text)
    || text.trim().endsWith('TASK_COMPLETE')
    || text.trim() === 'TASK_COMPLETE';
}

function containsTaskComplete(text) { return _containsTaskComplete(text); }

function hasToolCall(text) {
  if (!text) return false;
  return /<tool_call>/i.test(text)
    || /```(?:tool_call|json)/i.test(text)
    || /\{[\s\S]*"(?:tool|name)"\s*:/i.test(text)
    || /^\s*[a-zA-Z_]\w*\s*\(/.test(text);  // function call style
}

function extractLeadingText(text) {
  if (!text) return '';
  const tag = text.indexOf('<tool_call>');
  if (tag > 0) return text.slice(0, tag).trim();
  const tick = text.indexOf('```');
  if (tick > 0) return text.slice(0, tick).trim();
  const json = text.search(/\{[\s\S]*"(?:tool|name)"\s*:/i);
  if (json > 0) return text.slice(0, json).trim();
  return '';
}

module.exports = {
  parseResponse,
  hasToolCall,
  containsTaskComplete,
  extractLeadingText,
  tryParseToolJSON: _parseToolJSON,
};