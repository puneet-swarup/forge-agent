# Forge Agent Enhancements

Six enhancements were added to this fork. All are backward compatible.

---

## 1. Unique, human-readable session names

Every instance can get a unique name automatically, with its own browser-profile
directory, so two instances never collide on the shared Chromium profile.

    forge-agent --session backend-work "refactor auth"   # explicit
    forge-agent --session auto "build a REST API"         # auto, e.g. brave-otter-9f3a
    forge-agent --new-session "build a REST API"          # alias

Names are <adjective>-<animal>-<4-hex> and never collide with an existing
session directory. Role defaults to the session name unless --role is given.

---

## 2. Browser-based control UI

A local dashboard to visualize and drive all running instances from one page.

    forge-agent --ui                 # default port 7331
    forge-agent --ui --ui-port 8080  # custom port
    node src/control-server.js --port 7331   # standalone

Open the printed URL (e.g. http://127.0.0.1:7331).

- Left pane: live list of every instance (name, role, PID, status, uptime).
  Click to focus; filter by name/role.
- Center pane: chat-style transcript for the selected instance. Input typed here
  is queued to that instance and automation proceeds automatically.
- Right pane: scrollable log/error stream with an "errors only" toggle.
- + New Instance: spawns a fresh instance (auto name, optional task/model/profile).

How it works:

- Each agent appends structured events to <SESSION_DIR>/events.jsonl.
- A zero-dependency HTTP server (Node built-ins only) serves the dashboard,
  lists instances, tails event logs, and streams updates via Server-Sent Events.
- Input is written to <SESSION_DIR>/inbox.jsonl and emitted as a ui_input event.
- New instances are spawned as detached child processes.

Note on Chromium: the agent drives the real model web UI, so the Chromium window
cannot be fully removed. Run with --headless and use the dashboard for a
clutter-free experience.

---

## 3 & 4. Async, sequential, named-context audio

call_user and raise_alarm no longer block the agent.

- Async: tools enqueue and return immediately; a detached drainer plays back.
- Sequential + named: a cross-process lock ensures one utterance plays at a time
  across all instances, each prefixed with its session name, e.g.
  [brave-otter] build finished.

    forge-agent --audio-async "..."   # default: non-blocking
    forge-agent --audio-sync  "..."   # block until playback completes
    FORGE_AUDIO_SYNC=1 forge-agent ...  # env equivalent
    FORGE_NO_AUDIO=1 forge-agent ...    # disable audio

Implementation: src/audio-queue.js.

---

## 5. Parallel tool groups

The model may emit several independent tool calls in one turn. The executor
classifies each as read/write, derives conflict keys (file paths, shell
commands, process names, env keys, clipboard), and runs independent calls
concurrently in ordered waves. Conflicting calls are auto-serialised.

    forge-agent --parallel-tools "..."      # default: on
    forge-agent --no-parallel-tools "..."   # force sequential
    forge-agent --max-parallel=4 "..."      # concurrency cap (default 4)

Results are labelled and returned in the same order requested, so outputs can
never be mixed up.

Measured latency (simulated 100 ms/call), run with
node benchmarks/parallel-latency.bench.js:

| batch | sequential | max=4 parallel | speed-up |
|------:|-----------:|---------------:|---------:|
| 6     | 676 ms     | 227 ms         | 2.97x    |
| 12    | 1308 ms    | 340 ms         | 3.84x    |
| 24    | 2665 ms    | 671 ms         | 3.97x    |

---

## 6. CLI to inspect running instances

    forge-agent ps            # human-readable table
    forge-agent --instances   # same
    forge-agent ps --json     # machine-readable

The table shows ID/name, role, PID, status, uptime, model and working directory.
Dead instances are pruned automatically via a PID liveness check.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| FORGE_SESSION_NAME | Set by --session; used for audio labels + registry |
| FORGE_SESSION_DIR | Per-instance profile + event/inbox directory |
| FORGE_HOME | Override base directory (default ~/.deepseek-agent) |
| FORGE_AUDIO_SYNC | 1 = blocking audio playback |
| FORGE_NO_AUDIO | 1 = disable all audio |
| FORGE_NO_EVENTS | 1 = disable control-UI event logging |

---

## Tests

| Suite | Covers |
|-------|--------|
| tests/parallel-tools.test.js | executor, parser batches, concurrency cap |
| tests/parallel-integration.test.js | real agent loop + randomized stress |
| tests/audio-queue.test.js | queue ordering, lock, stale-steal, disable |
| tests/session-registry.test.js | naming, heartbeats, liveness, table |
| tests/control-server.test.js | HTTP routes, event log, spawn/input API |

Run all: npm test
