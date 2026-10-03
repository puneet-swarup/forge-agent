// app.js — Forge Agent control dashboard
'use strict';

// ── State ──
const state = {
  instances: [],
  selected: null,      // { id, sessionDir, ... }
  events: new Map(),   // id -> [event]
  logErrorsOnly: false,
  filter: '',
};

// ── DOM ──
const $ = (sel) => document.querySelector(sel);
const el = {
  conn: $('#conn'),
  refreshBtn: $('#refreshBtn'),
  newBtn: $('#newBtn'),
  instCount: $('#instCount'),
  instFilter: $('#instFilter'),
  instanceList: $('#instanceList'),
  chatName: $('#chatName'),
  chatMeta: $('#chatMeta'),
  clearBtn: $('#clearBtn'),
  stopBtn: $('#stopBtn'),
  transcript: $('#transcript'),
  inputForm: $('#inputForm'),
  inputBox: $('#inputBox'),
  sendBtn: $('#sendBtn'),
  logPane: $('#logPane'),
  logErrorsOnly: $('#logErrorsOnly'),
  modal: $('#modal'),
  modalClose: $('#modalClose'),
  modalCancel: $('#modalCancel'),
  modalStart: $('#modalStart'),
  mTask: $('#mTask'),
  mSession: $('#mSession'),
  mRole: $('#mRole'),
  mModel: $('#mModel'),
  mProfile: $('#mProfile'),
  mHeadless: $('#mHeadless'),
  mError: $('#mError'),
};

// ── Helpers ──
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtUptime(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

async function api(pathname, opts) {
  const res = await fetch(pathname, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

function nearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}
function scrollToBottom(node) {
  node.scrollTop = node.scrollHeight;
}

// ── Instance list rendering ──
function visibleInstances() {
  const f = state.filter.toLowerCase();
  if (!f) return state.instances;
  return state.instances.filter(i =>
    (i.id || '').toLowerCase().includes(f) ||
    (i.role || '').toLowerCase().includes(f)
  );
}

function renderInstances() {
  const list = visibleInstances();
  el.instCount.textContent = String(state.instances.length);

  if (list.length === 0) {
    el.instanceList.innerHTML = '<li class="empty small" style="padding:12px;color:var(--muted)">No instances match.</li>';
    return;
  }

  el.instanceList.innerHTML = list.map(inst => {
    const active = state.selected && state.selected.id === inst.id ? ' active' : '';
    const dot = inst.alive ? 'dot--live' : 'dot--dead';
    const sub = [
      inst.role || 'agent',
      inst.alive ? 'pid ' + inst.pid : 'stopped',
      fmtUptime(inst.uptimeMs),
    ].join(' · ');
    return '<li class="instance-item' + active + '" data-id="' + esc(inst.id) + '">' +
      '<div class="ii-name"><span class="dot ' + dot + '"></span>' + esc(inst.id) + '</div>' +
      '<div class="ii-sub">' + esc(sub) + '</div>' +
    '</li>';
  }).join('');

  el.instanceList.querySelectorAll('.instance-item').forEach(node => {
    node.addEventListener('click', () => selectInstance(node.dataset.id));
  });
}

// ── Selection ──
function selectInstance(id) {
  const inst = state.instances.find(i => i.id === id);
  if (!inst) return;
  state.selected = inst;

  el.chatName.textContent = inst.id;
  el.chatMeta.textContent = [inst.role || 'agent', inst.model || 'model?', inst.cwd || ''].join('  ·  ');
  el.inputBox.disabled = false;
  el.sendBtn.disabled = false;
  el.stopBtn.disabled = !inst.alive;

  renderInstances();
  renderTranscript();
  renderLog();

  // Backfill history for this instance if we have none yet.
  if (!state.events.has(id)) {
    api('/api/events?id=' + encodeURIComponent(id) + '&limit=400')
      .then(data => {
        state.events.set(id, data.events || []);
        renderTranscript();
        renderLog();
      })
      .catch(() => { state.events.set(id, []); });
  }
}

// ── Event → chat message mapping ──
function eventToMessage(evt) {
  const t = evt.type;
  const d = evt.data || {};

  if (t === 'task') {
    return { cls: 'msg--user', head: 'You', body: d.task || '(task)' };
  }
  if (t === 'ui_input') {
    return { cls: 'msg--user', head: 'You (UI)', body: d.message || '' };
  }
  if (t === 'step') {
    return { cls: 'msg--event', head: '', body: 'step ' + (d.step != null ? d.step : '?') };
  }
  if (t === 'tool_call') {
    const args = d.args ? JSON.stringify(d.args).slice(0, 200) : '';
    return { cls: 'msg--agent', head: 'Tool call', body: '<span class="tool-chip">' + esc(d.name) + '</span>' + esc(args) };
  }
  if (t === 'tool_result') {
    return { cls: 'msg--agent', head: 'Tool result', body: esc(String(d.result == null ? '' : d.result).slice(0, 4000)) };
  }
  if (t === 'error') {
    return { cls: 'msg--error', head: 'Error', body: esc(d.message || String(d)) };
  }
  if (t === 'final') {
    return { cls: 'msg--final', head: 'Result', body: esc(d.content || '') };
  }
  if (t === 'output') {
    return { cls: 'msg--agent', head: 'Output', body: esc(String(d.text || '').slice(0, 4000)) };
  }
  if (t === 'status') {
    return { cls: 'msg--event', head: '', body: esc(d.status || '') };
  }
  return { cls: 'msg--event', head: t, body: esc(JSON.stringify(d).slice(0, 300)) };
}

function renderTranscript() {
  if (!state.selected) {
    el.transcript.innerHTML = '<div class="empty"><p>Select an instance on the left, or create a new one.</p></div>';
    return;
  }
  const events = state.events.get(state.selected.id) || [];
  const stick = nearBottom(el.transcript);

  if (events.length === 0) {
    el.transcript.innerHTML = '<div class="empty"><p>No activity yet for <b>' + esc(state.selected.id) + '</b>.</p>' +
      '<p class="small">Type a task below to start it.</p></div>';
    return;
  }

  el.transcript.innerHTML = events.map(evt => {
    const m = eventToMessage(evt);
    const head = m.head ? '<div class="msg-head">' + esc(m.head) + ' · ' + fmtTime(evt.ts) + '</div>' : '';
    const isHtmlBody = m.cls === 'msg--agent' && /<span class="tool-chip"/.test(m.body);
    const body = isHtmlBody ? m.body : esc(m.body);
    return '<div class="msg ' + m.cls + '">' + head + '<div class="msg-body">' + body + '</div></div>';
  }).join('');

  if (stick) scrollToBottom(el.transcript);
}

// ── Log pane ──
function logClassFor(evt) {
  if (evt.type === 'error') return 'error';
  if (evt.type === 'tool_call' || evt.type === 'tool_result') return 'info';
  if (evt.type === 'final') return 'info';
  return '';
}

function logTextFor(evt) {
  const d = evt.data || {};
  switch (evt.type) {
    case 'error': return d.message || JSON.stringify(d);
    case 'tool_call': return 'call ' + d.name + ' ' + (d.args ? JSON.stringify(d.args).slice(0, 160) : '');
    case 'tool_result': return 'result ' + String(d.result == null ? '' : d.result).slice(0, 200);
    case 'step': return 'step ' + (d.step != null ? d.step : '?');
    case 'task': return 'task: ' + String(d.task || '').slice(0, 160);
    case 'ui_input': return 'input: ' + String(d.message || '').slice(0, 160);
    case 'final': return 'final: ' + String(d.content || '').slice(0, 200);
    case 'status': return String(d.status || '');
    default: return JSON.stringify(d).slice(0, 200);
  }
}

function renderLog() {
  if (!state.selected) {
    el.logPane.innerHTML = '<div class="empty small" style="color:var(--muted)">No instance selected.</div>';
    return;
  }
  let events = state.events.get(state.selected.id) || [];
  if (state.logErrorsOnly) {
    events = events.filter(e => e.type === 'error');
  }
  const stick = nearBottom(el.logPane);

  if (events.length === 0) {
    el.logPane.innerHTML = '<div class="empty small" style="color:var(--muted)">' +
      (state.logErrorsOnly ? 'No errors. ' : 'No log entries yet.') + '</div>';
    return;
  }

  // Show newest first would be jarring while streaming; keep chronological.
  el.logPane.innerHTML = events.map(evt => {
    const cls = logClassFor(evt);
    return '<div class="log-line ' + cls + '">' +
      '<span class="log-time">' + fmtTime(evt.ts) + '</span>' +
      '<span class="log-tag">' + esc(evt.type) + '</span>' +
      esc(logTextFor(evt)) +
    '</div>';
  }).join('');

  if (stick) scrollToBottom(el.logPane);
}

// ── SSE connection ──
let es = null;
let reconnectDelay = 1000;

function setConn(on) {
  el.conn.className = 'conn ' + (on ? 'conn--on' : 'conn--off');
  el.conn.title = on ? 'connected' : 'disconnected';
}

function handleStreamMessage(msg) {
  if (!msg) return;

  if (msg.stream === 'instances') {
    state.instances = msg.instances || [];
    // Keep selection in sync with latest metadata.
    if (state.selected) {
      const fresh = state.instances.find(i => i.id === state.selected.id);
      if (fresh) {
        state.selected = fresh;
        el.stopBtn.disabled = !fresh.alive;
        el.chatMeta.textContent = [fresh.role || 'agent', fresh.model || 'model?', fresh.cwd || ''].join('  ·  ');
      }
    }
    renderInstances();
    return;
  }

  if (msg.stream === 'event' && msg.event) {
    const id = msg.instance;
    if (!state.events.has(id)) state.events.set(id, []);
    state.events.get(id).push(msg.event);

    if (state.selected && state.selected.id === id) {
      renderTranscript();
      renderLog();
    }
    return;
  }
}

function connect() {
  try { es = new EventSource('/api/stream'); } catch (_) { scheduleReconnect(); return; }

  es.onopen = () => { setConn(true); reconnectDelay = 1000; };
  es.onerror = () => {
    setConn(false);
    try { es.close(); } catch (_) {}
    scheduleReconnect();
  };
  es.onmessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    handleStreamMessage(msg);
  };
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    connect();
  }, reconnectDelay);
}

// ── Actions ──
async function sendInput(text) {
  if (!state.selected || !text.trim()) return;
  const id = state.selected.id;
  try {
    await api('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, message: text }),
    });
    // Optimistically show it in the transcript.
    if (!state.events.has(id)) state.events.set(id, []);
    state.events.get(id).push({ ts: Date.now(), type: 'ui_input', data: { message: text } });
    renderTranscript();
  } catch (err) {
    pushLocalError(id, 'Failed to send input: ' + err.message);
  }
}

function pushLocalError(id, message) {
  if (!state.events.has(id)) state.events.set(id, []);
  state.events.get(id).push({ ts: Date.now(), type: 'error', data: { message } });
  renderTranscript();
  renderLog();
}

async function refreshInstances() {
  try {
    const data = await api('/api/instances');
    state.instances = data.instances || [];
    renderInstances();
  } catch (err) {
    setConn(false);
  }
}

async function stopSelected() {
  if (!state.selected) return;
  if (!confirm('Stop instance "' + state.selected.id + '"?')) return;
  try {
    await api('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.selected.id }),
    });
    el.stopBtn.disabled = true;
  } catch (err) {
    pushLocalError(state.selected.id, 'Stop failed: ' + err.message);
  }
}

// ── New instance modal ──
function openModal() {
  el.mError.textContent = '';
  el.modal.classList.remove('hidden');
  el.mTask.focus();
}
function closeModal() {
  el.modal.classList.add('hidden');
}

async function startNewInstance() {
  el.mError.textContent = '';
  const payload = {
    task: el.mTask.value.trim() || undefined,
    session: el.mSession.value.trim() || undefined,
    role: el.mRole.value.trim() || undefined,
    model: el.mModel.value || undefined,
    profile: el.mProfile.value || undefined,
    headless: el.mHeadless.checked,
  };

  el.modalStart.disabled = true;
  try {
    const res = await api('/api/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    closeModal();
    // Reset form.
    el.mTask.value = ''; el.mSession.value = ''; el.mRole.value = '';
    el.mModel.value = ''; el.mProfile.value = ''; el.mHeadless.checked = false;

    // Give the new process a moment to write its heartbeat, then select it.
    setTimeout(async () => {
      await refreshInstances();
      if (res.session) selectInstance(res.session);
    }, 1200);
  } catch (err) {
    el.mError.textContent = err.message;
  } finally {
    el.modalStart.disabled = false;
  }
}

// ── Wire events ──
function wire() {
  el.refreshBtn.addEventListener('click', refreshInstances);
  el.newBtn.addEventListener('click', openModal);
  el.modalClose.addEventListener('click', closeModal);
  el.modalCancel.addEventListener('click', closeModal);
  el.modalStart.addEventListener('click', startNewInstance);
  el.stopBtn.addEventListener('click', stopSelected);

  el.clearBtn.addEventListener('click', () => {
    if (!state.selected) return;
    state.events.set(state.selected.id, []);
    renderTranscript();
    renderLog();
  });

  el.instFilter.addEventListener('input', () => {
    state.filter = el.instFilter.value;
    renderInstances();
  });

  el.logErrorsOnly.addEventListener('change', () => {
    state.logErrorsOnly = el.logErrorsOnly.checked;
    renderLog();
  });

  el.inputForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.inputBox.value;
    if (!text.trim()) return;
    el.inputBox.value = '';
    sendInput(text);
  });

  el.inputBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.inputForm.requestSubmit();
    }
  });
}

// ── Init ──
function init() {
  wire();
  renderInstances();
  renderTranscript();
  renderLog();
  refreshInstances();
  connect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
