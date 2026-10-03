# Forge Agent — Enhancement Context (feat/control-ui branch)

This document is a complete, code-free explanation of every enhancement on this
branch, written so a future reader can understand the work WITHOUT reading the
source. It covers purpose, design, key files, how to run, how to test, gotchas,
and the reasoning behind decisions.

Branch: feat/control-ui
Base:   origin/main @ 844a935 (parallel tools, audio, sessions/registry)
Tip:    0eb2248 (browser control UI)

---

## 0. Orientation — what this fork adds vs upstream

Upstream Forge Agent drives a browser to an AI chat site and runs a task through
a single interactive CLI session. This fork adds multi-instance operation and a
web control surface, without changing the core single-task behaviour.

Six features, in the order they were built:

1. Unique, human-readable session names
2. Browser-based control UI  (this branch)
3. Sequential, named-context audio
4. Asynchronous (non-blocking) audio
5. Parallel tool groups
6. CLI to inspect running instances

Features 1, 3, 4, 5, 6 are already on main. Feature 2 lives on this branch.

---

## 1. Unique session names (feature 1 — on main)

PROBLEM: multiple instances defaulted to the same Chromium profile directory,
so two agents corrupted each other's cookies/logins. Names were also manual.

SOLUTION: a session-registry module that (a) generates unique human-readable
names and (b) gives each instance its own profile directory.

- Name format: adjective-animal-4hex, e.g. brave-otter-9f3a.
- Generated names are checked against existing session dirs, so no collisions.
- CLI: --session <name> (explicit), --session auto / --new-session (generated).
- Each instance's dir: ~/.deepseek-agent/sessions/<name>/ (override base with
  FORGE_HOME).

KEY FILE: src/session-registry.js
  - generateSessionName()   unique name
  - sessionDirFor(name)     profile dir for a name
  - writeHeartbeat/updateHeartbeat/removeHeartbeat
  - listInstances()/findInstance()/isPidAlive()
  - formatInstanceTable()

ENV VARS:
  FORGE_SESSION_NAME  set to the chosen name (used for audio labels + registry)
  FORGE_SESSION_DIR   the per-instance directory (profile + events + inbox)
  FORGE_HOME          base dir override (default ~/.deepseek-agent)

---

## 2. Browser-based control UI (feature 2 — THIS BRANCH)

PURPOSE: a single web page to visualize and drive every running instance,
replacing the need to juggle N terminal windows.

WHAT THE USER SEES (three panes):
  - LEFT:   live list of instances (name, role, PID, status dot, uptime).
            Click to focus; type in the filter box to narrow by name/role.
  - CENTER: a chat-style transcript for the selected instance. User input
            appears as "You"; tool calls, tool results, and the final answer
            appear as agent messages. Typing a task here queues it to that
            instance and automation proceeds automatically.
  - RIGHT:  a scrollable log/error stream, with an "errors only" toggle.
  Plus a "+ New Instance" button that spawns a fresh agent with a generated
  name (optional initial task, model, profile, role, headless mode).

ARCHITECTURE (why it is built this way):

  Instances are separate OS processes, so the dashboard cannot read their
  memory. Instead each instance APPENDS structured events to a file, and the
  server tails those files.

  Data flow:
    agent process
      -> appends a JSON line to <SESSION_DIR>/events.jsonl   (event-log.js)
    control server (one process)
      -> reads session-registry for the instance list
      -> tails each events.jsonl by byte offset
      -> pushes new events to browsers over Server-Sent Events (SSE)
    browser dashboard
      -> renders panes from the SSE stream
      -> posts user input to /api/input

  User input flow (the "automation kicks in" part):
    dashboard POST /api/input {id, message}
      -> server writes a line to <SESSION_DIR>/inbox.jsonl
      -> server also emits a ui_input event (so the UI echoes it)
    the agent's input handler reads inbox.jsonl and treats each line as a task.

  New instance flow:
    dashboard POST /api/spawn {...}
      -> server generates a session name and spawns a DETACHED child:
         node src/index.js --session <name> [--role .. --model .. --profile ..]
         [--no-interactive] [--headless] [<task>]
      -> child writes its heartbeat immediately (status "starting"),
         then updates to "running" after the browser launches.

KEY FILES:
  src/event-log.js          append/read structured events; rotates at 5MB;
                            disabled by FORGE_NO_EVENTS=1; never throws.
  src/control-server.js     zero-dependency HTTP + SSE server (Node built-ins
                            only). Routes below. Path-traversal guarded.
  src/control-server/public/index.html   dashboard markup
  src/control-server/public/style.css    dashboard styling
  src/control-server/public/app.js       dashboard logic (state, SSE, render)
  src/agent.js              emits events at: task, step, tool_call,
                            tool_result, error, final/status.
  src/index.js              --ui / --ui-port flags; early heartbeat write.

HTTP API:
  GET  /                     dashboard HTML
  GET  /style.css /app.js    static assets
  GET  /api/instances        { instances: [...] }
  GET  /api/events?id=&limit=  backfill events for one instance
  GET  /api/stream           SSE: {stream:'instances'|'event', ...}
  POST /api/spawn            { task, session, role, model, profile, headless }
  POST /api/input            { id, message }
  POST /api/stop             { id }

ENVIRONMENT VARIABLES:
  FORGE_NO_EVENTS=1   disable event logging (headless/CI)

HOW TO RUN:
  forge-agent --ui                 # http://127.0.0.1:7331
  forge-agent --ui --ui-port 8080
  node src/control-server.js --port 7331   # standalone

---

## 3. Audio — async + sequential + named (features 3 & 4 — on main)

PROBLEMS:
  - Speech/alarm blocked the agent loop (agent waited for TTS to finish).
  - Two instances speaking at once produced garbled, unattributable audio.

SOLUTION: a cross-process audio queue.
  - Tools ENQUEUE and return immediately (non-blocking).
  - A detached drainer process plays items ONE AT A TIME across all instances.
  - Every utterance is prefixed with the session name, e.g.
    [brave-otter] build finished — so you know which agent is reporting.
  - A cross-process lock ensures only one drainer plays; stale locks are stolen
    after 60s so a crash cannot wedge audio forever.

KEY FILE: src/audio-queue.js
  - speakAsync(text, opts)   enqueue + kick drainer + return status
  - alarmAsync(duration)     same for alarms
  - drain()                  play everything, sequentially, under the lock
  - Queue dir: ~/.deepseek-agent/audio-queue (files) + audio.lock

WIRED INTO: src/tools.js — call_user and raise_alarm now call the async
functions instead of the blocking speak()/raiseAlarm().

ENV VARS:
  FORGE_AUDIO_SYNC=1   block until playback completes (old behaviour)
  FORGE_NO_AUDIO=1     disable audio entirely
  FORGE_AUDIO_DIR      override queue directory
CLI: --audio-sync / --audio-async

---

## 4. Parallel tool groups (feature 5 — on main)

PROBLEM: the agent executed one tool call at a time, even when operations were
completely independent (e.g. write file A while reading file B).

SOLUTION: the model may emit SEVERAL tool calls in one turn. A dependency-aware
executor runs independent calls concurrently and serialises conflicting ones.

HOW DEPENDENCIES ARE DECIDED:
  - Each call is classified read vs write (permission-store).
  - Each call derives "conflict keys": resolved file paths, shell command
    strings, process names, env keys, clipboard.
  - Calls are grouped into ordered WAVES: a call joins the earliest wave where
    none of its keys are already claimed. Same key => later wave => serialised.
  - Within a wave, calls run concurrently with a BOUNDED concurrency cap.

CRITICAL SAFETY PROPERTY: two calls sharing a conflict key never run
simultaneously. Proven by randomized stress tests (100+ iterations).

DATA-MIXING SAFETY: results are labelled and returned to the model in the
SAME ORDER it requested them, so outputs can never be confused.

KEY FILES:
  src/parallel-executor.js   classifyEffect, conflictKeys, planWaves,
                             executeBatch, bounded-concurrency runner.
  src/parser.js              detects 1..N <tool_call> tags / code blocks /
                             {"tool_calls":[...]} and returns a tool_batch.
  src/agent.js               Case 0 batch handler + _runToolBatch.
  src/system-prompt.js       teaches the model the batch syntax + constraints.

CONFIG / CLI:
  PARALLEL_TOOL_CALLS (default true), MAX_PARALLEL_TOOL_CALLS (default 4)
  --parallel-tools / --no-parallel-tools / --max-parallel=<N>

MEASURED (simulated 100ms per call): 6 calls 676ms -> 227ms (2.97x);
24 calls 2665ms -> 671ms (3.97x). Benchmark: benchmarks/parallel-latency.bench.js

---

## 5. CLI to inspect running instances (feature 6 — on main)

PURPOSE: a single view of every instance without hunting through terminals.

  forge-agent ps            human-readable table
  forge-agent --instances   same
  forge-agent ps --json     machine-readable

  Columns: ID/name, role, PID, status, uptime, model, cwd.
  Dead instances are pruned automatically via a PID liveness check.

HOW IT WORKS: every instance writes a heartbeat file
  ~/.deepseek-agent/sessions/<name>/instance.json
  containing id, role, pid, cwd, model, status, startedAt, lastHeartbeat.
  ps scans these, checks each PID, and renders the table.

KEY FILE: src/session-registry.js (listInstances, formatInstanceTable).
The SAME registry feeds the control UI's instance list.

---

## 6. How everything fits together

  session-registry  <- identity + heartbeat (used by ps AND the UI)
        |
        v
  each instance ---writes---> <SESSION_DIR>/events.jsonl ---> control server
        |                        <SESSION_DIR>/inbox.jsonl  <--- dashboard input
        |
        +--- enqueues audio ---> ~/.deepseek-agent/audio-queue ---> drainer
        |
        +--- executes tools --> parallel-executor (waves, bounded concurrency)

Shared on-disk state under ~/.deepseek-agent/:
  sessions/<name>/instance.json   heartbeat (registry)
  sessions/<name>/events.jsonl    event log (UI)
  sessions/<name>/inbox.jsonl     UI -> agent input
  sessions/<name>/Default/        Chromium profile for that instance
  audio-queue/*.json + audio.lock audio queue

---

## 7. Running everything together

UI-first (recommended for many instances):
  forge-agent --ui
  # then click "+ New Instance" per agent (tick headless)

CLI-first (one terminal each):
  forge-agent --ui
  forge-agent --new-session --headless "task one"
  forge-agent --new-session --headless "task two"

All instances are parallel-enabled and async-audio-enabled by DEFAULT; no
extra flags needed. List them with: forge-agent ps

---

## 8. Testing

Run everything:            npm test
Per-feature suites:
  tests/parallel-tools.test.js         executor + parser batches (18)
  tests/parallel-integration.test.js   real agent loop + stress (6)
  tests/audio-queue.test.js            queue, lock, stale-steal (10)
  tests/session-registry.test.js       naming, heartbeats, liveness (13)
  tests/control-server.test.js         HTTP, event log, spawn/input (12)
Benchmark:                 node benchmarks/parallel-latency.bench.js
UI visual smoke test:      node scripts/ui-smoke.js <url> out.png
UI demo seeder:            node scripts/ui-seed.js

KNOWN PRE-EXISTING TEST FAILURES (environmental, NOT caused by this work):
  - package.json version 2.0.1 vs actual 2.0.2
  - global-config CACHE_ENABLED override
  - security message wording differs on this OS
  - Windows shell: no `pwd`, `$MY_VAR` not expanded
These 6 failures existed before any enhancement and are unrelated.

---

## 9. Important gotchas & decisions

1. Chromium cannot be fully removed. The agent scrapes the real model web UI,
   so a browser is always required. Run instances with --headless and use the
   dashboard for a clutter-free experience. This was a deliberate tradeoff.

2. The UI reuses the session-registry heartbeat. If an instance exits, its
   heartbeat is removed and it disappears from the UI. A spawned instance that
   fails browser init will therefore vanish — this is expected, not a bug.

3. Event logging is best-effort and never throws into the agent. If it fails,
   the task still runs; you just lose dashboard visibility.

4. Audio queue uses file-based items + an atomic lock (wx create). Stale locks
   (>60s) are stolen. This is robust across processes and crashes.

5. Parallel batching is opt-in BY THE MODEL. The infrastructure is proven, but
   whether the live model emits batches depends on it following the system
   prompt. Single calls always work as before.

6. concurrency cap bug (fixed): an early version ran a whole wave via
   Promise.all and ignored maxParallel. Fixed with a bounded worker pool and
   covered by regression tests. Do not reintroduce unbounded Promise.all.

---

## 10. Branching / git state (as of this document)

  main            -> origin/main @ 844a935 (features 1,3,4,5,6)
  feat/control-ui -> this branch; adds feature 2 (0eb2248) and this document.

Nothing has been merged to upstream (Omar-Azam/forge-agent). All work is on the
fork (puneet-swarup/forge-agent). To resume UI work: git checkout feat/control-ui

---

## 11. Where to look first when resuming

  - Want to change the dashboard look/behaviour?  src/control-server/public/
  - Want a new API route?                          src/control-server.js
  - Want more/different events in the UI?          src/agent.js (eventLog.emit)
  - Want to change instance listing/identity?      src/session-registry.js
  - Want to change tool batching?                  src/parallel-executor.js
  - Want to change audio ordering?                 src/audio-queue.js
