# Forge Agent — Architecture (Living Document)

> Canonical, human-maintained map of how Forge Agent is actually implemented —
> not what the README advertises. Keep it current as the code changes. When code and
> this document disagree, the code wins; then fix this document.
>
> Verified against `main` @ `96fba78` — baseline 79 suites / 1656 tests green.

---

## 1. What the product is

A CLI that turns free web chat UIs (DeepSeek, Gemini) into an autonomous coding
agent using Playwright browser automation. There is no API key and no LLM API —
"the model" is a browser tab the agent types into and scrapes replies from.
That single fact drives every architectural trade-off in this document.

---

## 2. Layer map

    bin: forge-agent / fa
      src/index.js              CLI entry, flag parsing, mode dispatch
       |-- src/agent.js         THE AGENT LOOP (core)
       |    |-- src/browser.js             Playwright lifecycle wrapper
       |    |    `-- src/adapters/{base,deepseek,gemini,chatgpt}-adapter.js
       |    |          sendMessage()     : type text -> submit
       |    |          waitForResponse() : detect completion -> scrape DOM
       |    |-- src/prompt.js              system prompt + ConversationManager
       |    |-- src/parser.js              scraped text -> structured tool call
       |    |-- src/tools.js               TOOLS registry + executeTool()
       |    |-- src/parallel-executor.js   tool-batch scheduling
       |    `-- src/permission-store.js + permission-menu.js
       `-- ~60 support modules (section 9)

Dependency direction: `index -> agent -> {browser, prompt, parser, tools}`.
Tools never import the agent. `config.js` is a Proxy imported everywhere (section 7).

---

## 3. The agent loop (`agent.js`)

`DeepSeekAgent.run(task, templateName)`:

    1. commandRouter.isCommand(task)? -> execute, return (no browser)
    2. logger.initTUI, new ProgressTracker, _sessionCtxStart(task)
    3. if MEMORY_ENABLED: memory.extractTechStackFromFiles(cwd)
                          -> conversation.prependMemoryContext(...)
    4. dirListing = _getWorkingDirListing()  // sent once, model need not list first
    5. firstMsg = conversation.buildFirstMessage(task, dirListing, profile, addition)
         (or PLAN prompt first when config.PLANNING_MODE)
         browser.sendMessage(firstMsg)
    6. LOOP:
         logger.stepLine(step, elapsedMs, progress, descriptor)
         if step > 10000                      -> break
         raw = browser.waitForResponse()      // throws -> emptyStreak handling
         conversation.addAssistantMessage(raw)
         parsed = parseResponse(raw)
         switch parsed.type:
           tool_batch       -> _runToolBatch(calls)   // parallel, index-aligned
           tool_call        -> permission gate -> executeTool -> addToolResult
                               -> browser.sendMessage
           error            -> nudge model with parse error
           final | task_complete -> history, run-summary, render, return
           text / empty     -> see section 10.2 (largest known weakness)
    7. record history, run-summary.md, sponsor nudge, memory.recordCompletedTask

### Loop safety mechanisms (all live in `agent.js`)

| Mechanism | Trigger | Behaviour |
|---|---|---|
| `step > 10000` | runaway | hard break |
| `_emptyStreak` | `waitForResponse()` throws | 4 -> `newChat()` + recovery; 6 -> partial result |
| `_consecutiveIdenticalCalls` | same `{name,args}` x3 | prompt: continue / skip / new task (auto-continue on non-TTY) |
| `toolCallCount > 5 / > 10` | batch size | warn / sleep 3 s |
| `shouldCompress(threshold)` | token estimate | `conversation.compress()` |

---

## 4. The protocol contract (the fragile seam)

One contract is enforced across four layers. Drift between them is the #1 bug class.

| Layer | File | Responsibility |
|---|---|---|
| Prompt | `system-prompt.js` (used by `adapters/base-adapter.js`) | wrap reply in FORGE_START/FORGE_END; tool call via a `<tool_call>` tag wrapping JSON with `tool` and `args`; batches allowed only when independent |
| Adapter | `deepseek-adapter.js` | `waitForResponse()` detects END marker OR DOM-quiet; `_extractLastMessage()` reconstructs fenced code blocks from `<pre><code class="language-tool_call">` |
| Parser | `parser.js` | 6 strategies: XML tags, fenced blocks, `tool(args)`, TASK_COMPLETE, bare JSON, plain text. Plus JSON repair and regex fallback for truncated `write_file` content |
| Agent | `agent.js` | executes the tool, echoes the result back as a user turn |

### IMPORTANT inconsistency: two system prompts exist

- `prompt.js::buildSystemPrompt` says "output ONLY a fenced tool_call block, no prose".
  `agent.js` uses this via `conversation.buildFirstMessage`.
- `system-prompt.js::buildSystemPrompt` says "brief reasoning before the tag is allowed; wrap everything in FORGE markers".
  `adapters/base-adapter.js::sendMessage` uses this on the first message.

Both paths can run in a session. They must not contradict — a live source of model
confusion and a strong candidate for unification (section 10.1).

### Completion detection (`deepseek-adapter.js`)

1. Marker fast path — `_hasEndMarker` requires END after START (so the model
   explaining the protocol does not trigger a false completion).
2. DOM-quiet fallback — `_installQuietWatcher()` (MutationObserver) +
   `_waitForDomQuiet(stableDelay)`, then re-extract and compare text before/after
   the quiet window, and check `_isGenerating()` (stop button visible). This
   double-check is why a mid-stream reasoning pause is not accepted as done.

The mock server `tests/helpers/mock-chat-server.js` is the executable spec for this:
`PAUSE_TEST` (mid-stream gap), `NO_MARKER_TEST` (fallback), `WS_MARKER_TEST` (sloppy markers).

---

## 5. Tools (`tools.js`)

`tools.js` exports a `TOOLS` registry (name -> {description, parameters, handler})
and `executeTool(name, args)`. `executeTool` wraps handlers with:

- ToolCache (`tool-cache.js`) — skips repeated read-only calls within a TTL.
- Path sandbox — `assertSafePath()` -> `security.validatePath()` blocks SSH keys,
  credentials, and (when `STRICT_SANDBOX=true`) anything outside the working dir.
- Truncation — `smartTruncate()` with `MAX_OUTPUT_LENGTH` (default 8000).
- Error classification — `classifyFsError` / `classifyCommandError` set `retryable`.

`read_file` handler (current behaviour): reads the file from disk, applies line-range
slicing, returns the raw text as the tool result, which `agent.js` echoes back into the
model's context as a user message. The full text goes over the chat transport every
time — see section 11 for the proposed upload-based optimisation.

---

## 6. Browser & adapters

`browser.js` launches a persistent Chromium context (`SESSION_DIR`), masks the
`webdriver` flag, then delegates to an adapter from `adapter-factory.js`.

Each adapter (`base-adapter.js` -> `deepseek/gemini/chatgpt-adapter.js`) owns:

- `_getInputSelectors() / _getSendSelectors() / _getStopSelectors() / _getNewChatSelectors()`
- `sendMessage(text)` — find input, fill (textarea) or `execCommand('insertText')`
  (contenteditable), click send or press Enter.
- `waitForResponse()` — completion detection (section 4) then `_extractLastMessage()`.

`browser.sendMessage()` adds a one-shot retry on selector/timeout errors and saves a
debug screenshot to `~/.forge-agent/logs/selector-debug.png` on final failure.

The adapters are the least-tested-in-reality layer: unit tests use a stub page and
the integration test uses a local mock. Selector correctness against the live UI is
verified only by `calibrate.js` / `dumpDebugInfo()` / `doctor.js` at runtime.

---

## 7. Config (`config.js`)

`config` is a `Proxy`. Reads return the live value (session override -> file override
-> `DEFAULTS`). Writes go through `setConfig()` which records a changelog entry and
fires `onConfigChange(keys, cb)`. `DEFAULTS` is the single source of truth for every
knob (model, timeouts, thresholds, cache, memory, history, sandbox, TUI, etc.).

`paths.js` centralises `~/.forge-agent` (with one-time migration from
`~/.deepseek-agent`) — session dir, logs, memory.json, history.json, config.json.

---

## 8. Testing model (what green actually means)

- Unit / contract (majority): `parser`, `tools`, `differ`, `searcher`, `config`,
  `formatter`, `tui`, `retry` … against in-memory or stub inputs.
- Mock browser (`tests/helpers/mock-chat-server.js`): drives the real adapter
  send/scrape loop against a local page. Encodes the protocol edge cases.
- Docs / assets: `docs.test.js`, `dockerfile.test.js`, `blog.test.js` assert on
  markdown/HTML so documentation cannot drift silently.

There is no test that touches chat.deepseek.com or gemini.google.com. Green tests
prove the harness and contract; they do NOT prove the live scraper works. This is the
single most important caveat when reading the badge.

---

## 9. Support modules (quick index)

| Area | Modules |
|---|---|
| CLI / UX | `index`, `commands`, `input-handler`, `tui`, `logger`, `formatter`, `help-topics`, `manpage`, `completions`, `wizard` |
| Agent smarts | `agent`, `planner`, `progress`, `run-summary`, `session-context`, `session-resume`, `session-registry`, `todo-manager`, `work-startup`, `project-context`, `memory`, `history` |
| Model I/O | `browser`, `adapter-factory`, `adapters/*`, `parser`, `prompt`, `system-prompt`, `compressor`, `truncator`, `thinking`, `retry`, `health` |
| Tools core | `tools`, `tool-cache`, `parallel-executor`, `worker-pool`, `searcher`, `test-runner`, `package-manager`, `differ`, `env-manager`, `process-manager`, `screenshot`, `clipboard` |
| Cross-cutting | `config`, `paths`, `security`, `errors`, `permission-store`, `permission-menu`, `plugin-loader`, `docker`, `doctor`, `diagnostics`, `calibrate`, `benchmark` |
| Multi-agent | `agent-supervisor`, `spawn_agent` (in `index`/`tools`) |
| Output / audio | `audio`, `audio-queue`, `sponsor`, `launch-assets`, `examples`, `templates`, `profiles` |

---

## 10. Known weaknesses / pitfalls (read before changing anything)

### 10.1 Two contradicting system prompts
`prompt.js` (fenced block, no prose) vs `system-prompt.js` (FORGE markers, prose
allowed). `agent.js` uses the first, `base-adapter.js` the second. Unify into one.

### 10.2 Unrecognised `text` responses are not handled explicitly
The parser returns `{type:'text', content}` for plain prose. The `agent.js` loop switch
handles `tool_batch`, `tool_call`, `error`, `final`/`task_complete` — a bare `text`
result falls through. In the deep-study run this manifested as quiet stalls until the
empty-streak breaker fired. The `_consecutiveUnrecognised` counter is declared but
under-used; wire it into a correction nudge.

### 10.3 Selector drift (the product-level bug)
Every interaction depends on CSS-class heuristics vs a third-party UI that ships
hashed class names. A silent mismatch returns empty text rather than a retryable
error, so the loop flails until `_emptyStreak` hits threshold. `dumpDebugInfo()` /
`calibrate.js` / `doctor.js` exist to diagnose this.

### 10.4 Inconsistent `logger.finalOutput` call sites
Some call sites pass a formatted string, others a `ProgressTracker`. `logger.js`
branches on `typeof progress === 'string'`. Works, but easy to break. Prefer one signature.

### 10.5 Baseline before touching anything
`node node_modules/jest/bin/jest.js --runInBand` -> 79 suites / 1656 tests should pass
on a clean tree. (On Windows `npx` may be unavailable in the agent shell; call jest directly.)

---

## 11. Proposed change: upload files instead of inlining text (read_file v2)

Idea. For `read_file`, upload the file to the chat UI (native file attach) instead
of reading it and echoing the full text back as a `[TOOL RESULT]` turn. Fall back to
inlined text when upload is unsupported or fails.

Why it is attractive. Today every `read_file` result is copied verbatim into the
conversation, so the text crosses the transport and burns context tokens. An uploaded
file is referenced, not re-transmitted, and the model can re-read it without another
round trip.

Feasibility / risks:

1. Not all adapters expose an upload affordance. DeepSeek and Gemini have a
   paperclip / attach input, but the selector is as drift-prone as the chat input. Must
   be adapter-level (`_getUploadSelectors()` + `_uploadFiles()`), with the same fallback.
2. Playwright upload is `setInputFiles` on an `input[type=file]`. The visible button
   is usually a styled label wrapping a hidden input. Use the real input node, or
   `page.waitForEvent('filechooser')` + `fileChooser.setFiles()` (section 13).
3. Per-model size / count limits are undocumented and change. Enforce a conservative
   cap and always keep the text path available.
4. Prompt contract must change. The model expects file content in a `[TOOL RESULT]`.
   Sending only "uploaded: path" needs a system-prompt + loop contract change.
5. Determinism. Uploaded files are async on the model side; completion detection must
   still rely on FORGE markers / DOM-quiet.
6. Tests. Extend `mock-chat-server.js` with a fake `input[type=file]` and assert both
   paths. No real-UI test in CI.

Recommended shape. Keep `read_file` as-is by default. Add `READ_FILE_UPLOAD`
(default false) and an adapter `supportsUpload()` probe. Only when flag AND probe pass
do we try upload first, with a hard timeout and transparent fallback. Do not ship on by
default until exercised against the live UIs. Consider applying it only to large files
(> 4-8 KB).

Status (implemented): `READ_FILE_UPLOAD` (default false), `READ_FILE_UPLOAD_MIN_BYTES`
(4096) and `READ_FILE_UPLOAD_TIMEOUT_MS` live in `config.js`. `BaseAdapter` defines
`_getUploadSelectors()` / `detectUploadSelector()` / `supportsUpload()` / `uploadFile()`;
**both live adapters (DeepSeek and Gemini) implement it** with `setInputFiles` first and a
`filechooser` fallback. `read_file` (tools.js) attempts upload-first only when the flag
AND probe pass AND the file is >= MIN_BYTES, with a hard timeout and transparent text
fallback. Covered by `tests/adapter-upload.test.js` (mock chat page + real Chromium).
Still default-OFF pending live-UI validation.

---

## 12. Proposed change: richer step-line summaries

Current state. `agent.js` already computes a descriptor before each step:

    const _stepDesc = progress.lastTool
      ? (_stepDescVerb(progress.lastTool.name) + (target ? ' ' + target : ''))
      : 'starting — sending task to model';
    logger.stepLine(step, progress.elapsedMs, progress, _stepDesc);

`tui.js::renderStepLine` renders it as `Step N — <descriptor>  ...  elapsed · stats`.
So a one-liner ALREADY exists (e.g. `Step 2 — reading b.txt`).

What is actually missing:

1. The descriptor is derived from the previous tool (`progress.lastTool`), so the
   line describes what just happened, not the current intent.
2. Verbs are generic (`using <tool>`, `checking git`). They do not say why. A model
   reasoning turn (`text`/`empty`) shows `starting — sending task to model` even mid-task.
3. Long targets are not truncated, so a long command can wrap and break box alignment.

Recommended shape.

- Keep it offline/deterministic — do NOT ask the model for a step title.
- Enrich `_stepDescVerb` and add a target summariser: `run_command` -> first clause;
  `write_file`/`read_file` -> basename; `search_in_files` -> `pattern in dir`;
  `install_package` -> package names.
- Pure `text`/`empty` turn -> show `waiting for model` instead of the misleading default.
- Clamp to terminal width with an ellipsis so right-hand stats never overflow.

Feasibility. Very high — contained to `_stepDescVerb` + a new `_summariseTarget` in
`agent.js` and clamping in `tui.js::renderStepLine`. Unit-test the summariser; snapshot
width. No protocol/browser change, no risk to the live loop.

---

## 13. Evaluation of `suggested/` (TypeScript RPA reference implementation)

`suggested/` contains a standalone TypeScript sketch (`AIAdapters.ts`, `run.ts`, ~300
lines) proposing a "production-grade" RPA wrapper. It is not part of the build (not
under `src/`, not compiled, imports `@playwright/test`). Treat it as a design input,
not code to merge. Study it, borrow patterns, do not lift it wholesale.

### 13.1 What it proposes

| # | Proposal | Claim |
|---|---|---|
| 1 | `launchPersistentContext('./.rpa_secure_session_cache')` | "Session Shield" — log in once, bypass auth walls |
| 2 | `--blink-settings=imagesEnabled=false` | Skip image rendering; save RAM/CPU |
| 3 | `page.goto(url, { waitUntil: 'commit' })` | Avoid `networkidle` hangs from telemetry |
| 4 | Streaming character-diff extraction emitting `onChunk` | Real-time output instead of blocking |

Plus: an `AIAdapterDetector` picking an adapter by `isCurrentPageLayout(page)`, and an
`uploadFile()` capability on the adapter interface.

### 13.2 Verdict against the existing code

Already implemented (1 and 3) — no work needed.

- `browser.js::launch()` already uses `chromium.launchPersistentContext(path.resolve(config.SESSION_DIR))`.
  The "Session Shield" is the same mechanism; only the path differs. Forge is strictly
  better: model-agnostic home dir, migration from `~/.deepseek-agent`, per-session isolation.
- `browser.js::_navigate()` already avoids `networkidle`: it uses
  `waitUntil: 'domcontentloaded'` plus a real readiness signal (`waitForSelector` on
  the adapter's input selectors with a bounded fallback). That is more reliable than
  `'commit'`, which fires before the SPA renders any chat UI.

Cheap, genuinely useful (2) — small win.

- `imagesEnabled=false` and the analytics `page.route()` abort list are not present.
  Both are low-risk, additive, and testable against the mock server. Recommend
  adopting as config-gated defaults (`BROWSER_BLOCK_IMAGES=true`,
  `BROWSER_BLOCK_TELEMETRY=true`) in `browser.js::launch()`. Caveat: some UIs render
  the upload chip / attachment preview as an image — verify upload still works before
  enabling image-blocking by default.

The streaming diff (4) — attractive but a real semantic change.

- Current `waitForResponse()` already polls `_extractLastMessage()` and has a
  `ThinkingTracker` consuming partial text, so we are half there.
- The blocker is not extraction, it is safety: `agent.js` must not execute a
  mutating tool until the reply is complete. `PENDING_WORK.md` already flags this.
  Streaming into the UI is safe; streaming into the executor is not. Adopt the
  `onChunk` hook for display only first (`logger.thinking` already shows a live
  counter), then consider early read-only execution behind a flag.

`AIAdapterDetector` (layout sniffing) — solves a problem we do not have.

- Forge chooses the adapter from `config.MODEL` before navigation (`adapter-factory`).
  Auto-detection by URL/DOM sniffing would only help if the user landed on the wrong
  page, which the health check already reports. It adds a failure mode where today
  there is a deterministic choice. Do not adopt for selection. The one useful
  fragment is `isCurrentPageLayout()` as a health-check predicate — a cheap
  assertion that the loaded DOM still looks like DeepSeek/Gemini.

`uploadFile()` on the adapter interface — same as section 11, now with a concrete shape.

`suggested/` gives a workable recipe worth borrowing:

1. Prefer the real `input[type="file"]` node and call `setInputFiles()` directly.
2. If only a button exists, use `page.waitForEvent('filechooser')` then
   `fileChooser.setFiles()` — the correct pattern for a styled label wrapping a hidden
   input, and it avoids the silent no-op.
3. Wait for an attachment chip (`mat-chip`, `.file-chip`, cancel-button detach) before
   sending — otherwise the prompt can be submitted before the file is bound.

This strengthens section 11's recommendation: implement `supportsUpload()` +
`uploadFile()` with `filechooser` fallback, gated by `READ_FILE_UPLOAD=false`.

Error forensics — worth adopting almost verbatim.

`suggested/run.ts` dumps `screenshot.png` + `dom.html` into a timestamped failures
folder on error. Forge only writes a single `logs/selector-debug.png` on send failure.
Recommend a `captureFailure(page, label)` helper writing screenshot + DOM + current URL
+ adapter name under `~/.forge-agent/logs/failures/<ts>-<label>/`, called from
`browser.sendMessage` final failure and from `agent.js` when the empty-streak breaker
fires. Pure diagnostics, zero risk.

### 13.3 Things in `suggested/` that are WORSE than the current code

- Fixed `waitForTimeout(1500)` sleeps and `stableTurns < 6` counting instead of the
  quiet-window + `_isGenerating()` double-check. Do not regress.
- `innerText()` only, no fenced-code-block reconstruction. Forge rebuilds
  `<pre><code class="language-tool_call">` into fences so the parser sees tool calls;
  adopting `innerText` alone would break tool calling.
- No marker/envelope support, no JSON repair, no truncation handling.
- `ChatGPTWebAdapter` is included, but the factory deliberately disables ChatGPT
  (bot detection). Do not re-enable via this sketch.
- Hard-coded selectors (`.ds-markdown`, `#prompt-textarea`) with no fallback lists.

### 13.4 Where it fits in the current architecture

| `suggested/` element | Forge module it maps to | Action |
|---|---|---|
| `launchPersistentContext` + resource args | `browser.js::launch()` | already present; add image/telemetry flags |
| `waitUntil: 'commit'` | `browser.js::_navigate()` | already better; no change |
| `page.route()` analytics abort | `browser.js::launch()` | add, config-gated |
| adapter `isCurrentPageLayout()` | `health.js` check | add as predicate, not selection |
| adapter `uploadFile()` / `detectUploadSelector()` | `adapters/base-adapter.js` + subclasses | add behind `supportsUpload()` |
| `extractStreamingResponse(onChunk)` | `adapters/*::waitForResponse()` | add display-only `onChunk` |
| failure screenshot + DOM dump | new `src/failure-capture.js` | add, call from browser + agent |
| `AIAdapterDetector` | `adapter-factory.js` | do not adopt for selection |
| `ChatGPTWebAdapter` | `adapters/chatgpt-adapter.js` | stays disabled |

### 13.5 Feasibility summary (what to actually implement, in order)

| Item | Effort | Risk | Recommend |
|---|---|---|---|
| Image + telemetry blocking in `browser.js` (config-gated) | XS | Low | Yes |
| `captureFailure()` diagnostic bundle | S | None | Yes |
| `isCurrentPageLayout()` as a health check | S | Low | Yes |
| `supportsUpload()` / `uploadFile()` + mock-server test (s.11) | M | Medium | Yes, default-off |
| `onChunk` streaming for display only | M | Medium | Yes, after upload |
| Early read-only execution while streaming | L | High | Later, flag-gated |
| `AIAdapterDetector` for adapter selection | M | Medium | No |
| ChatGPT re-enable | L | High | No |

### 13.6 Test impact

- New `tests/browser-optimizations.test.js` — assert `launch()` passes the blink
  setting and installs the route blocker when the config flags are on.
- New `tests/failure-capture.test.js` — temp dir, assert screenshot + dom files written.
- New `tests/health-layout.test.js` — mock page, `isCurrentPageLayout()` predicate.
- New `tests/adapter-upload.test.js` — mock chat server with a fake file input;
  assert `setInputFiles` and the `filechooser` fallback.
- New `tests/streaming-display.test.js` — `onChunk` deltas, no executor call.
- Existing `browser.test.js` mocks `launchPersistentContext` options with
  `objectContaining`, so added args are compatible. Full suite must stay at
  79+ suites green; re-run the baseline in 10.5 after every step.

---

## 14. Evaluation of `suggested/tools.js` (async tool-suite rewrite)

`suggested/tools.js` (438 lines) is a partial re-implementation of `src/tools.js`
(the real one is ~1537 lines, 37+ tools). It is a design reference, not a drop-in:
it only defines ~11 tools (show_info, read_file, write_file, append_to_file,
replace_in_file, delete_file, list_directory, create_directory, run_command,
read_url, write_files) and omits `getToolDescriptions` / `getLoadedPluginCount` /
`getLoadedPlugins` exports that `prompt.js` and `agent.js` depend on.

Its real contribution is an async execution model. Compare:

| Aspect | Current `src/tools.js` | `suggested/tools.js` | Winner |
|---|---|---|---|
| Filesystem | `fs.readFileSync` / `writeFileSync` / `statSync` | `fs.promises` (async) | suggested |
| Shell | `execSync` (blocks event loop) | `child_process.exec` (async) | suggested |
| `write_files` | sequential `for` loop | `Promise.all` (concurrent) | suggested |
| `list_directory` sizes | `statSync` per entry | `Promise.all` stats | suggested |
| Glob `*` | `.*` (crosses `/`) | `[^\/]*` (segment-scoped) | suggested |
| `read_url` | basic fetch | redirect-follow, 5xx retryable, 15 s timeout | suggested |
| Arg validation | required and type checks | required only | current |
| Audit log | `appendToAuditLog` | absent | current |
| Cache invalidation | `invalidatesCache` + `invalidateByTool` | absent | current |
| Tool coverage | 37+ tools | ~11 tools | current |
| Exports for prompt/agent | `getToolDescriptions`, plugin counts | missing | current |

### 14.1 What it improves (adopt)

1. Async tool execution. `execSync`/`readFileSync` block the Node event loop, which
   stalls the TUI spinner, the audio queue, and any concurrent child-agent heartbeat.
   Moving `executeTool` to fully async (`fs.promises`, `child_process.exec`) is the single
   biggest win. It also makes real parallel batches (`MAX_PARALLEL_TOOL_CALLS`) actually
   parallel — today parallel `run_command` calls serialise on the event loop.
2. Concurrent `write_files`. `Promise.all` over independent writes matches the
   advertised batch semantics in the system prompt.
3. Segment-scoped glob. `*` -> `[^\/]*` means `find_files("*.js")` no longer matches
   across directory separators — a latent correctness bug in the current `.*` conversion.
4. Hardened `read_url`. Redirect following, 5xx marked retryable for `withNetworkRetry`,
   explicit 15 s socket timeout. Current `read_url` is more basic.
5. `maxBuffer` 20 MB on commands — already present in current `run_command`; keep.

### 14.2 What it degrades or loses (do NOT adopt)

1. Weaker validation. It only checks `required`; the current `validateToolArgs` also
   enforces `string`/`number`/`boolean`/`array`/`object` types. Losing type checks would
   let e.g. `run_command({ command: 123 })` through. Keep the current validator.
2. No audit log. `appendToAuditLog` (gated by `config.AUDIT_LOG`) is a security
   feature; the sketch drops it.
3. No cache invalidation. Current `executeTool` calls `cache.invalidatesCache()` /
   `invalidateByTool()` after mutations; the sketch only gets/sets. Dropping this would
   serve stale reads after writes.
4. Missing exports. `prompt.js` calls `getToolDescriptions()`; `agent.js` calls
   `getLoadedPluginCount()`. The sketch exports neither — importing it as-is breaks the
   system prompt build.
5. Tool coverage. 37+ -> ~11 tools. Most of the suite (`git_*`, `run_tests`,
   `install_package`, `diff_files`, `patch_file`, env tools, process tools, spawn/kill
   agent, clipboard, audio, screenshot) is absent.
6. `replace_in_file` skips `assertSafePath` (uses bare `resolve`). Path-sandbox
   regression.
7. `write_files` skips `assertSafePath` too. Same regression.
8. `read_url` regex `<script[\s\S]?</script>` is malformed (missing `*`) — it will
   strip almost nothing. A bug to avoid, not copy.

### 14.3 Where it fits (incremental, not a rewrite)

The right move is to port the async model into the existing `tools.js`, not replace
it. The tool registry, validator, audit log, and cache stay. Per-tool handlers change
`Sync` -> `await`.

| Change | File | Mechanic |
|---|---|---|
| Async FS in handlers | `src/tools.js` | `fs.readFileSync` -> `await fs.promises.readFile`, etc. |
| Async shell | `src/tools.js::run_command` | `execSync` -> promisified `exec` |
| Concurrent `write_files` | `src/tools.js::write_files` | sequential loop -> `Promise.all` (keep `assertSafePath`) |
| Segment-scoped glob | `src/tools.js::globToRegex` | `.*` -> `[^\/]*`, `?` -> `[^\/]` |
| Hardened `read_url` | `src/tools.js::read_url` | redirects, 5xx retryable, 15 s timeout (fix the regex) |

`executeTool` is already `async`, so no call-site changes are needed in `agent.js` /
`parallel-executor.js` — they already `await` it. This is a handler-internal refactor.

### 14.4 Feasibility summary (adds to section 13.5)

| Item | Effort | Risk | Recommend |
|---|---|---|---|
| Async FS in read/write/append/replace/delete/list/create | M | Low | Yes |
| Async `run_command` (`exec`) | S | Low | Yes (biggest loop win) |
| Concurrent `write_files` with path checks | S | Low | Yes |
| Segment-scoped `globToRegex` | XS | Low | Yes (fixes a bug) |
| Hardened `read_url` (redirect/timeout/retry) | S | Low | Yes |
| Adopt sketch's weaker validator | - | High | No |
| Replace `tools.js` wholesale | - | High | No |

### 14.5 Test impact

- Existing `tests/tools.test.js` exercises handlers synchronously via `await executeTool`,
  so async handlers are source-compatible. Add cases: `write_files` concurrency
  (assert `Promise.all` ordering preserved), glob segment scope (`*.js` must not match
  `sub/a.js`), `read_url` redirect/5xx, and that `replace_in_file`/`write_files` still
  reject paths outside the sandbox.
- Regression guard: `run_command` must still honour `TOOL_TIMEOUT`, `maxBuffer`, and
  `classifyCommandError`.

---

## 15. Consolidated backlog (all accepted goodies from every run)

This is the single, deduplicated list of accepted improvements pulled from sections
11, 12, 13 and 14. It is the authoritative "what to implement" order. `PENDING_WORK.md`
mirrors the short form; this table keeps the why and the acceptance test.

### Tier 1 — safe, high-value, do first

| # | Change | Source | Acceptance |
|---|---|---|---|
| 1 | Step-line target summariser + width clamp | s.12 | `Step N — reading pkg.json` reflects current intent; long commands truncated with ellipsis; unit test for `_summariseTarget`, snapshot for width |
| 2 | `captureFailure(page,label)` bundle (screenshot + DOM + URL + adapter) under `~/.forge-agent/logs/failures/<ts>-<label>/` | s.13.2 | called from `browser.sendMessage` final failure and `agent.js` empty-streak breaker; temp-dir test asserts files |
| 3 | Segment-scoped `globToRegex` | s.14 | `*.js` does not match `sub/a.js`; `?` does not cross `/` |
| 4 | Async `run_command` (`exec` + timeout/maxBuffer/classify) | s.14 | event loop not blocked (spinner keeps ticking); timeout still enforced |
| 5 | Concurrent `write_files` (keep `assertSafePath`) | s.14 | `Promise.all`, order preserved, sandbox still rejects outside paths |

### Tier 2 — config-gated, medium

| # | Change | Source | Gate | Acceptance |
|---|---|---|---|---|
| 6 | Async FS in file handlers | s.14 | none | handlers `await`; `tools.test.js` green |
| 7 | Image + telemetry blocking | s.13.2 | `BROWSER_BLOCK_IMAGES`, `BROWSER_BLOCK_TELEMETRY` | `launch()` passes blink arg + installs route; upload chip still visible |
| 8 | Hardened `read_url` (redirects, 5xx retry, timeout) | s.14 | none | redirect followed, 5xx retryable, socket timeout |
| 9 | `isCurrentPageLayout()` health predicate | s.13.2 | none | `health.js` reports layout match/warn |

### Tier 3 — feature work, default-off

| # | Change | Source | Gate | Acceptance |
|---|---|---|---|---|
| 10 | `supportsUpload()` / `uploadFile()` adapter capability | s.11 + s.13.2 | `READ_FILE_UPLOAD=false` | mock server fake file input; `setInputFiles` + `filechooser` fallback |
| 11 | `read_file` upload path with text fallback | s.11 | same flag | upload-first for large files, transparent fallback |
| 12 | `onChunk` streaming for display only | s.13.2 | none | deltas rendered; executor not called early |

### Tier 4 — deliberate non-goals (documented so we do not revisit)

- `AIAdapterDetector` for adapter selection (s.13.2) — Forge picks by config; keep.
- ChatGPT adapter re-enable (s.13.3) — bot detection; stays disabled.
- Whole-file replacement of `tools.js` (s.14.4) — port async, do not swap.
- Weaker validator, dropped audit log, dropped cache invalidation (s.14.2).

### How to work through it

1. One item per commit: code + tests + this doc + `CHANGELOG.md` + `PENDING_WORK.md` tick.
2. Re-run baseline (s.10.5) before and after. Target: 79+ suites green, typecheck clean.
3. Tier 3 items need a live-UI validation pass (`--debug` raw log + upload smoke) before
   the flag is recommended on.

---

## 16. Maintaining this document

- Update sections 2, 3, 5, 6 whenever module boundaries or the loop change.
- Update section 4 whenever the prompt/parser/adapter contract changes — the
  highest-risk area.
- Record accepted proposals (sections 11, 12, 13, 14) and tick them in section 15 with
  the commit hash and the config flag that gates them.
- Re-run the baseline in section 10.5 before and after any change.
- `PENDING_WORK.md` stays the short human backlog; this file is the durable as-built
  map. `SESSION_CONTEXT.md` is auto-generated and ephemeral — never rely on it.
- `suggested/` is a design reference only — never import from it, never build it.

_End of document._
