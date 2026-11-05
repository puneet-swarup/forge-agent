# FORGE_PLAN - active task plan (2026-11-05)

> Protocol: each step is a checkbox. Tick only after its gate passes. One item
> per commit. Baseline must stay green: `node scripts/run-jest.js` +
> `node scripts/check-syntax.js --all` + `npm run typecheck`.
>
> This plan is TEMPORARY: created at task start, ticked as work lands, DELETED
> at the end after the user confirms completion. If a run dies midway, this file
> shows exactly what is done and where to resume.
>
> Tick with: `node scripts/plan.js tick <n>` | status: `node scripts/plan.js status`

## Goal

First-class anti-block prompt pause (default ON, 10-20s random jitter between
consecutive prompts, `--no-prompt-pause` disables); document the FORGE_PLAN
lifecycle protocol in the README; implement the `last-raw-response.txt` file the
docs already promise; refresh PENDING_WORK/SESSION_CONTEXT/TESTING docs.
Markers stay (boundaries are useful).

---

## Phase P1 - prompt pause (anti-block)

- [x] P1.1 Config: `PROMPT_PAUSE` (true), `PROMPT_PAUSE_MIN_MS` (10000),
      `PROMPT_PAUSE_MAX_MS` (20000) in DEFAULTS + validators.
- [x] P1.2 Helper `sleepWithPause()` in agent.js: random ms in [MIN,MAX] when on.
- [x] P1.3 Wire: before each `browser.sendMessage` in the loop, call the helper
      (skips the very first message of a run to avoid startup delay).
- [x] P1.4 CLI: `--no-prompt-pause` flag sets PROMPT_PAUSE=false; help entry.
- [x] P1.5 Tests: tests/prompt-pause.test.js - range bounds, disabled=0, env override.
- [x] P1.6 Gate: node scripts/run-jest.js + typecheck green.

## Phase P2 - raw response file (docs promise)

- [x] P2.1 In agent.js DEBUG block, write rawResponse to
      `~/.forge-agent/logs/last-raw-response.txt` (best-effort, never throws).
- [x] P2.2 Test: tests/raw-response-log.test.js - file written under FORGE_HOME.
- [x] P2.3 Gate: new test + full suite green.

## Phase P3 - docs refresh

- [x] P3.1 README: add FORGE_PLAN lifecycle protocol section + pause feature row.
- [x] P3.2 README: document `--no-prompt-pause` in CLI reference.
- [x] P3.3 CHANGELOG: pause feature + raw-response file under [Unreleased].
- [x] P3.4 PENDING_WORK: refresh snapshot; mark markers decision = KEEP.
- [x] P3.5 Gate: check-syntax --all green; docs.test.js green.

## Phase P4 - cleanup

- [ ] P4.1 Confirm no dangling temp files; git status clean after commits.
- [ ] P4.2 Ask user to confirm -> then delete this FORGE_PLAN.md.

## Non-goals
- Removing response-envelope markers (user chose to KEEP them).
- Chrome-leak / navigation-fallback-message fixes (separate sprint).
