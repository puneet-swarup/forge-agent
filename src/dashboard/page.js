// src/dashboard/page.js — the whole dashboard as one self-contained document.
//
// Constraints that shape this file:
//   * no CDN, no build step, no external request of any kind — it must render
//     correctly with the network unplugged;
//   * every value on screen comes from disk, so every interpolation is escaped
//     (see esc() in the inline script);
//   * the token is injected server-side so the page can poll /api/state.
//
// The document is returned as a plain string. All styling and behaviour are
// inline; the browser script is written without template literals so this file
// stays a readable single template.
'use strict';

/**
 * Render the dashboard document.
 *
 * @param {Object} [opts]
 * @param {string} [opts.token]     token the page must send with every poll
 * @param {string} [opts.forgeHome] forge home to show in the header
 * @returns {string} the complete HTML document
 */
function renderPage(opts = {}) {
  const token = typeof opts.token === 'string' ? opts.token : '';
  const forgeHome = typeof opts.forgeHome === 'string' ? opts.forgeHome : '';
  // JSON.stringify for a JS string literal, then neutralise "<" so the value
  // can never close the script element.
  const tokenLiteral = JSON.stringify(token).replace(/</g, '\\u003c');
  const homeLiteral = JSON.stringify(forgeHome).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Forge Agent — Dashboard</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #121722;
    --panel-2: #0f141d;
    --line: #1f2735;
    --line-soft: #182030;
    --text: #d7dee9;
    --dim: #8b98ab;
    --faint: #5d6a7d;
    --accent: #5eead4;
    --accent-2: #7dd3fc;
    --ok: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
            Arial, "Noto Sans", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    transition: opacity .3s ease;
  }
  body.stale { opacity: .5; }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .mono { font-family: var(--mono); }
  .dim { color: var(--dim); }
  .faint { color: var(--faint); }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 0 20px 48px; }

  header.top {
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #101725 0%, var(--bg) 100%);
    padding: 18px 0 14px;
    margin-bottom: 18px;
  }
  header.top .wrap { padding-bottom: 0; display: flex; flex-wrap: wrap; gap: 16px;
    align-items: flex-end; justify-content: space-between; }
  .brand { font-size: 20px; font-weight: 650; letter-spacing: .2px; }
  .brand .hammer { color: var(--accent); }
  .brand .sub { color: var(--dim); font-weight: 400; font-size: 15px; }
  .tagline { color: var(--faint); font-size: 12px; margin-top: 2px; }
  .meta { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; font-size: 12px; }
  .meta .home { font-family: var(--mono); color: var(--dim); max-width: 44ch;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live { display: inline-flex; align-items: center; gap: 7px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn);
    box-shadow: 0 0 0 3px rgba(251,191,36,.12); display: inline-block; }
  .dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(74,222,128,.14); }
  .dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(248,113,113,.14); }

  button {
    font-family: inherit; font-size: 12px; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; padding: 5px 10px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  button.stop { border-color: #4a2a2f; color: #fca5a5; }
  button.stop:hover { border-color: var(--bad); background: #2a1519; color: #fff; }

  .strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px; margin-bottom: 22px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 12px; }
  .tile .n { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .tile .k { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
  .tile .extra { font-size: 11px; color: var(--dim); }

  section { margin-bottom: 26px; }
  section > h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .1em;
    color: var(--dim); font-weight: 600; margin: 0 0 8px;
    display: flex; align-items: baseline; gap: 10px;
  }
  section > h2 .count { color: var(--faint); font-weight: 400; letter-spacing: 0; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    overflow: hidden; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    text-align: left; font-weight: 600; font-size: 11px; letter-spacing: .06em;
    text-transform: uppercase; color: var(--faint);
    background: var(--panel-2); border-bottom: 1px solid var(--line);
    padding: 8px 12px; white-space: nowrap;
  }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--line-soft);
    vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: #151b27; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.task { max-width: 46ch; }
  .trunc { display: block; max-width: 46ch; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .nil { color: var(--faint); }
  .empty { padding: 16px; color: var(--dim); font-size: 13px; }
  .empty .why { color: var(--faint); font-size: 12px; margin-top: 3px; }

  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px;
    font-size: 11px; font-weight: 600; letter-spacing: .02em;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--dim); }
  .pill.running, .pill.completed, .pill.alive { color: var(--ok);
    border-color: rgba(74,222,128,.3); background: rgba(74,222,128,.08); }
  .pill.starting, .pill.partial, .pill.unresponsive, .pill.idle { color: var(--warn);
    border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.08); }
  .pill.dead, .pill.failed, .pill.timeout, .pill.killed, .pill.crashed { color: var(--bad);
    border-color: rgba(248,113,113,.3); background: rgba(248,113,113,.08); }
  .pill.stopped { color: var(--faint); }

  footer { color: var(--faint); font-size: 11px; border-top: 1px solid var(--line);
    padding-top: 14px; display: flex; flex-wrap: wrap; gap: 6px 16px; }
  #banner { display: none; margin: 0 0 16px; padding: 9px 12px; border-radius: 8px;
    border: 1px solid rgba(248,113,113,.35); background: rgba(248,113,113,.08);
    color: #fca5a5; font-size: 13px; }
  #banner.show { display: block; }
  .nowrap { white-space: nowrap; }

  @media (max-width: 900px) {
    .strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .wrap { padding: 0 14px 40px; }
    header.top .wrap { align-items: flex-start; }
    .meta .home { max-width: 100%; }
    td.task { max-width: 26ch; }
    .trunc { max-width: 26ch; }
  }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div>
      <div class="brand"><span class="hammer">🔨</span> Forge Agent <span class="sub">Dashboard</span></div>
      <div class="tagline">Agents · Sessions · Projects · Tasks · Processes — one page, read from disk.</div>
    </div>
    <div class="meta">
      <span class="home mono" id="home" title="forge home">${escapeHtml(forgeHome) || 'forge home: unknown'}</span>
      <span class="live"><span class="dot" id="dot"></span><span id="status">connecting…</span></span>
      <span class="dim nowrap">last updated <span id="updated">never</span></span>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </div>
</header>

<div class="wrap">
  <div id="banner">Server unreachable — showing the last snapshot. Retrying every 2s.</div>
  <div class="strip" id="summary"></div>

  <section id="sec-agents">
    <h2>Agents <span class="count" id="n-agents"></span></h2>
    <div class="panel" id="agents"></div>
  </section>

  <section id="sec-sessions">
    <h2>Sessions <span class="count" id="n-sessions"></span></h2>
    <div class="panel" id="sessions"></div>
  </section>

  <section id="sec-projects">
    <h2>Projects <span class="count" id="n-projects"></span></h2>
    <div class="panel" id="projects"></div>
  </section>

  <section id="sec-tasks">
    <h2>Tasks <span class="count" id="n-tasks"></span></h2>
    <div class="panel" id="tasks"></div>
  </section>

  <section id="sec-processes">
    <h2>Processes <span class="count" id="n-processes"></span></h2>
    <div class="panel" id="processes"></div>
  </section>

  <footer>
    <span>Snapshot of <span class="mono" id="home2"></span></span>
    <span>polls every 2s · no external requests · served on 127.0.0.1 only</span>
  </footer>
</div>

<script>
(function () {
  'use strict';

  var TOKEN = ${tokenLiteral};
  var HOME_HINT = ${homeLiteral};
  var POLL_MS = 2000;
  var state = null;
  var timer = null;

  // ── escaping ───────────────────────────────────────────────────────────
  // Everything on this page came from a file on disk, so nothing is trusted.
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function cell(value) {
    if (value === null || value === undefined || value === '') return '<span class="nil">—</span>';
    return esc(value);
  }
  function text(value) {
    return value === null || value === undefined ? '' : esc(value);
  }
  function pill(status) {
    if (!status) return '<span class="nil">—</span>';
    var cls = String(status).toLowerCase().replace(/[^a-z0-9-]/g, '');
    return '<span class="pill ' + cls + '">' + esc(status) + '</span>';
  }

  // ── formatting ─────────────────────────────────────────────────────────
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function fmtAgo(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function fmtDuration(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return null;
    var s = Math.floor(Math.max(0, ms) / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function count(list) { return Array.isArray(list) ? list.length : 0; }

  function emptyState(what, why) {
    return '<div class="empty">' + esc(what) +
      (why ? '<div class="why">' + esc(why) + '</div>' : '') + '</div>';
  }

  function table(headers, rows, numCols) {
    var html = '<div class="scroll"><table><thead><tr>';
    for (var i = 0; i < headers.length; i++) {
      var isNum = numCols && numCols.indexOf(i) !== -1;
      html += '<th' + (isNum ? ' style="text-align:right"' : '') + '>' + esc(headers[i]) + '</th>';
    }
    html += '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    return html;
  }

  function td(value, cls) {
    return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</td>';
  }

  // ── sections ───────────────────────────────────────────────────────────
  function renderSummary(s) {
    var tiles = [
      { k: 'agents', n: count(s.agents), extra: count(s.agents.filter(function (a) { return a.alive; })) + ' alive' },
      { k: 'sessions', n: count(s.sessions), extra: 'on disk' },
      { k: 'projects', n: count(s.projects), extra: 'touched by history' },
      { k: 'tasks', n: count(s.tasks), extra: 'in history.json' },
      { k: 'processes', n: count(s.processes), extra: 'background' }
    ];
    var html = '';
    for (var i = 0; i < tiles.length; i++) {
      html += '<div class="tile"><div class="k">' + esc(tiles[i].k) + '</div>' +
        '<div class="n">' + esc(tiles[i].n) + '</div>' +
        '<div class="extra">' + esc(tiles[i].extra) + '</div></div>';
    }
    document.getElementById('summary').innerHTML = html;
  }

  function renderAgents(list) {
    var el = document.getElementById('agents');
    document.getElementById('n-agents').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) {
      el.innerHTML = emptyState('no agents running',
        'nothing in ' + (HOME_HINT || 'the forge home') + '/instances — spawn one with forge-agent, or a child may have exited');
      return;
    }
    var rows = list.map(function (a) {
      var action = a.alive
        ? '<button class="stop" type="button" data-stop="' + esc(a.id) + '">Stop</button>'
        : '<span class="nil">—</span>';
      return '<tr>' +
        td('<span class="mono">' + cell(a.id) + '</span>') +
        td('<span class="mono">' + cell(a.session) + '</span>') +
        td(a.pid === null ? '<span class="nil">—</span>' : '<span class="mono">' + esc(a.pid) + '</span>', 'num') +
        td(pill(a.status)) +
        td('<span class="trunc" title="' + text(a.task) + '">' + cell(a.task) + '</span>', 'task') +
        td('<span class="nowrap">' + (cell(fmtTime(a.startedAt))) + '</span>') +
        td('<span class="nowrap">' + (fmtAgo(a.lastHeartbeat) ? esc(fmtAgo(a.lastHeartbeat)) : '<span class="nil">—</span>') + '</span>') +
        td('<span class="mono">' + cell(a.workingDir) + '</span>') +
        td('<span class="pill ' + (a.alive ? 'alive' : 'dead') + '">' + (a.alive ? 'alive' : 'gone') + '</span>') +
        td(action) +
        '</tr>';
    });
    el.innerHTML = table(
      ['id', 'session', 'pid', 'status', 'task', 'started', 'heartbeat', 'working dir', 'alive', ''],
      rows, [2]);
  }

  function renderSessions(list) {
    var el = document.getElementById('sessions');
    document.getElementById('n-sessions').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) {
      el.innerHTML = emptyState('no sessions yet',
        'no directories under ' + (HOME_HINT || 'the forge home') + '/sessions');
      return;
    }
    var rows = list.map(function (s) {
      var files = Array.isArray(s.filesWritten) ? s.filesWritten.length : null;
      var log = '<a class="mono" target="_blank" rel="noreferrer" href="/api/sessions/' +
        encodeURIComponent(s.name) + '/log?lines=200&token=' + encodeURIComponent(TOKEN) + '">log</a>';
      return '<tr>' +
        td('<span class="mono">' + cell(s.name) + '</span>') +
        td('<span class="trunc" title="' + text(s.task) + '">' + cell(s.task) + '</span>', 'task') +
        td(pill(s.status)) +
        td('<span class="nowrap">' + cell(fmtTime(s.startedAt)) + '</span>') +
        td(files === null ? '<span class="nil">—</span>' : esc(files), 'num') +
        td('<span class="mono">' + cell(s.dir) + '</span>') +
        td(log) +
        '</tr>';
    });
    el.innerHTML = table(['name', 'task', 'status', 'started', 'files', 'dir', ''], rows, [4]);
  }

  function renderProjects(list) {
    var el = document.getElementById('projects');
    document.getElementById('n-projects').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) {
      el.innerHTML = emptyState('no projects recorded',
        'history.json has no working directories yet — run a task and one appears here');
      return;
    }
    var rows = list.map(function (p) {
      return '<tr>' +
        td('<span class="mono">' + cell(p.path) + '</span>') +
        td(cell(p.name)) +
        td(p.gitBranch ? '<span class="mono">' + esc(p.gitBranch) + '</span>' : '<span class="nil">—</span>') +
        td(esc(p.sessionCount === null || p.sessionCount === undefined ? 0 : p.sessionCount), 'num') +
        td('<span class="nowrap">' + (fmtAgo(p.lastActivity) ? esc(fmtAgo(p.lastActivity)) : '<span class="nil">—</span>') + '</span>') +
        '</tr>';
    });
    el.innerHTML = table(['path', 'name', 'branch', 'sessions', 'last activity'], rows, [3]);
  }

  function renderTasks(list) {
    var el = document.getElementById('tasks');
    document.getElementById('n-tasks').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) {
      el.innerHTML = emptyState('no tasks in history',
        'history.json is missing or empty — nothing has finished a run yet');
      return;
    }
    var rows = list.map(function (t) {
      var files = Array.isArray(t.filesWritten) ? t.filesWritten.length : null;
      var model = [t.model, t.profile].filter(function (x) { return x; }).join(' · ');
      return '<tr>' +
        td('<span class="trunc" title="' + text(t.task) + '">' + cell(t.task) + '</span>', 'task') +
        td(pill(t.status)) +
        td(model ? '<span class="mono">' + esc(model) + '</span>' : '<span class="nil">—</span>') +
        td(fmtDuration(t.durationMs) ? esc(fmtDuration(t.durationMs)) : '<span class="nil">—</span>', 'num') +
        td(t.steps === null || t.steps === undefined ? '<span class="nil">—</span>' : esc(t.steps), 'num') +
        td(files === null ? '<span class="nil">—</span>' : esc(files), 'num') +
        td(t.verification ? '<span class="trunc" title="' + text(t.verification) + '">' + esc(t.verification) + '</span>' : '<span class="nil">—</span>') +
        td('<span class="nowrap">' + cell(fmtTime(t.finishedAt)) + '</span>') +
        '</tr>';
    });
    el.innerHTML = table(
      ['task', 'status', 'model · profile', 'duration', 'steps', 'files', 'verification', 'finished'],
      rows, [3, 4, 5]);
  }

  function renderProcesses(list) {
    var el = document.getElementById('processes');
    document.getElementById('n-processes').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) {
      el.innerHTML = emptyState('no background processes',
        'process-manager keeps these in memory, so only a same-process dashboard or a processes.json snapshot can show them');
      return;
    }
    var rows = list.map(function (p) {
      var up = fmtDuration(p.uptimeMs);
      return '<tr>' +
        td('<span class="mono">' + cell(p.name) + '</span>') +
        td(p.pid === null || p.pid === undefined ? '<span class="nil">—</span>' : '<span class="mono">' + esc(p.pid) + '</span>', 'num') +
        td(pill(p.status)) +
        td(up ? esc(up) : '<span class="nil">—</span>', 'num') +
        td('<span class="mono">' + cell(p.command) + '</span>') +
        '</tr>';
    });
    el.innerHTML = table(['name', 'pid', 'status', 'uptime', 'command'], rows, [1, 3]);
  }

  // ── stop an agent ──────────────────────────────────────────────────────
  function stopAgent(id, button) {
    button.disabled = true;
    button.textContent = 'stopping…';
    fetch('/api/agents/' + encodeURIComponent(id) + '/stop?token=' + encodeURIComponent(TOKEN), {
      method: 'POST'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ('HTTP ' + res.status));
        return body;
      });
    }).then(function () {
      poll();
    }).catch(function (err) {
      button.disabled = false;
      button.textContent = 'Stop';
      setStatus('stop failed: ' + err.message, 'bad');
    });
  }

  document.addEventListener('click', function (ev) {
    var target = ev.target;
    if (!target || !target.getAttribute) return;
    var id = target.getAttribute('data-stop');
    if (id) stopAgent(id, target);
  });

  // ── status line ────────────────────────────────────────────────────────
  function setStatus(label, tone) {
    var status = document.getElementById('status');
    var dot = document.getElementById('dot');
    status.textContent = label;
    dot.className = 'dot' + (tone ? ' ' + tone : '');
  }

  function markStale(isStale) {
    document.body.classList.toggle('stale', !!isStale);
    document.getElementById('banner').className = isStale ? 'show' : '';
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function render(s) {
    state = s;
    var home = s.forgeHome || HOME_HINT || 'unknown';
    document.getElementById('home').textContent = home;
    document.getElementById('home').title = home;
    document.getElementById('home2').textContent = home;
    renderSummary(s);
    renderAgents(Array.isArray(s.agents) ? s.agents : []);
    renderSessions(Array.isArray(s.sessions) ? s.sessions : []);
    renderProjects(Array.isArray(s.projects) ? s.projects : []);
    renderTasks(Array.isArray(s.tasks) ? s.tasks : []);
    renderProcesses(Array.isArray(s.processes) ? s.processes : []);
    var when = fmtTime(s.generatedAt);
    document.getElementById('updated').textContent = when ? when + ' (' + (fmtAgo(s.generatedAt) || 'now') + ')' : 'never';
  }

  function poll() {
    var url = '/api/state?token=' + encodeURIComponent(TOKEN) + '&t=' + Date.now();
    fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401) throw new Error('token rejected');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        markStale(false);
        setStatus('live', 'ok');
        render(body);
      })
      .catch(function (err) {
        markStale(true);
        setStatus('offline — ' + err.message, 'bad');
      });
  }

  document.getElementById('refresh').addEventListener('click', poll);

  poll();
  timer = setInterval(poll, POLL_MS);
  window.addEventListener('beforeunload', function () { if (timer) clearInterval(timer); });
})();
</script>
</body>
</html>
`;
}

/** Minimal HTML escaping for the two values injected into the header. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { renderPage };
