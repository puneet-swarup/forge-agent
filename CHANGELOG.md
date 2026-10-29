# Changelog — Forge Agent

All notable changes documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [Unreleased]

### Added
- **Parallel TODO pool (`--parallel`)** — `src/worker-pool.js` runs open FORGE_TODO.md items across up to `--max-parallel` child agents at once (each its own session/profile), ticking each success. The biggest throughput win for independent work. New `--parallel` flag + help entry; unit + real-process integration tests.
- **`forge-agent --doctor`** - one-command health check (Node version, Chromium install, config validity, data-dir writability, browser-profile presence) with PASS/WARN/FAIL output and hints; exits non-zero on failure for CI use. Module `src/doctor.js`; tests in `tests/doctor.test.js`.
- **`forge-agent --summary [session]`** - surface durable run summaries: list all sessions or print one session's full summary. Backed by `readSummary`/`listSummaries` in `src/run-summary.js`.
- **Reliable `ps` for custom session dirs** - heartbeats now write to a canonical `~/.deepseek-agent/instances/<name>.json` (independent of `--session-dir`) and a `starting` heartbeat is written before the browser launches, so `ps` shows agents that use a custom profile dir and agents still booting/login-blocked. `listInstances` scans the canonical dir (plus legacy session dirs, deduped). Tests added.
- **Descriptive step lines** - the agent's per-step TUI line now carries a short one-liner saying what the step is doing (e.g. `Step 3 — writing src/app.js`), derived from the most recent tool call (`ProgressTracker.lastTool`). This is the default protocol, not an option: `renderStepLine` accepts a descriptor and the agent loop always supplies one. Tests cover `lastTool` tracking.
- **Durable per-run summaries** - `src/run-summary.js` writes a structured, attributable summary of every terminal run (completed/failed/timeout) to `~/.deepseek-agent/sessions/<session>/summary.md` and `summary.json` (session, role, task, status, duration, steps, files written, commands run, errors, final output). A concise summary is also printed at completion. Crucial when multiple agents are spawned: you can always tell which agent did what. The system prompt now also asks the model to write a brief summary before TASK_COMPLETE. Unit tests cover normalisation, markdown rendering, and file writing.
- **Response-envelope protocol (deterministic completion)** — the system prompt now instructs the model to wrap every reply in `<<<FORGE_START>>>` … `<<<FORGE_END>>>` markers. When the adapter sees the END marker it stops immediately instead of waiting for a DOM-quiet window; if the model ignores the markers, every code path falls back to the existing DOM-quiet + `_isGenerating()` logic, so reliability is never reduced — only speed improves when the contract is honoured. Markers are stripped from the final text. `_hasEndMarker` requires END to appear AFTER START, so a stray END in prose/code or an END-without-START cannot falsely complete. New tests cover marker-stripping, the no-marker fallback, the mid-stream pause with markers, sloppy markers (prose/whitespace around them), and a pure unit matrix (`tests/protocol-markers.test.js`). When `DEBUG` is on, the raw scraped text (pre-strip) is saved to `~/.deepseek-agent/logs/last-raw-response.txt` so real-world protocol compliance can be inspected without another live login.
- **Tuned delays + real navigation readiness** — `SEND_DELAY` 600ms → 250ms (safe lower bound; `waitForResponse` owns appearance detection); `browser.js::_navigate` no longer sleeps a blind 3s — it waits for the chat input selector (falling back to `NAV_SETTLE_MS`). All timing is config/env overridable, so tuning is revertible via config, not a code revert. `STABLE_DELAY` left at its safe default to avoid re-opening the truncation bug.

### Fixed
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
