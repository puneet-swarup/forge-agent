# NEXT SESSION — Forge Agent workstreams

**Verified:** 2026-11-21, against `main` @ `704d182` (after PRs #3-#16). The
runner never merges; the lead agent merges after CI is green.
**Rule for this file:** implementation and tests are authoritative. A status here
is only "done" if the evidence column can be re-run and passes. Anything carried
over from an earlier handoff is marked *(unverified)* until someone checks it.

Re-verify everything in one pass:

```bash
npm test                                  # suite must be green (2,359 passing / 19 skipped)
npm run typecheck
node scripts/verify-prompt.js             # the prompt the agent actually sends
grep -rn "encodeTransportArg" src/transport.js   # T1
ls src/loom 2>/dev/null                   # T2
npx jest tests/adapter-contract.test.js   # T3
npx jest tests/lifecycle-gate.test.js     # T4 (27)
ls scripts/lifecycle.js scripts/plan.js   # T4
npx jest tests/loom                       # T2 slice 1 (162 passing / 2 skipped)
ls src/loom/schema/001_init.sql           # T2 schema
grep -rn "['\"\`]/(var/)?tmp/" src/       # T5 (must be empty)
npx jest tests/markdown-scope.test.js     # T6 (14)
```

---

## Coordination rule — one writer at a time

Two workers share this repo: the **lead agent** (interactive, merges) and the
**scheduled runner** (a cron job every 2 hours, opens PRs, never merges). They
share no memory; this file and git are the only state.

The rule that keeps them apart:

1. **At most one PR in flight.** A worker runs `gh pr list --state open` before
   starting. If anything is open, it stops and reports. This is what failed on
   2026-11-21: two runs both saw an empty queue and opened duplicate governance
   PRs (#11 and #12), and three PRs then conflicted over this file and
   `CHANGELOG.md`.
2. **Claim before working.** The runner writes `IN PROGRESS: <item> — <branch>`
   under `## Claim` here, in its first commit.
3. **Only the lead agent merges.** The runner never merges or force-pushes.
4. **Merged branches are deleted**, so a stale branch never looks like live work.

## Running autonomously

A cron job (`forge-agent roadmap runner`, every 2 hours) reads this file, takes
the next unblocked item, implements it with tests, opens a PR and updates this
file. It never merges and never force-pushes. If CI fails twice on the same item
it leaves the branch and reports the failure.

Phase A (robustness) is now **complete**: turn boundary, one prompt, recovery,
redaction, workspace safety, budgets, parser validation, throttling, transport
integrity, verification gate, path portability, shell policy and context
rotation are all on `main`.

## Status at a glance

| Task | Workstream | Status | Evidence | Next action |
| --- | --- | --- | --- | --- |
| **T1** | Transport | **DONE** | `src/transport.js` exports `encodeTransportArg` / `decodeTransportArg` / `md5hex`; `content_md5`, `is_hex`, `find_md5`, `replace_md5` are in `src/tools.js`; `tests/transport-integrity.test.js` (19) green | none — see limitation below |
| **T2** | Loom | **IN PROGRESS — slices 1 and 2 merged** | storage (`config, paths, hash, ignore, db, migrate, schema`), extractors for js/ts/py/go/rs/sql/md/data (`src/loom/extract/`), and import resolution (`src/loom/resolve.js`); `tests/loom/` 257 tests green; nothing wired into the loop yet | slice 3: the graph, then the digest |
| **T3** | Adapters | **OPEN — live-DOM accuracy only** | all 8 adapters implement the 6 contract methods; `tests/adapter-contract.test.js` (50) green | per-adapter live smoke test with a real login |
| **T4** | Plan lifecycle | **DONE** (PR #9 merged) | `src/lifecycle-gate.js` gates the first mutating tool and `TASK_COMPLETE`, bounded by `MAX_PLAN_GATE_ATTEMPTS`; `PLAN_GATE=false` disables it | nothing |
| **T5** | Cross-platform paths | **DONE (targeted)** | no literal `/tmp` in `src/`; `icacls` hints on win32; `tests/path-portability.test.js` green | extend only if a new path bug appears |
| **T6** | Markdown governance | **DONE** | `docs/MARKDOWN_SCOPE.md` re-audited (21 tracked files, verified against the tree); `tests/markdown-scope.test.js` (14) green and fails on any undocumented `.md` | follow the three open findings below |

---

## T1 — Dual-encoding transport · DONE

Implemented in commit `fc26c77`, merged via PR #3.

- `encodeTransportArg(text, 'base64' | 'hex')` → `{ value, md5, is_base64, is_hex }`
- `decodeTransportArg(value, { isBase64, isHex, md5, label })` → `{ buffer, text, md5, verified }`
- base64 **and** hex round-trip-check what was consumed; a supplied MD5 is
  compared against the decoded bytes and a mismatch **throws before anything is
  written**; a malformed hash throws rather than being ignored; no hash keeps the
  old behaviour, and the legacy positional signature still works.
- Wired into `write_file`, `append_to_file` (`content_md5`, `is_hex`),
  `replace_in_file` (`find_md5`, `replace_md5`, `is_hex`) and `write_files`
  (per-item `content_md5` / `is_hex`).

**Acceptance from the handoff:** base64 round trip ✔, hex round trip ✔, checksum
mismatch handling ✔, special characters ✔ (`$`, backticks, braces, newlines and
10 KB of random bytes in `tests/transport-integrity.test.js`).

**Known limitation (documented in `docs/RELIABILITY.md` §10):** the hash is
computed by the *sender*. For an LLM that is reliable on short strings and not on
large files, so a match proves the payload survived the channel, while the
absence of a hash means no end-to-end proof. The prompt tells the model to
include a hash only when certain, because a wrong hash blocks a legitimate write.

---

## T2 — ClickHouse Loom · IN PROGRESS (slice 1 of 5)

The normative specification is **`src/loom_specs.md`** (v1, 839 lines, "ready for
implementation"). It is self-contained: where a design choice existed, it is
already made and marked DECIDED.

What the spec builds: a persistent, incremental index of files, symbols,
dependency edges and purpose summaries, stored inside the project, compiled into
a small digest injected into the model's first prompt.

What it explicitly does **not** build: no external database, daemon, network
service or new npm dependency; no embeddings; no file-body archive; no
replacement for `read_file`.

Merge-blocking invariants from the spec (I1–I6), worth restating because they
are easy to violate:

- **I1** no Loom call may throw into a tool handler or reject an awaited promise;
- **I2** `LOOM_ENABLED=0` makes every public API a no-op with no I/O;
- **I3** the digest never presents a line range from superseded content;
- **I4** Loom never modifies anything under `src/adapters/`;
- **I5** Loom never sends a prompt to a non-dedicated model;
- **I6** all stored paths are project-relative with forward slashes.

Exactly **three** integration points: orchestrator (open / refresh / digest /
attach to the adapter, reattach after `newChat`), the tool dispatcher
(`loom.around(tool, args, invoke)`), and `search_codebase` (Loom first, filesystem
fallback).

**Prior art, not to be merged:** branch `loom` (commit `0488c62`) carried a
partial storage layer — `config, db, hash, ignore, migrate, paths,
schema/001_init.sql` — but that branch is based on the old `v2.0.2` lineage, not
on `main`, and merging it would delete ~19.7k lines. It is no longer fetchable by
SHA from `origin`, so slice 1 was written from the spec instead. That is the
better outcome anyway: the spec is the authority, not that code.

**Progress — slice 1, storage foundation (done).** `src/loom/` now holds
`config.js`, `paths.js`, `hash.js`, `ignore.js`, `db.js`, `migrate.js`,
`log.js`, `schema/001_init.sql` and `index.js`. `open()` resolves the index
directory (`<root>/.forge/loom`, global fallback when the project is not
writable), writes the generated-artifact `.gitignore`, opens the store, runs
migrations and seeds `meta`. `status()` and `stats()` expose what `--loom doctor`
will print. Nothing is wired into the agent loop yet — that is slice 5.

Three invariants are already enforced, not just intended:

- **I1** — every exported function catches and returns a neutral value; a store
  that cannot be created disables Loom for the run instead of failing the task;
- **I2** — `LOOM_ENABLED=0` returns before the first `fs` call (a test asserts
  `.forge/` is never created);
- **I6** — path normalisation rejects absolute and escaping paths rather than
  rewriting them; storage is always project-relative, forward slashes.

**Remaining slices** (one PR each, in order):

2. extractors (`extract/*.js`), `findBlockEnd`, `resolve.js` — fixture-tested
   against real files, no database needed;
3. indexer — `refresh.js` sweep, git short-circuit, dirty flag, worker,
   tombstones, access rows, caps and warm-up order;
4. digest, `query.js`, `heat.js`, `summarize.js`, `portable.js`;
5. integration — `attach()` / reattach after `newChat`, `loom.around()` in the
   tool dispatcher, `search_codebase`, `--loom` CLI, chaos tests (delete / lock /
   truncate the index mid-task).

**Deviations from the spec, recorded deliberately** (also in `docs/LOOM.md`):
tests are jest, not `node:test`, because CI runs one runner over
`tests/**/*.test.js`; `log.js` exists because `src/logger.js` has no `debug`;
keyed inserts are upserts so the SQLite and JSON backends behave identically.

**Note on runtime:** `node:sqlite` is absent on Node 20 (`engines: >=20`), so the
JSON store is the path most users run, not a fallback of last resort. Two SQLite
tests skip where the module does not load and run where it does.

**Acceptance:** `node --test tests/loom/` green, digest within its token budget,
and a chaos test (delete / lock / truncate the index mid-task) that still
completes the task.

**Note on runtime:** the spec targets Node ≥ 22.5 for `node:sqlite`, which is
still experimental; `package.json` declares `engines: >=20`, so the JSON fallback
is mandatory rather than optional.

---

## T3 — Adapter repair · OPEN (live-DOM accuracy only)

The earlier handoff listed **qwen, gemini, google, local-chat, ollama** as broken
and **deepseek, chatgpt, colab** as working. Checked against the code, that split
does not hold: **all eight adapters implement the six contract methods**, and
`colab` inherits them from `local-chat` by design (it is a subclass).

What is now proven offline, in `tests/adapter-contract.test.js` (50 assertions):

- every adapter implements `_getInputSelectors`, `_getSendSelectors`,
  `_getStopSelectors`, `_getNewChatSelectors`, `_getResponseSelectors`,
  `getModelUrl`;
- no selector list is empty, and none contains a malformed selector (balanced
  brackets and quotes);
- no selector repeats within a list;
- the composer and the send button never share a selector (which would click into
  the input instead of submitting);
- the stop and response selectors are disjoint (a stop button must never be
  scraped as the reply);
- `getModelUrl()` returns a usable URL, except `colab`, which has no default
  endpoint on purpose and must resolve its own;
- every adapter file is referenced by a registry entry.

**What cannot be proven offline:** whether those selectors still match the live
UIs. That needs a human with a login, per adapter:

```bash
forge-agent --model=qwen --test-model
forge-agent --model=gemini --test-model
forge-agent --model=google --test-model
forge-agent --model=local  --test-model
forge-agent --model=ollama --test-model
```

The mock-page suite (`tests/integration-browser.test.js`) drives the DeepSeek
adapter only, and it encodes that adapter's own selectors — it cannot detect real
drift. Recorded-DOM fixtures are the fix (see `docs/RELIABILITY.md`).

---

## T4 — Plan lifecycle · DONE in PR #9 (open)

- The artifact protocol (FORGE_PLAN.md created, ticked, deleted only on sign-off)
  is stated in the **live** prompt — it was previously only in the unused one.
- `src/lifecycle.js` defines the artifact contract **and** the checks
  (`checkStart`, `checkEnd`, `parseCheckboxItems`); `scripts/lifecycle.js` is now
  a thin CLI over them; `scripts/plan.js` provides `status / list / tick / next`.
- **The loop calls the gates.** `src/lifecycle-gate.js` decides, `agent.js` acts,
  in three places: before a single tool call, before a tool batch, and at the top
  of the completion branch.
  - start: the first *mutating* tool of a multi-step task is refused until
    `FORGE_PLAN.md` exists with at least one `- [ ]` step. Writing the plan is
    always allowed (otherwise the gate deadlocks), a read-only tool is never
    gated, and a one-clause task (`create hello.js`) is never asked for a plan.
  - end: `TASK_COMPLETE` is refused while a step is open; the refusal lists the
    open steps by line number. It runs after the verification gate.
  - bounded by `MAX_PLAN_GATE_ATTEMPTS` (default 2) in both directions; a missing
    plan at completion is reported, not refused. `PLAN_GATE=false` kills both.
- **Evidence:** `tests/lifecycle-gate.test.js` — 27 tests: every decision branch,
  the plan-write exemption (POSIX and Windows paths), and six end-to-end loop
  cases with a scripted browser.

Implemented in PR #9 (`feat/plan-gate`, CI green, not merged): the loop calls
`decideStart()` before the first mutating tool of a multi-step task and
`decideEnd()` at `TASK_COMPLETE`, using the verification-gate pattern (refuse,
feed back, bounded by `MAX_PLAN_GATE_ATTEMPTS`). The remaining limitation is that
the plan is still written by the model; deriving it from the request is a
separate change.

---

## T5 — Cross-platform paths · DONE (targeted)

The handoff implied a large sweep. The audit found the surface small: most `'/'`
usage is deliberate normalisation for display and storage (and required by Loom
invariant I6). Two real defects were fixed in PR #5:

- `src/calibrate.js` wrote its screenshot to a literal `/tmp/forge-calibrate.png`
  — fails outright on Windows. Now `paths.forgePath('logs', 'calibrate.png')`.
- `src/errors.js` advised `chmod` on every platform; on `win32` it now suggests
  `icacls` / the Security dialog.

`tests/path-portability.test.js` scans all of `src/` for a literal `/tmp` or
`/var/tmp` string so a new one cannot creep back in.

---

## T6 — Markdown governance · DONE

`docs/MARKDOWN_SCOPE.md` was imported from the `loom` branch. Re-audited against
the tree: it claimed **29** files and listed **nine that do not exist on `main`**
(`AGENTS.md`, `FORGE_PLAN.md`, `SESSION_CONTEXT.md`, `SESSION_TASK.md`,
`summary.md` and four `.audio-backup/*` reports) while omitting
`docs/RELIABILITY.md`. The real number is **21** tracked files.

What the rewrite does:

- Two tables with different authority: 21 tracked files (purpose + boundary,
  each row naming who wins on a conflict) and 5 generated/ignored artifacts,
  each saying why it is not documentation.
- The five governance rules are kept as-is; they were sound.
- It no longer records *enforcement status* anywhere. That is what made it
  wrong: status belongs in `docs/RELIABILITY.md` and this file, and a third copy
  only rots.
- **A test now holds it:** `tests/markdown-scope.test.js` (14) walks the tree,
  requires a row for every `.md`, requires every listed file to exist, and
  checks the stated count against both the table and the disk. Adding a Markdown
  file without a row fails CI. Verified by probe: a stray `docs/DRIFT_PROBE.md`
  fails two assertions.

**Also fixed here:** the contributor test-count policy contradicted itself in
three places (`CONTRIBUTING.md` asked for 10, 3 and 2; the PR template asked for
5). One rule now, stated once in `CONTRIBUTING.md`; the template defers to it,
and the test enforces that.

**Open findings recorded in the inventory (not fixed — different workstreams):**

1. `ROADMAP.md` still says "Current Version: 2.0.0" while `package.json` says
   2.2.0. The milestone list needs a real pass.
2. The HTML site under `docs/*.html` duplicates the user guide and has no
   ownership row or generation rule.
3. `README.md` still reads as a fork of the original project in places.
   Attribution stays (MIT requires it); the framing is its own workstream.

---

## What is next, in order

1. **Loom slice 3** — the dependency graph over `extract` + `resolve`, then the
   digest that compiles it to a token budget. Slices 1-2 are storage and
   extraction only; nothing is wired into the loop yet.
2. **T3 live adapter repair** — blocked on a human with a login. The offline
   contract suite is green; the selectors are unverified against the real UIs.
3. **Coverage uplift** — the gate is 69/61/72/70 against a 70.4/62.7/73.3/71.9
   baseline; raise both together.

## How the six fit together

| Task | Workstream | Main outcome |
| --- | --- | --- |
| T1 | Transport | Reliable, integrity-checked file-content transfer |
| T2 | Loom | Persistent project intelligence |
| T3 | Adapters | Reliable support for the remaining providers |
| T4 | Plan lifecycle | Plans that are generated, persisted, ticked and retained |
| T5 | Cross-platform paths | Windows-compatible path handling |
| T6 | Markdown governance | Complete documentation inventory and ownership |

T1–T3 are implementation workstreams; T4–T6 are plan, platform and documentation
workstreams. They are all still live: none is dropped, and none is "done" without
the evidence above.
