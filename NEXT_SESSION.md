# NEXT SESSION — Forge Agent workstreams

**Verified:** 2026-11-21, against `main` @ `f534883` (after PRs #3-#8).
**Rule for this file:** implementation and tests are authoritative. A status here
is only "done" if the evidence column can be re-run and passes. Anything carried
over from an earlier handoff is marked *(unverified)* until someone checks it.

Re-verify everything in one pass:

```bash
npm test                                  # suite must be green (2,197 passing / 17 skipped)
npm run typecheck
node scripts/verify-prompt.js             # the prompt the agent actually sends
grep -rn "encodeTransportArg" src/transport.js   # T1
ls src/loom 2>/dev/null                   # T2
npx jest tests/adapter-contract.test.js   # T3
ls scripts/lifecycle.js scripts/plan.js   # T4
grep -rn "['\"\`]/(var/)?tmp/" src/       # T5 (must be empty)
npx jest tests/markdown-scope.test.js     # T6 (inventory matches the tree)
```

---

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
| **T2** | Loom | **NOT STARTED on `main`** | `src/loom/` absent; spec at `src/loom_specs.md` (839 lines, v1) | implement from the spec; own PR |
| **T3** | Adapters | **OPEN — live-DOM accuracy only** | all 8 adapters implement the 6 contract methods; `tests/adapter-contract.test.js` (50) green | per-adapter live smoke test with a real login |
| **T4** | Plan lifecycle | **PARTIAL** | artifact protocol is in the live prompt; `src/lifecycle.js`, `scripts/lifecycle.js`, `scripts/plan.js` exist; context rotation now re-sends the plan on every rotation | enforce start/end gates in the agent loop |
| **T5** | Cross-platform paths | **DONE (targeted)** | no literal `/tmp` in `src/`; `icacls` hints on win32; `tests/path-portability.test.js` green | extend only if a new path bug appears |
| **T6** | Markdown governance | **DONE (re-audit + drift guard)** | `docs/MARKDOWN_SCOPE.md` re-audited: 21 tracked files, 9 stale rows removed, `docs/RELIABILITY.md` added; `tests/markdown-scope.test.js` (9) fails CI when the inventory drifts | none — README rewrite is its own workstream |

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

## T2 — ClickHouse Loom · NOT STARTED on `main`

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

**Prior art, not to be merged:** branch `loom` (commit `0488c62`) carries a
partial storage layer — `config, db, hash, ignore, migrate, paths,
schema/001_init.sql` — but that branch is based on the old `v2.0.2` lineage, not
on `main`. Merging it would delete ~19.7k lines. Its 19 files are all *additions*,
so anything worth keeping can be cherry-picked; the spec is the authority, not
that code.

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

## T4 — Plan lifecycle · PARTIAL

- The artifact protocol (FORGE_PLAN.md created, ticked, deleted only on sign-off)
  is stated in the **live** prompt — it was previously only in the unused one.
- `src/lifecycle.js` defines the artifact contract; `scripts/lifecycle.js`
  implements `check-start` / `check-end`; `scripts/plan.js` provides
  `status / list / tick / next`.
- **Missing:** the agent loop does not call those gates. `TASK_COMPLETE` is not
  refused when `FORGE_PLAN.md` still has unchecked items, and the plan file is not
  created automatically at task start.

Next: call `check-start` before the first mutating tool of a multi-step task and
`check-end` at completion, reusing the verification-gate pattern (refuse, feed
back, bounded attempts).

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

## T6 — Markdown governance · DONE (re-audit + drift guard)

`docs/MARKDOWN_SCOPE.md` was imported from the `loom` branch and had drifted: it
claimed 29 files and listed nine that no longer exist (`AGENTS.md`,
`FORGE_PLAN.md` as a *document*, `SESSION_CONTEXT.md`, `SESSION_TASK.md`,
`summary.md`, and the four `.audio-backup/` reports), while omitting
`docs/RELIABILITY.md`.

The re-audit against `main` @ `b10bab4` found **21 tracked Markdown files**: 11
at the root, 7 under `docs/`, 2 under `.github/` and `src/loom_specs.md`. The
inventory was rewritten around that:

- one row per tracked file, with purpose and maintenance boundary, grouped root /
  `docs/` / `.github/` + `src`;
- a separate table for the runtime artifacts that are gitignored
  (`FORGE_PLAN.md`, `FORGE_TODO.md`, `SESSION_CONTEXT.md`, `SESSION_TASK.md`,
  `summary.md`) — rule 4 requires them to be *identified*, not documented as
  policy;
- removed rows are recorded in one sentence, not kept as history: git is the
  archive;
- a sixth rule: adding, moving or deleting a Markdown file is one commit with
  its row here.

**The inventory can no longer drift.** `tests/markdown-scope.test.js` (9 tests)
reads the document as text and fails when a tracked `.md` has no row, when a row
names a file that does not exist, when a path is duplicated or absolute, when the
stated total disagrees with the tree, or when a generated artifact appears in the
tracked table. Verified both ways: adding an undocumented `docs/tmp-drift.md`
fails two tests.

**One conflict fixed while auditing it.** The test-count policy had three
different numbers: `CONTRIBUTING.md` demanded "at least 10 tests" for a new
feature, its own tool section said 3, and `.github/PULL_REQUEST_TEMPLATE.md` said
5 for features and 3 for tools. `CONTRIBUTING.md` is now the single owner of one
policy (feature 5, tool 3, template 2, bug fix a regression test) and the PR
template mirrors it.

**Recorded, not fixed here** (owner files, separate changes): `ROADMAP.md` still
says "Current Version: 2.0.0" against `package.json` 2.2.0, and `README.md`
states the plan gates are "Enforced by" `scripts/lifecycle.js` while `main`'s
loop does not call them — PR #9 closes that gap and owns the wording.

Related, and separate: the README still reads as a fork of the original project.
That is its own workstream — accurate attribution stays (MIT requires it), but
the document should describe *this* agent.

---

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
