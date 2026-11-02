# FORGE_PLAN - active task plan

> Protocol: each step is a checkbox. Tick only after its gate (node -c + the
> relevant tests incl. edge cases) passes. One item per commit. Baseline must
> stay green: `node scripts/run-jest.js` + `node scripts/check-syntax.js --all`.

## IMPORTANT: ARCHITECTURE.md s.14 backlog is STALE

Audit on 2026-11-03 found several s.14 items ALREADY implemented in the
current tree. Verified present:
- globToRegex already segment-scoped (`*`->[^/]*, `?`->[^/]) - tools.js:136
- run_command already async (`exec`, not execSync) - tools.js:549
- write_files already concurrent (`Promise.all` + assertSafePath) - tools.js:765
- read_url already has redirects + 5xx retry + 15s timeout + fixed script regex - tools.js:700
- bare `text` handling already implemented (nudge + counter + cap) - agent.js:677

So the original P1.1-P1.3, P3.3, P2.2 are DONE. This plan lists only the
genuine remaining gaps. Each already-done item gets a REGRESSION GUARD test.

---

## Phase P1 - regression guards for already-implemented items

### P1.1 Glob segment-scope guard
- [x] P1.1a Export globToRegex; test `*.js`!match `sub/a.js`, `?`!cross `/`,
       `**/*.js` matches nested, `a?.js` matches ab.js not a/b.js, literal `.` escaped.
- [x] P1.1b Gate: node -c + tools.test.js green.

### P1.2 Async run_command guard
- [x] P1.2a Long command does NOT block a concurrent timer; timeout enforced;
       maxBuffer overflow classified; non-zero exit classified.
- [x] P1.2b Gate: node -c + run_command + parallel-tools tests green.

### P1.3 Concurrent write_files guard
- [x] P1.3a Order preserved, Promise.all concurrency, unsafe path rejected,
       empty array, dup paths, parents created.
- [x] P1.3b Gate: node -c + write_files tests green.

### P1.4 read_url hardening guard
- [x] P1.4a 302 followed, 5xx retryable, 15s timeout aborts, script/style
       stripped, non-HTML passthrough.
- [x] P1.4b Gate: node -c + read_url tests green.

### P1.5 Phase gate
- [x] P1.5 Full suite + check-syntax --all green; git status clean.

---

## Phase P2 - genuine gaps from ARCHITECTURE.md s.10

### P2.1 Unify the two buildSystemPrompt functions (s.10.1) - REAL
- [x] P2.1a Two buildSystemPrompt exist (prompt.js:18 AND system-prompt.js:10).
       Pick system-prompt.js canonical; prompt.js delegates; unify tool-call
       format (fenced vs FORGE markers) into one contract.
- [x] P2.1b Edge: first-message injection identical from both paths; PLAN mode
       preserved; profile addition merged once; markers present.
- [x] P2.1c Gate: node -c + system-prompt + prompt tests green; snapshot prompt.

### P2.2 Normalise logger.finalOutput signature (s.10.4) - verify then fix
- [x] P2.2a Audit call sites; accept string + ProgressTracker via shim (or
       normalise). Edge: string, tracker, null/undefined safe.
- [x] P2.2b Gate: node -c + logger/progress tests green.

### P2.3 Phase gate
- [x] P2.3 Full suite + check-syntax --all green; git status clean.

---

## Phase P3 - genuine Tier 2/3 gaps (verified NOT present)

### P3.1 captureFailure(page,label) diagnostic bundle (s.13.2) - REAL
- [x] P3.1a New src/failure-capture.js: screenshot + dom.html + url.txt +
       adapter.txt under ~/.forge-agent/logs/failures/<ts>-<label>/.
- [x] P3.1b Call from browser.sendMessage final failure + agent.js empty-streak
       breaker (best-effort, never throws).
- [x] P3.1c Edge: dir created; write errors swallowed; label sanitised; temp-dir
       test asserts 4 files.
- [x] P3.1d Gate: node -c + new tests/failure-capture.test.js green.

### P3.2 Image + telemetry blocking (s.13.2) - REAL
- [x] P3.2a browser.js launch(): BROWSER_BLOCK_IMAGES (blink arg) +
       BROWSER_BLOCK_TELEMETRY (page.route abort), config-gated default off.
- [x] P3.2b Edge: upload chip still uploadable when images blocked (mock smoke);
       route installed only when flag on; abort list scoped.
- [x] P3.2c Gate: node -c + new tests/browser-optimizations.test.js green.

### P3.3 isCurrentPageLayout() health predicate (s.13.2) - REAL
- [ ] P3.3a Adapter predicate; health.js reports layout match/warn (NOT selection).
- [ ] P3.3b Edge: matching DOM ok; wrong DOM warn (not fatal); missing DOM safe.
- [ ] P3.3c Gate: node -c + new tests/health-layout.test.js green.

### P3.4 onChunk display-only streaming (s.13.2) - REAL
- [ ] P3.4a onChunk callback in waitForResponse; wire logger.thinking live counter
       (display ONLY; executor NOT called early).
- [ ] P3.4b Edge: deltas monotonic; no executor call mid-stream; markers gate
       completion; PAUSE_TEST mid-pause not mistaken for end; disabled path same.
- [ ] P3.4c Gate: node -c + new tests/streaming-display.test.js + protocol-markers green.

### P3.5 Phase gate
- [ ] P3.5 Full suite + check-syntax --all green; git status clean.

---

## Non-goals (s.15 Tier 4 - do NOT implement)
AIAdapterDetector for selection; ChatGPT re-enable; wholesale tools.js swap;
weaker validator / dropped audit log / dropped cache invalidation.
