# Changelog — Forge Agent

All notable changes documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [Unreleased]

### Changed
- **Documentation governance is enforced, not just described.**
  `docs/MARKDOWN_SCOPE.md` had drifted badly: it claimed 29 Markdown files and
  gave rows to nine that no longer exist (`AGENTS.md`, the four `.audio-backup/`
  reports, `SESSION_CONTEXT.md`, `SESSION_TASK.md`, `summary.md`, and
  `FORGE_PLAN.md` treated as a document) while omitting `docs/RELIABILITY.md`.
  It is re-audited against the tree — **21 tracked files**, one row each with its
  purpose and maintenance boundary — with the gitignored runtime artifacts
  (`FORGE_PLAN.md`, `FORGE_TODO.md`, `SESSION_CONTEXT.md`, `SESSION_TASK.md`,
  `summary.md`) listed separately, because rule 4 requires them to be identified
  rather than documented as policy. A sixth rule makes updating the inventory part
  of the commit that adds, moves or deletes a Markdown file.
- **The test-count policy is one policy.** `CONTRIBUTING.md` demanded "at least
  10 tests" for a new feature while its own tool section said 3 and
  `.github/PULL_REQUEST_TEMPLATE.md` said 5 for features and 3 for tools. The
  contributor guide now owns a single rule (feature 5, tool 3, template 2, bug
  fix a regression test) and the PR template mirrors it.

### Added
- `tests/markdown-scope.test.js` — the inventory cannot drift: a tracked `.md`
  with no row, a row with no file, a duplicated or absolute path, a wrong total,
  or a generated artifact in the tracked table all fail CI.

## [2.2.0] - 2026-11-21

**Reliability pass.** The theme of this release is one sentence: several
capabilities had been designed, documented, unit-tested and then never connected
to the code path that runs. Each one surfaced as a different-looking failure,
which is why the agent "broke in many ways" instead of one. This release closes
the loop between what the code declares and what the code does, and adds the
guarantees an autonomous agent needs before it can be pointed at a real
repository. See `docs/RELIABILITY.md` for the invariants and how to verify them.

### Fixed
- **The turn boundary is measured, not guessed** — completion was decided by
  "the text stopped changing for `STABLE_DELAY`". That cost 1.5–3 s on every
  turn, and if the new assistant bubble had not rendered yet the scraper
  returned the **previous reply** as the new one. `sendMessage()` now baselines
  the transcript (reply count + content hash) before typing, `waitForResponse()`
  waits for that transcript to change, and only then decides completion. A
  submit the UI silently drops now fails loudly with a retryable
  `turnBoundary: 'appear'` error instead of replaying the old answer.
  *Correction to 2.1.0: the changelog claimed the END marker "stops
  immediately"; `_hasEndMarker()` existed and was unit-tested but was never
  called. It is now on the hot path.*
- **One system prompt** — `src/prompt.js` and `src/system-prompt.js` each built
  a complete, different prompt. `agent.js` sent the first; the tests and
  `scripts/verify-prompt.js` validated the second, so the model was scored
  against a contract it had never been shown and the mandatory-artifacts
  protocol enforced by `scripts/lifecycle.js` was never stated to it. There is
  now one builder, it includes the envelope and the artifact protocol, and
  `scripts/verify-prompt.js` validates the message the agent actually builds.
- **Recovery no longer destroys the contract** — restarting a stalled chat used
  to send a three-line "you are a coding agent, continue" note into a chat with
  no system prompt, so the next reply was prose and the run aborted. Recovery
  now re-sends the full prompt plus the task, progress, `FORGE_PLAN.md` and the
  last three errors. The stall ladder is also reachable: it previously aborted
  before it could ever recover (see `docs/RELIABILITY.md` §3).
- **Secrets no longer leave the machine unredacted** — `security.sanitiseOutput()`
  was applied only to the saved history file. Tool output is now passed through
  `security.redactSecrets()` before it is sent to the chat UI: PEM blocks,
  `sk-`/`AKIA`/`ghp_`/`xoxb-`/`AIza`/`sk_live_` tokens, JWTs, credential
  assignments and secret `.env` lines. Deliberately narrow, so ordinary source
  code, hashes and lockfile integrity strings are untouched.
- **Writes are atomic, reversible and guarded** — `write_file` called
  `fs.writeFileSync` on the target: a crash truncated the file, an unread
  overwrite destroyed content silently, and nothing could be undone. All
  mutating file operations now go through `src/workspace.js`: temp-file +
  fsync + rename, a per-session snapshot of the pre-image, a read-before-write
  guard keyed on a content hash (so a change made by `run_command` invalidates
  an earlier read), and a unified diff in the result.
- **Budgets are enforced** — the loop's only breaker was a literal
  `if (step > 10000)`. `MAX_ITERATIONS` was read for display and never
  consulted, and `--max-iterations` was in the help text and never parsed.
  `src/budget.js` now enforces steps, wall clock and tool calls, and exceeding
  one produces a partial summary instead of a runaway process.
- **Prose is not a program** — the parser accepted the first JSON object with a
  `name`/`tool` key anywhere in the reply, so `{"name": "my-app"}` in a
  package.json explanation became a tool call and a fenced *example* of a
  `run_command` call executed for real. Fenced data-language blocks are now
  illustrations, bare JSON with an unknown name is prose, and an unknown tool
  name returns `invalid_tool` with a nearest-name suggestion instead of dumping
  all 45 tool names into the context.
- **Session context is real** — `_sessionCtxStart()` was called twice and
  defined nowhere, `_sessionCtxUpdate()` was declared twice, `create()` was
  never called and nothing ever read the file back. It is now created at task
  start (with the task attached — the agent is built before the task is known)
  and injected into the restart message, which is what makes it worth writing.
- **No endpoint is guessed for the user** — the `colab` adapter shipped a
  personal ngrok tunnel as its default URL. It now has no default and
  `getModelUrl()` fails with an actionable message naming `--model-url`.

### Added
- **Routine context rotation** — the model's real context window belongs to the
  remote chat, not to this process: `ConversationManager.compress()` rewrote a
  local log that was never re-sent, so the remote context grew until the provider
  truncated it silently and the model lost the tool contract. Every
  `CONTEXT_ROTATION_TURNS` (default 25) assistant turns the agent now starts a
  fresh chat on its own terms and re-sends the contract plus a state digest
  (task, progress, plan, session notes, recent errors) through the same
  `_rotateChat()` path used by stall recovery. The local log is trimmed to the
  resume message, so it no longer grows across rotations. `0` disables it.
- **Shell policy with three verdicts** — the guard was six literal substrings
  matched with `String.includes()`, which `rm -rf $HOME`, `git reset --hard`,
  `find . -delete` and `curl … | sh` all walked past. `src/shell-policy.js`
  classifies a command as **allow** (an allowlisted development binary: no
  prompt), **confirm** (unrecognised, or known-destructive such as
  `git push` / `git reset --hard` / `rm -rf`: the user is asked) or **deny**
  (irreversible: root deletes, `mkfs`, `dd` to a device, fork bombs, piping a
  download into a shell, force-push to `main`). Deny is binding; allow skips the
  permission prompt so it is not worn down by `npm test`; `SHELL_POLICY` accepts
  `standard`, `strict` (unknown binaries denied) or `off`.
- **Scrubbed child environment** — `run_command` no longer inherits
  `process.env`. The child gets `PATH` and the OS basics, and anything whose name
  looks like a credential (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH`, …)
  is dropped even when explicitly requested, so a model cannot read a token back
  out through `echo $VAR`. `SHELL_ENV_SCRUB=false` restores the old behaviour.
- **Verification gate before `TASK_COMPLETE`** — the agent used to decide it was
  finished. `src/verify.js` now detects the project's own cheapest check
  (`package.json` script, `Makefile` target, `pytest`, `cargo test`, `go test`)
  and runs it before completion is accepted; a failure is fed back and the loop
  continues, bounded by `MAX_VERIFICATION_ATTEMPTS`. Nothing is invented — only
  commands the project declares. With no declared check the run is reported as
  **unverified** in the summary rather than claiming success. Config:
  `VERIFY_BEFORE_COMPLETE`, `VERIFY_TIMEOUT_MS`, `MAX_VERIFICATION_ATTEMPTS`.
- **Integrity-checked argument transport** — `src/transport.js` gains
  `encodeTransportArg` / `decodeTransportArg` with base64 **or** hex encoding
  and an MD5 check over the decoded bytes. `write_file`, `append_to_file`,
  `write_files` and `replace_in_file` accept `content_md5` (and
  `find_md5` / `replace_md5`); a mismatch throws before anything is written, so
  a payload mangled by the scraper can no longer truncate a file silently. The
  hash is optional — without it the previous base64 round-trip check still
  applies — and the honest limitation is documented in `docs/RELIABILITY.md`
  §10: the sender must compute the digest, which is reliable for small payloads
  and not for large ones.
- `src/workspace.js` — atomic writes, snapshots, read-before-write, diffs.
- `src/budget.js` — per-run resource envelope (`Budget`, `BudgetExceeded`).
- `--rollback <path>` and `--snapshots` — restore a file from its snapshot, or
  list what can be restored (snapshot paths are deterministic, so a later
  process can find them).
- `--max-iterations`, `--max-runtime` (`90`, `30s`, `2h`) and
  `--max-tool-calls` — now parsed, applied and documented in `--help`.
- `MAX_ITERATIONS`, `MAX_RUNTIME_MS`, `MAX_TOOL_CALLS`,
  `MAX_CHAT_RECOVERIES` and `REQUIRE_READ_BEFORE_WRITE` config keys.
- `ProgressTracker.recentErrors(n)` and `ConversationManager.buildResumeMessage()`
  so recovery and any future context rotation share one wording.
- `docs/RELIABILITY.md` — the invariants, where each is enforced, and how to
  test it.
- `tests/cli-docs-sync.test.js` — runs the real `--help` and fails if a parsed
  flag is undocumented (this immediately found 11: `--audit-log`,
  `--clear-memory`, `--continue`, `--history-clear`, `--no-cache`,
  `--no-interactive`, `--remove-template`, `--security`, `--strict-sandbox`,
  `--task`, `--verbose`). They are now documented.

### Changed
- **Rate limiting is reactive, not a fixed tax.** The agent slept a random
  10–20 s before *every* prompt ("anti-block"), which is 10–20 minutes of dead
  time on a 60-step task and does nothing when a provider actually throttles.
  The fixed pause is now **off by default** (`--prompt-pause` restores it) and
  `src/throttle.js` backs off 5 s → 10 → 20 → 40 s (capped at 60 s) only when
  the reply carries a throttle signal — "too many requests", "rate limit
  exceeded", usage-limit notices, the Chinese equivalents — with a bounded
  attempt count and a partial summary if the provider never relents. Detection
  is two-tier so an agent *writing about* rate limiting does not back off on
  its own answer.
- The system prompt is ~12 k characters (~3 k tokens), down from ~22.5 k, while
  gaining the response envelope and the artifact protocol. Tool documentation is
  now **generated** from the tool registry, so a tool cannot be added without
  appearing in the prompt (seven were previously undocumented), and each entry
  is one signature plus one clause.
- The base64-for-code instruction is gone. It inflated payloads by a third,
  models produce long base64 unreliably, and it moved a scraping bug into the
  prompt. `is_base64` remains, for genuinely binary content only.
- `write_file` now reports `Updated` (rather than `Wrote`) when it overwrites,
  and returns a diff. `delete_file` mentions the snapshot it kept.

### Tests
- 2,084 tests across 116 suites, all green (`npm test`). New suites:
  `turn-boundary`, `adapter-turn-contract`, `prompt-single-source`, `recovery`,
  `secret-redaction`, `workspace`, `budget`, `protocol-validation`,
  `session-context-wiring`, `adapter-factory-urls`, `cli-docs-sync`,
  `throttle`, `transport-integrity`.
- Removed the public-internet dependency from the `read_url` unit test and the
  startup race from the `kill-escalation` test (both were failing or flaky in
  sandboxed CI).

---

## [2.1.0] - 2026-11-12

### Changed
- **Step lines now show a wall-clock timestamp** - every displayed step line is prefixed with `[HH:MM:SS]` local time (e.g. `[14:32:07] Step 3 — writing src/app.js`), so the user can see exactly when the last action was taken. Rendered centrally in `TUI.renderStepLine` (new exported `formatClock` helper in `src/tui.js`), so it applies to every mode. Tests in `tests/tui.test.js`.
- **Refreshed test/suite counts in README** - the badge and Key Stats now reflect the actual current baseline (1774 tests across 90 suites, up from the stale 1758/88). Removed the completed `PENDING_WORK.md` backlog (all items were checked off; durable notes now live in CHANGELOG + git history).

### Added
- **Parent/child spawn protocol (Supervisor Mode)** — normative contract in `docs/SPAWN_PROTOCOL.md`. `spawn_agent` launches a child in its **own terminal window** (win32 `cmd /c start`, macOS `osascript`, Linux terminal emulator; headless fallback) with its own session/profile and a unique identifier `forge-<session>-<pid>`. New modules `src/spawn-window.js` (cross-platform new-window launcher), `src/spawn-task.js` (per-instance `SESSION_TASK.md`), `src/heartbeat.js` (interval/TTL self-heartbeat). Each child gets its **own** task file inside its session dir — multiple children in the same cwd never collide. `list_agents` now shows parent-child relationship, liveness (running/unresponsive/dead) and heartbeat age (text + `json` tree). New `read_agent_task` tool reads a child's checked-off subtasks and progress log. `kill_agent` does graceful→force (awaited `taskkill` on win32) by id/session/prefix/PID with a safety guard; `cleanupChild`/`pruneOrphans` remove dead children's artifacts (task file + session dir + heartbeat). New `Agents (parallel instances)` system-prompt category. Docs: `docs/SPAWN_PROTOCOL.md` §10 worked parallel example; tests `spawn-window`, `spawn-task`, `spawn-protocol`, `spawn-isolation-cleanup`, `heartbeat`, `tools-spawn`, `kill-escalation`, `integration-spawn-window`.
- **Dedicated Colab adapter** (`--model=colab`, aliases `tunnel`/`ngrok`/`remote-ollama`) — a remote Colab/ngrok OpenAI-compatible endpoint adapter that extends the local proxy but hard-requires a remote URL (warns instead of silently hitting localhost), adds the `ngrok-skip-browser-warning` header, bearer auth, and a non-throwing `probe()`. `src/adapters/colab-adapter.js`; `tests/colab-adapter.test.js`, `tests/colab-adapter-config.test.js`.
- **Self-hosted adapter taxonomy clarified** — `ollama` now unambiguously resolves to the true local daemon (`ollama-adapter`); `local`/`local-chat` remain the generic proxy; `colab` is the remote tunnel. Fixed the pre-existing alias collision where `ollama` mapped to the proxy. `OLLAMA_BASE_URL`/`OLLAMA_API_KEY`/`OLLAMA_MODEL`/`LOCAL_CHAT_PORT` are now first-class config keys settable via `--model-url`/`--api-key`/`--local-model`/`--local-port`, env vars, or a gitignored `.env` (zero-dependency loader in `src/config.js`). New `docs/LOCAL_AND_COLAB_ADAPTERS.md`.
- **Anti-block prompt pause (default ON)** - a random 10-20s pause is now inserted between consecutive prompts so the model UI does not flag the session as automation. Configurable via `PROMPT_PAUSE` / `PROMPT_PAUSE_MIN_MS` / `PROMPT_PAUSE_MAX_MS`; disable with `--no-prompt-pause`. The first prompt of a run is never delayed. `src/browser.js::_promptPause`; `tests/prompt-pause.test.js`.
- **`last-raw-response.txt` is now actually written** - the `--debug` path persists the full pre-parse model response to `~/.forge-agent/logs/last-raw-response.txt` (the README/CHANGELOG already told users to inspect it; now it exists). `src/raw-log.js`; `tests/raw-response-log.test.js`.
- **FORGE_PLAN lifecycle documented** - README now describes the create/tick/delete baby-step plan protocol and the `scripts/plan.js` tooling.
- **Opted parser.js, retry.js, session-registry.js into @ts-check** - incremental type coverage extended to 3 more modules (following paths/run-summary/doctor). tsc immediately surfaced an optional-props JSDoc gap in listInstances(); fixed. No runtime change.
- **ps shows each agent LAST summary status** - listInstances() now reads the sibling summary.json for each instance (read-only, best-effort) and formatInstanceTable() renders a LAST column (green=completed, yellow=other terminal status, dim dash when no summary yet). Never throws on missing/malformed summaries.
- **Clarified SPONSOR_TIERS wording** - src/sponsor.js now documents that the tier table is suggested support guidance, not verified Ko-fi/GitHub Sponsors products.
- **Display-only streaming hook (onChunk)** - BaseAdapter.waitForResponse now accepts an onChunk callback wired through _waitForTextStable. Fires once per net growth, monotonic delta, isolated in try/catch, never triggers execution or early completion. Guard: tests/streaming-display.test.js.
- **Base64 transport regression guard** - tests/base64-transport.test.js locks the is_base64 contract for write_file, append_to_file, replace_in_file, write_files.

- **Parallel TODO pool (`--parallel`)** — `src/worker-pool.js` runs open FORGE_TODO.md items across up to `--max-parallel` child agents at once (each its own session/profile), ticking each success. The biggest throughput win for independent work. New `--parallel` flag + help entry; unit + real-process integration tests.
- **`forge-agent --doctor`** - one-command health check (Node version, Chromium install, config validity, data-dir writability, browser-profile presence) with PASS/WARN/FAIL output and hints; exits non-zero on failure for CI use. Module `src/doctor.js`; tests in `tests/doctor.test.js`.
- **`forge-agent --summary [session]`** - surface durable run summaries: list all sessions or print one session's full summary. Backed by `readSummary`/`listSummaries` in `src/run-summary.js`.
- **Reliable `ps` for custom session dirs** - heartbeats now write to a canonical `~/.deepseek-agent/instances/<name>.json` (independent of `--session-dir`) and a `starting` heartbeat is written before the browser launches, so `ps` shows agents that use a custom profile dir and agents still booting/login-blocked. `listInstances` scans the canonical dir (plus legacy session dirs, deduped). Tests added.
- **Descriptive step lines** - the agent's per-step TUI line now carries a short one-liner saying what the step is doing (e.g. `Step 3 — writing src/app.js`), derived from the most recent tool call (`ProgressTracker.lastTool`). This is the default protocol, not an option: `renderStepLine` accepts a descriptor and the agent loop always supplies one. Tests cover `lastTool` tracking.
- **Durable per-run summaries** - `src/run-summary.js` writes a structured, attributable summary of every terminal run (completed/failed/timeout) to `~/.deepseek-agent/sessions/<session>/summary.md` and `summary.json` (session, role, task, status, duration, steps, files written, commands run, errors, final output). A concise summary is also printed at completion. Crucial when multiple agents are spawned: you can always tell which agent did what. The system prompt now also asks the model to write a brief summary before TASK_COMPLETE. Unit tests cover normalisation, markdown rendering, and file writing.
- **Response-envelope protocol (deterministic completion)** — the system prompt now instructs the model to wrap every reply in `<<<FORGE_START>>>` … `<<<FORGE_END>>>` markers. When the adapter sees the END marker it stops immediately instead of waiting for a DOM-quiet window; if the model ignores the markers, every code path falls back to the existing DOM-quiet + `_isGenerating()` logic, so reliability is never reduced — only speed improves when the contract is honoured. Markers are stripped from the final text. `_hasEndMarker` requires END to appear AFTER START, so a stray END in prose/code or an END-without-START cannot falsely complete. New tests cover marker-stripping, the no-marker fallback, the mid-stream pause with markers, sloppy markers (prose/whitespace around them), and a pure unit matrix (`tests/protocol-markers.test.js`). When `DEBUG` is on, the raw scraped text (pre-strip) is saved to `~/.deepseek-agent/logs/last-raw-response.txt` so real-world protocol compliance can be inspected without another live login.
- **Tuned delays + real navigation readiness** — `SEND_DELAY` 600ms → 250ms (safe lower bound; `waitForResponse` owns appearance detection); `browser.js::_navigate` no longer sleeps a blind 3s — it waits for the chat input selector (falling back to `NAV_SETTLE_MS`). All timing is config/env overridable, so tuning is revertible via config, not a code revert. `STABLE_DELAY` left at its safe default to avoid re-opening the truncation bug.

### Fixed
- **Cleaner per-step output; no duplicate answer** - `renderToolResult` now shows only the outcome (✓/✗ + result text) and no longer repeats the tool name already shown on the `⚡` action line; the final answer was printed twice (raw `content` AND `formatted`) and is now shown exactly once via `logger.answer()` followed by the completion box. `src/tui.js`, `src/agent.js`; regression tests in `tests/tui.test.js`.
- **Sponsor links point only to maintainer-owned pages** - Ko-fi corrected to `ko-fi.com/puneetswarup`; placeholder destinations (forgeagent Ko-fi, Buy Me a Coffee, Open Collective, forge-agent.dev) removed or redirected to GitHub Sponsors / the real Ko-fi across `sponsor.js`, README, SUPPORTERS.md, `.github/FUNDING.yml`, and `docs/sponsor.html`. Prevents donations from going to an unowned handle. New tests assert the real URL and absence of placeholders.
- **Model-agnostic home directory + migration** - all Forge state now lives under `~/.forge-agent` (was model-specific `~/.deepseek-agent`), since the agent drives multiple models and a session can resume on a different model. New `src/paths.js` is the single source of truth (`forgeHome`/`forgePath`/`resolveExisting`), honouring `FORGE_HOME`. A one-time non-destructive migration copies legacy data to the new location on first run, and `resolveExisting` still reads legacy files until migration completes, so no data is orphaned. ~35 hardcoded refs replaced. Tests in `tests/paths.test.js`.
- **Incremental type-checking (JSDoc + `@ts-check`)** - added `tsconfig.json`, `typescript` + `@types/node` as devDependencies, and an `npm run typecheck` script (also runs in CI). No runtime change: shipped code remains plain JavaScript. High-value modules (`paths.js`, `run-summary.js`, `doctor.js`) opt in via `// @ts-check` with JSDoc; tsc immediately caught a latent `Date - Date` sort bug in `listSummaries` (fixed to compare `.getTime()`). More modules can opt in over time.
- **Scraper printed UI chrome / duplicated or truncated replies** — the fast MutationObserver path (`80e96df`) could resolve on the first quiet window, which occurs mid-stream during DeepSeek's reasoning pause, returning half the reply; and `_extractLastMessage` walked the whole assistant bubble, leaking the Copy/Download action toolbar and the hidden raw-copy node (printing the response twice). Fixes: (1) `getFullText` now skips buttons/icons/svg/inputs, `aria-hidden`/`display:none`/`visibility:hidden` nodes, and any node whose class/aria-label/testid matches action-chrome words (copy, download, regenerate, share, ...); (2) completion now requires the text to be unchanged across a full quiet window (`after === text`) AND `_isGenerating()` to be false, so a mid-stream pause is waited out; (3) the quiet-window cap was raised from 250ms to `max(STABLE_DELAY*4, 1500ms)` so it can actually observe a full stable window. Mock chat server now emits a real action toolbar, a hidden raw copy, and a stop-generating indicator, with two new regression tests (`chrome test`, `PAUSE_TEST`) covering chrome leakage, duplicate output, and half-response.
- **Cross-platform path security + nested test-runner** — `validatePath` now normalises both the input and the `BLOCKED_PATHS` entries before comparing, so Unix sensitive paths (e.g. `/etc/passwd`) are blocked on Windows too (previously `path.resolve('/etc/passwd')` → `D:\\etc\\passwd` slipped past the literal comparison). `test-runner.js` now prefers the project-local `node_modules/.bin` binary over `npx`, so `runTests` no longer returns 0 tests in environments where `npx` isn't on PATH. Both previously-failing suites (`security.test.js`, `test-runner.test.js`) are green; full suite is now 1609/1609.

### Performance
- **Faster browser loop** — the adapter now installs a `MutationObserver` on the page and resolves `waitForResponse` the instant the DOM goes quiet, instead of polling every 800ms. The send path is event-driven too (no fixed 200/100/500ms sleeps; submits immediately and waits for the message to appear). Fallback to the old stability loop if the observer can't be installed. Measured ~4x faster on the mock-chat integration suite (28s -> 6.5s).

### Changed
- **Rebranded to this fork** - package name is now @puneet-swarup/forge-agent; repo, docs, Docker, and sponsor links point to puneet-swarup; a fork-attribution note credits the original Omar-Azam/forge-agent (MIT). Historical entries below are unchanged.

### Added
- **Named sessions & instance registry** — `--session <name>` (own Chromium profile), `--session auto`/`--new-session`, `--session-dir <path>`, `--role`, and `ps`/`--instances`.
- **Session context (Phase 1)** — `src/session-context.js` writes a durable, gitignored `SESSION_CONTEXT.md` (goal/decisions/progress/git-state) that survives context compaction. Auto-created at session start, updated after tool batches, removed at session end. `/context` slash command; `/clear` re-seeds from it. Config: `SESSION_CONTEXT_GITIGNORE`.
- **TODO detection & auto-run (Phase 2/3)** — startup detection of `FORGE_TODO.md` / `SESSION_CONTEXT.md` with a resume prompt; `-a`/`--auto` runs open `FORGE_TODO.md` items unattended (TODO-only), ticking each done on success; `--resume-work`/`--continue`.
- **Multi-agent supervisor (Phase 4)** — `src/agent-supervisor.js` plus `spawn_agent`, `list_agents`, `kill_agent` tools. Children run with their own session/profile and share files, never the browser.
- **`--auto` loop + `/todo` command** — `--auto` now loops through all open `FORGE_TODO.md` items in one run; new `/todo` slash command (list/add/done/clear-done).

### Fixed
- **Audio announcements arriving late / out of order** — the async audio drainer used a one-shot-per-process latch, so after the first drainer exited (queue momentarily empty), later cues were never played until some other process happened to drain. Now a drainer is kicked on **every** enqueue (the cross-process lock makes redundant spawns harmless no-ops), and a drainer lingers briefly (`FORGE_AUDIO_LINGER_MS`, default 800ms) to stay hot across a turn. Regression tests added.
- Repaired 6 long-standing test failures: version assertion (now semver-based), `CACHE_ENABLED` default (checks `DEFAULTS`), two security reason-wording assertions, and two Windows-incompatible shell tests (`pwd`, `$VAR`).

### Testing
- **Browser E2E integration tests** — `tests/integration-browser.test.js` drives a REAL headless Chromium against a LOCAL mock chat page (`tests/helpers/mock-chat-server.js`): verifies the adapter's send → scrape loop and that a fenced `tool_call` survives scraping and parses. No login/network needed; auto-skips without Chromium.
- **Supervisor E2E** — `tests/integration-supervisor.test.js` spawns a real child process, verifies its session dir/heartbeat, and kills it.
- **Auto-loop E2E** — `tests/integration-auto-loop.test.js` verifies `--auto` runs every open item, ticks them, and halts on the first failure.
- **CI** — new `integration` job installs Chromium and runs the E2E suites; syntax-check list extended to the new modules. Full suite now 1594 passing, 0 failing.
- **Cross-platform audio tools** — src/audio.js: platform-agnostic `call_user` (text-to-speech) and `raise_alarm` (audible alert) tools. Auto-selects the best backend per OS — SAPI/PowerShell (Windows), `say`/`afplay` (macOS), `spd-say`/`espeak-ng`/`espeak`/`paplay`/`aplay`/`canberra-gtk-play` (Linux) — with a universal terminal-bell fallback. Honours `FORGE_NO_AUDIO` for CI/headless hosts. Documented in README and docs/tools.html, with dedicated unit tests.

---

## [2.0.0] — 50-Day Journey Complete

### Phase 5: Community, Scale & Launch (Days 41–50)

#### Changed
- CLI command renamed from `forge` to `forge-agent`
- npm package renamed to `@omar-azam/forge-agent`
- **Backward compatibility**: `fa` alias kept; existing `deepseek-agent.config.json` still supported.

#### Added
- **Documentation site** — 13-page static HTML docs site at docs/
  including getting started, CLI reference, all tools, profiles,
  templates, plugins, configuration, security, Docker, benchmarks,
  sponsor page, and blog (Day 41)
- **Example projects gallery** — 10 curated project blueprints with
  full task prompts: Express API, React Todo, Python CLI, Next.js blog,
  Docker stack, data analysis, GitHub Actions CI, FastAPI, Vue dashboard,
  terminal game. `forge-agent --examples` (Day 42)
- **Benchmark suite** — 5-category performance measurement system:
  parser, tools, search, truncation, memory. `forge-agent --benchmark` (Day 43)
- **Community health files** — CONTRIBUTING.md, CODE_OF_CONDUCT.md,
  SECURITY.md, ROADMAP.md, SUPPORTERS.md, structured GitHub issue
  templates (bug, feature, plugin sharing), PR template (Day 44)
- **Security audit** — src/security.js: path traversal hardening,
  null byte injection prevention, additional blocked paths (~/.npmrc,
  ~/.netrc, ~/.git-credentials, ~/.docker/config.json), command
  injection protection, secret sanitisation for history, parameter
  validation for all tool calls, audit logging system (Day 45)
- **Docker support** — multi-stage Dockerfile, docker-compose.yml,
  docker-compose.dev.yml, Makefile with convenience commands,
  GitHub Actions docker.yml for auto-publishing to GitHub Container
  Registry, src/docker.js for container detection (Day 46)
- **Sponsorship infrastructure** — src/sponsor.js: 5 funding tiers,
  non-intrusive usage nudge (max once per 7 days, 20% probability,
  disabled in CI), .github/FUNDING.yml, SUPPORTERS.md,
  docs/sponsor.html (Day 47)
- **Launch assets** — src/launch-assets.js: Product Hunt tagline/description,
  Hacker News Show HN post, 7-tweet Twitter thread, LinkedIn post,
  dev.to article, `forge-agent --launch-assets` (Day 48)
- **Blog** — docs/blog/ with launch announcement and 2026 roadmap
  posts, blog index page (Day 48)
- **Final audit** — comprehensive 32-check audit of all source files,
  tests, docs, community files, Docker files. All rough edges fixed.
  Startup time optimised to under 2 seconds (Day 49)

---

## [1.4.0] — Phase 4: UX & Developer Experience (Days 31–40)

#### Added
- **Terminal UI overhaul** — src/tui.js: structured step timeline,
  tool call display with ⚡/✓/✗ icons, completion footer, --no-tui
  and --compact flags (Day 31)
- **Task history** — src/history.js: persistent JSONL log of every
  task, --history, --history=N, --history-stats, --history-search,
  --history-clear (Day 32)
- **Config wizard** — src/wizard.js: interactive 10-step guided setup,
  forge-agent --setup (Day 33)
- **Watch mode** — src/watcher.js: FileWatcher class, WatchSession,
  --watch, --watch-pattern, --watch-debounce, --watch-max,
  --watch-cooldown (Day 34)
- **Task templates** — src/templates.js: 10 built-in templates
  (add-typescript, add-jest, add-docker, add-github-actions, add-eslint,
  add-env-setup, write-readme, add-auth, fix-tests, code-review),
  --template, --list-templates, --save-template, --remove-template (Day 35)
- **Output formatting** — src/formatter.js: text, markdown, json,
  json-raw, minimal, silent formats, --format, --output, --timestamp (Day 36)
- **Shell completions** — src/completions.js: bash, zsh, fish scripts,
  --completion-bash/zsh/fish/install (Day 37)
- **Session resume** — src/session-resume.js: --resume, --resume=last,
  --resume=<id>, --rerun, interactive history picker with numbered
  selection, context injection for continued tasks (Day 38)
- **Help system** — src/help-topics.js, src/manpage.js: 9 topic guides,
  --help=<topic>, --cheatsheet, --man, --man-install (Day 39)

#### Changed
- Version bumped to 1.4.0
- CLI flags: 40+ across all features
- Test count: 1000+ passing

---

## [1.3.0] — Phase 3: Intelligence Upgrades (Days 21–30)

#### Added
- **Task planning** — src/planner.js: buildPlanPrompt, parsePlan,
  --plan flag shows numbered execution plan (Day 21)
- **Context compression** — src/compressor.js: auto-compress long
  conversations at configurable token threshold (Day 22)
- **Multi-model support** — src/adapters/ directory: BaseAdapter,
  DeepSeekAdapter, ChatGPTAdapter, GeminiAdapter, AdapterFactory,
  --model=deepseek/chatgpt/gemini (Day 23)
- **R1 thinking mode** — src/thinking.js: ThinkingTracker, strip/extract
  thinking blocks, --think flag (Day 24)
- **Persistent memory** — src/memory.js: MemoryStore, project-level
  knowledge persistence across sessions, tech stack detection,
  --no-memory flag (Day 25)
- **Custom plugins** — src/plugin-loader.js: drop .js files into
  ~/.deepseek-agent/tools/, --list-plugins, --new-plugin (Day 26)
- **Tool caching** — src/tool-cache.js: LRU in-session cache, read-only
  tool caching, write-invalidation, --no-cache flag (Day 27)
- **Smart truncation** — src/truncator.js: detectContentType, strategy
  per content type (code/test/file-list/git/json/generic) (Day 28)
- **Agent profiles** — src/profiles.js: default, backend, frontend,
  data-science, devops. --profile flag, --list-profiles (Day 29)
- **Visual rename** — all user-visible output and docs show Forge Agent,
  forge/fa CLI commands (Day 30)

#### Changed
- Version bumped to 1.3.0

---

## [1.2.0] — Phase 2: Developer Tools (Days 11–20)

#### Added
- **Git tools (6)** — git_status, git_log, git_diff, git_branches,
  git_show, git_blame (Day 11)
- **Semantic search** — src/searcher.js: LCS symbol extraction, fuzzy
  matching, relevance scoring, search_codebase tool (Day 12)
- **Test runner** — src/test-runner.js: auto-detect Jest/Vitest/Mocha/
  pytest/Go/Cargo, spawnSync for stderr capture, run_tests tool (Day 13)
- **Package installer** — src/package-manager.js: npm/yarn/pnpm/pip/
  cargo/go, skip-if-installed, batch install, install_package tool (Day 14)
- **Diff/patch engine** — src/differ.js: LCS-based unified diff
  generation, patch application, diff_files and patch_file tools (Day 15)
- **Env tools (5)** — src/env-manager.js: read_env, set_env_var,
  delete_env_var, list_env_files, check_env_vars — secret masking (Day 16)
- **Process manager (4)** — src/process-manager.js: start_process,
  stop_process, list_processes, read_process_logs (Day 17)
- **Screenshot tool** — src/screenshot.js: take_screenshot (Day 18)
- **Clipboard tools** — src/clipboard.js: read_clipboard,
  write_clipboard (Day 19)

#### Changed
- Version bumped to 1.2.0
- Total tools: 35+ (up from 15)

---

## [1.1.0] — Phase 1: Foundation & Stability (Days 1–10)

#### Added
- **Test suite** — Jest setup, 49 tool tests, 40 parser tests,
  37 browser unit tests, live selector health check (Days 1–3)
- **CI/CD** — GitHub Actions: ci.yml (Node 18/20/22 matrix),
  release.yml (auto-publish on tag), stale.yml (Day 4)
- **Windows compatibility** — replaced Unix find/grep with pure
  Node.js: list_directory, find_files, search_in_files, globToRegex (Day 5)
- **Structured errors** — src/errors.js: AgentError with what/why/how,
  20 named factories, classifyFsError, classifyCommandError (Day 6)
- **Retry system** — src/retry.js: withBrowserRetry, withSendRetry,
  withResponseRetry, withNetworkRetry, exponential backoff (Day 7)
- **Session health** — src/health.js: 6-check startup validation,
  auto-reauth on expired session (Day 8)
- **Progress tracking** — src/progress.js: ProgressTracker, partial
  result summary on timeout (Day 9)
- **Path sandbox** — assertSafePath(), STRICT_SANDBOX mode, fix
  auto new-chat bug (Day 10)

#### Changed
- Version bumped to 1.1.0

---

## [1.0.0] — Initial Release

### Added
- Core browser automation engine via Playwright
- 15 built-in tools: read_file, write_file, append_to_file,
  replace_in_file, delete_file, move_file, copy_file, get_file_info,
  list_directory, create_directory, write_files, search_in_files,
  find_files, run_command, read_url
- Interactive REPL mode (--interactive / -i)
- Single-task CLI mode
- Persistent browser session (login once, runs forever)
- 6-strategy response parser
- Auto-recovery when AI mixes prose with tool calls
- DOM tree walker for response extraction
- forge-agent --calibrate for selector auto-detection
- forge-agent --debug for raw AI response inspection
- forge-agent --headless for invisible browser operation
- forge-agent --save-log for conversation persistence
- forge-agent --dir for working directory control
- Global config: ~/.deepseek-agent/config.json
- Project config: forge-agent.config.json
- ANSI terminal output with step-by-step progress
- npm package: @omar-azam/forge-agent
- CLI: forge-agent and fa
