# FORGE_PLAN - active task plan

> Protocol: each step is a checkbox. A step is only ticked after its gate
> (syntax check + relevant tests, including edge cases) has passed. On session
> reset, resume at the first unticked item. Deleted when the user signs off.
> Baseline (must stay green): `node scripts/run-jest.js` full suite + `node
> scripts/check-syntax.js --all`. One item per commit.

## Accepted improvement tiers (from ARCHITECTURE.md s.15)

ALREADY DONE (committed 104e4bd): step-line summariser (Tier1 #1),
`supportsUpload()`/`uploadFile()` (Tier3 #10, DeepSeek+Gemini), `read_file`
upload path (Tier3 #11), plus tooling fixes (search-on-file, inconclusive test
reporting).

REMAINING, in recommended execution order (low risk + high value first):

- Phase P1 - Tier 1 remaining (safe, high-value)
- Phase P2 - Agent-loop correctness (ARCHITECTURE.md s.10)
- Phase P3 - Tier 2 (config-gated, medium)
- Phase P4 - Tier 3 streaming (default-off)

---

## Phase P1 - Tier 1 remaining (safe, high-value)

### P1.1 Segment-scoped globToRegex (XS, fixes a latent bug)
- [ ] P1.1a Replace `.*` -> `[^/\\]*` and `?` -> `[^/\\]` in `globToRegex`
       (tools.js). Keep `**` (crosses dirs) and `[...]` classes working.
- [ ] P1.1b Edge-case tests: `*.js` must NOT match `sub/a.js`; `?` must not
       cross `/`; `**/*.js` matches nested; `a?.js` matches `ab.js` not
       `a/b.js`; literal `.` escaped; dotfiles behaviour documented.
- [ ] P1.1c Gate: node -c + tests/tools.test.js (glob + find_files) green.

### P1.2 Async run_command (S, biggest event-loop win)
- [ ] P1.2a run_command: execSync -> promisified child_process.exec; keep
       TOOL_TIMEOUT, maxBuffer (20MB), classifyCommandError, truncated output.
- [ ] P1.2b Edge cases: timeout still enforced; maxBuffer overflow classified;
       non-zero exit error classified; stdout+stderr captured; large output
       truncated; shell metacharacters preserved; cwd/env honoured.
- [ ] P1.2c Event-loop test: a long run_command must not block a concurrent
       timer/spinner tick (assert ticker advanced during command).
- [ ] P1.2d Gate: node -c + run_command + parallel-tools tests green.

### P1.3 Concurrent write_files (S, keep assertSafePath)
- [ ] P1.3a write_files: sequential loop -> Promise.all; every path through
       assertSafePath; preserve per-file result order in output.
- [ ] P1.3b Edge cases: one unsafe path rejects the batch (no partial write
       leakage decision documented); duplicate paths; empty array; order of
       reported results stable; parent dirs created concurrently.
- [ ] P1.3c Gate: node -c + write_files tests green.

### P1.4 captureFailure(page,label) diagnostic bundle (S, zero risk)
- [ ] P1.4a New `src/failure-capture.js`: screenshot + dom.html + url.txt +
       adapter.txt under `~/.forge-agent/logs/failures/<ts>-<label>/`.
- [ ] P1.4b Call from `browser.sendMessage` final failure and `agent.js` when
       the empty-streak breaker fires (best-effort, never throws).
- [ ] P1.4c Edge cases: dir created if missing; write errors swallowed; label
       sanitised (no path traversal); temp-dir test asserts 4 files.
- [ ] P1.4d Gate: node -c + new tests/failure-capture.test.js green.

### P1.5 Phase P1 gate
- [ ] P1.5 Full suite + check-syntax --all green; git status clean.

---

## Phase P2 - Agent-loop correctness (ARCHITECTURE.md s.10)

### P2.1 Unify the two contradicting system prompts (s.10.1)
- [ ] P2.1a Decide single source of truth (system-prompt.js) and make
       prompt.js delegate to it; keep envelope markers + allow prose.
- [ ] P2.1b Edge cases: first-message injection identical from both paths;
       PLAN mode block preserved; profile systemPromptAddition merged once.
- [ ] P2.1c Gate: node -c + system-prompt + prompt tests green; snapshot the
       built prompt to catch drift.

### P2.2 Handle bare `text` responses (s.10.2)
- [ ] P2.2a agent.js loop: explicit case for parsed.type==='text' - a short
       correction nudge; increment _consecutiveUnrecognised; escalate after N.
- [ ] P2.2b Edge cases: consecutive text replies trip the correction nudge;
       reset on any valid tool_call/final; never loops forever (cap); works in
       plan mode; does not double-count empty-streak breaker.
- [ ] P2.2c Gate: node -c + agent/integration-auto-loop tests green.

### P2.3 Normalise logger.finalOutput signature (s.10.4)
- [ ] P2.3a One accepted signature (accept both string and ProgressTracker via
       an overload shim with a deprecation note); update call sites.
- [ ] P2.3b Edge cases: string path, tracker path, null/undefined safe.
- [ ] P2.3c Gate: node -c + logger/progress tests green.

### P2.4 Phase P2 gate
- [ ] P2.4 Full suite + check-syntax --all green; git status clean.

---

## Phase P3 - Tier 2 (config-gated, medium)

### P3.1 Async FS in file handlers (M, low risk)
- [ ] P3.1a read/write/append/replace/delete/list/create/get_file_info ->
       fs.promises (handlers already awaited by executeTool).
- [ ] P3.1b Edge cases: ENOENT/EISDIR/EACCES classified identically to today;
       large file read; line-range read; write creates parents; delete missing.
- [ ] P3.1c Gate: node -c + tools.test.js green (all handlers).

### P3.2 Image + telemetry blocking (S, gated)
- [ ] P3.2a browser.js launch(): BROWSER_BLOCK_IMAGES (blink arg) +
       BROWSER_BLOCK_TELEMETRY (page.route abort list). Config-gated default?.
- [ ] P3.2b Edge cases: upload chip still visible/uploadable when images
       blocked (smoke against mock page); route installed only when flag on;
       abort list scoped (no console/api breakage).
- [ ] P3.2c Gate: node -c + new tests/browser-optimizations.test.js green.

### P3.3 Hardened read_url (S)
- [ ] P3.3a Redirect-follow (bounded), 5xx marked retryable, explicit 15s
       socket timeout; FIX the `<script>` strip regex (missing `*`).
- [ ] P3.3b Edge cases: 301/302 chain capped; 5xx retried via withNetworkRetry;
       timeout aborts; HTML script/style stripped correctly; non-HTML passthrough.
- [ ] P3.3c Gate: node -c + read_url tests green.

### P3.4 isCurrentPageLayout() health predicate (S)
- [ ] P3.4a Add adapter predicate; health.js reports layout match/warn
       (NOT used for adapter selection).
- [ ] P3.4b Edge cases: matching DOM -> ok; wrong DOM -> warn (not fatal);
       missing DOM safe.
- [ ] P3.4c Gate: node -c + new tests/health-layout.test.js green.

### P3.5 Phase P3 gate
- [ ] P3.5 Full suite + check-syntax --all green; git status clean.

---

## Phase P4 - Tier 3 streaming (default-off)

### P4.1 onChunk display-only streaming (M)
- [ ] P4.1a Add onChunk callback to waitForResponse; wire logger.thinking live
       counter for display ONLY (executor NOT called early).
- [ ] P4.1b Edge cases: deltas monotonic; no executor call mid-stream; markers
       still gate completion; PAUSE_TEST mid-stream pause not mistaken for end;
       disabled path identical to today.
- [ ] P4.1c Gate: node -c + new tests/streaming-display.test.js + existing
       protocol-markers tests green.

### P4.2 Phase P4 gate
- [ ] P4.2 Full suite + check-syntax --all green; git status clean.

---

## Non-goals (do NOT implement - s.15 Tier 4)
AIAdapterDetector for selection; ChatGPT re-enable; wholesale tools.js swap;
weaker validator / dropped audit log / dropped cache invalidation.
