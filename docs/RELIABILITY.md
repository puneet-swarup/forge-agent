# Reliability invariants

This document describes the guarantees Forge Agent makes at runtime, where each
one is enforced, how to verify it, and which ones are still missing. It exists
because the agent's failures used to be described only in prose scattered across
the code and the changelog — and because several guarantees were once claimed
here without existing in the code at all.

**Rule for this document:** every invariant names the module that enforces it
and a test that fails if the invariant is broken. If you add a claim, add a test.

Run everything referenced here with:

```bash
npm test                       # full suite
node scripts/verify-prompt.js  # the prompt contract the agent actually sends
```

---

## 1. The turn boundary is measured

**Invariant.** A reply is accepted only after the transcript has changed since
the message was sent. The adapter never returns the previous reply.

**Enforced by.** `src/adapters/base-adapter.js`

1. `sendMessage()` captures a baseline before typing: how many replies exist,
   and a hash of the last one.
2. `waitForResponse()` waits for that transcript to change. If nothing changes
   within `APPEAR_TIMEOUT`, it throws a retryable error marked
   `turnBoundary: 'appear'` — it does **not** fall back to the last reply.
3. Completion then comes from the first of: the `<<<FORGE_END>>>` marker (with
   one settle poll for trailing characters), idle text with a stopped
   generator, or the response timeout.
4. `_lastCompletionSignal` records which one fired (`marker` / `idle`), which is
   the metric that tells you whether the model is honouring the envelope.

**Verify.** `tests/turn-boundary.test.js`, `tests/adapter-turn-contract.test.js`
(no browser needed), and two cases in `tests/integration-browser.test.js` that
run against a mock chat page with a delayed and a dropped reply.

**Watch.** If `idle` dominates in traces, the model is ignoring the envelope and
`STABLE_DELAY` is doing the work.

---

## 2. One contract, and the model is told it

**Invariant.** There is exactly one system prompt, it is the one the agent
sends, and everything the runtime enforces is stated in it.

**Enforced by.** `src/system-prompt.js` (the only builder). `src/prompt.js`
owns conversation state and re-exports it. `scripts/verify-prompt.js` validates
the message `agent.js` actually builds and fails if a second builder appears.

**Verify.** `tests/prompt-single-source.test.js` — asserts `prompt.js` re-exports
the same function, that no other module embeds a prompt, and that the message
contains the envelope, the single call format, `TASK_COMPLETE`, the artifact
protocol, and every registered tool.

**Note.** The artifact protocol (`FORGE_PLAN.md` etc.) is enforced by
`scripts/lifecycle.js`. It used to be absent from the prompt the model received,
which made the gate unfair. The two must stay in sync; the test above asserts
the prompt side.

---

## 3. A stalled chat restarts with its contract

**Invariant.** Restarting a chat preserves the system prompt, the task, the
plan, the progress and the recent errors.

**Enforced by.** `DeepSeekAgent._recoverWithNewChat()` →
`ConversationManager.buildResumeMessage()`, which re-sends the full prompt.

**The ladder** (in `agent.js`), each level reachable and bounded:

| Streak | Action |
| --- | --- |
| 1 … `EMPTY_RESPONSE_THRESHOLD-1` | nudge: ask the model to continue |
| `EMPTY_RESPONSE_THRESHOLD` … | restart the chat with the contract, up to `MAX_CHAT_RECOVERIES` (default 2) |
| `PARTIAL_RESULT_THRESHOLD` | give up: capture diagnostics, return a partial summary |

Before 2.2.0 the restart level was unreachable: its guard required "no progress
since the last failure", but a successful response — the only thing that raises
the tool-call count — also resets the streak, so the loop always took the abort
branch first.

**Verify.** `tests/recovery.test.js`.

---

## 4. Nothing secret leaves the machine unredacted

**Invariant.** Tool output is scanned for high-confidence secret shapes before
it is sent to the chat UI.

**Enforced by.** `security.redactSecrets()`, applied in `agent._forEgress()` on
both egress paths (single call and batch).

**Scope.** PEM private-key blocks, `sk-`/`sk-ant-`/`sk-proj-`, `AKIA`/`ASIA`,
`gh[pousr]_`, `xox[baprs]-`, `AIza`, `sk_live_`/`sk_test_`, JWTs, credential
assignments (`apiKey: "…"`, `PASSWORD=…`) and secret `.env` lines.

**Deliberately not redacted.** Long hex strings and generic base64. They appear
in hashes, lockfile integrity fields and assets; redacting them corrupts code
the model is editing, and the model would write the placeholder back.

**Known trade-off.** If a model rewrites a file that contained a secret it may
write back `[REDACTED]`. The workspace snapshot restores the original; sending
the secret to a third party is worse.

**Verify.** `tests/secret-redaction.test.js` — one case per shape, an end-to-end
run proving a key in `config.js` never reaches the browser, and a negative corpus
(a real source file, hashes, integrity strings) asserting zero redactions.

---

## 5. Writes are atomic, reversible and guarded

**Invariant.** No file operation can leave a truncated file, silently destroy
content the agent has not seen, or become unrecoverable.

**Enforced by.** `src/workspace.js`, used by `write_file`, `write_files`,
`append_to_file`, `replace_in_file` and `delete_file`; `read_file` records what
it showed the model.

| Guarantee | Mechanism |
| --- | --- |
| Atomic | write to `.name.forge-tmp-<pid>`, `fsync`, `rename` over the target |
| Reversible | pre-image copied to `~/.forge-agent/snapshots/<project>/<path>.bak` on first mutation |
| Read-before-write | refused unless the file's **current** content hash has been seen this session |
| Diff | capped unified diff returned with every write |

The hash matters: a file changed by `run_command` or a `git checkout` no longer
matches what the agent read, so the write is refused until it reads again.

Restore from a later process:

```bash
forge-agent --snapshots          # what can be restored
forge-agent --rollback src/a.js  # restore it
```

**Scope note.** The snapshot is a **session baseline** — the state before the
agent first touched the file — so `--rollback` undoes the session's work on that
file rather than one step.

**Verify.** `tests/workspace.test.js` (20 cases) and the write/overwrite cases in
`tests/tools.test.js`.

---

## 6. Runs are bounded

**Invariant.** A run cannot exceed its step, wall-clock or tool-call budget, and
exceeding one ends the run with a report rather than a crash or a hang.

**Enforced by.** `src/budget.js`, ticked at the top of every iteration in
`agent.js`.

| Config / flag | Default | Meaning |
| --- | --- | --- |
| `MAX_ITERATIONS` / `--max-iterations` | 100 | loop iterations |
| `MAX_RUNTIME_MS` / `--max-runtime` | 0 (off) | wall clock; accepts `90`, `90m`, `30s`, `2h` |
| `MAX_TOOL_CALLS` / `--max-tool-calls` | 0 (off) | executed tool calls |

Exceeding a limit logs the reason, writes a partial summary (files written,
commands run, errors), records history as `timeout` and returns.

**Verify.** `tests/budget.test.js`.

---

## 7. Prose is not a program

**Invariant.** Only a well-formed call to a registered tool executes. An
illustration, a code sample or a data structure is never executed.

**Enforced by.** `src/parser.js` (`parseResponse(text, { toolNames })`) and
`agent.js`, which passes the registry.

- A fenced block tagged with a data language (`json`, `js`, `python`, …) is an
  illustration unless it is the entire response.
- Fenced content is excluded from the bare-JSON scan, so an example cannot be
  executed on a second pass.
- Bare JSON whose `name` is not a registered tool is prose; the scanner skips it
  and keeps looking.
- An unknown name in a `<tool_call>` block returns `invalid_tool` with the
  nearest real name (edit distance ≤ 2, then prefix), and a batch containing an
  unknown name executes nothing.
- The agent answers with one line — "There is no tool called `read_fle`. Did you
  mean `read_file`?" — instead of dumping the 45-tool registry.

**Verify.** `tests/protocol-validation.test.js`.

---

## 8. Session context is durable and re-fed

**Invariant.** `SESSION_CONTEXT.md` is created at task start, kept out of git,
and injected when a chat restarts.

**Enforced by.** `DeepSeekAgent._sessionCtxStart()` / `_sessionCtxSnapshot()`,
`src/session-context.js`, and `buildResumeMessage({ sessionContext })`.

**Verify.** `tests/session-context-wiring.test.js`.

---

## 9. Throttling is handled when it happens

**Invariant.** The agent does not pay a fixed delay per prompt. It backs off
only when the provider signals a limit, and stops after a bounded number of
attempts.

**Enforced by.** `src/throttle.js`, wired into the loop in `agent.js` before the
reply is parsed — a throttle notice is transport, not an answer, and must not
count as a protocol violation.

| Signal | Examples |
| --- | --- |
| Hard | "too many requests", "sending messages too quickly", "usage/daily limit reached", "you've reached your limit", "temporarily unavailable", 请求过于频繁 |
| Soft (needs an error-ish co-signal) | "rate limit", "try again later", "slow down" |

The two tiers exist so an agent *writing about* rate limiting does not back off
on its own answer.

Backoff: `RATE_LIMIT_BASE_MS` (5 s) × 2 per attempt, capped at
`RATE_LIMIT_MAX_MS` (60 s), `RATE_LIMIT_MAX_ATTEMPTS` (4) before the run ends
with a partial summary. A normal reply resets the budget.

`PROMPT_PAUSE` — the old fixed 10–20 s pause before every prompt — still exists
and is **off** by default; `--prompt-pause` turns it back on.

**Verify.** `tests/throttle.test.js` — signal corpus, negative corpus (including
an answer that merely mentions rate limiting), exponential growth and cap,
reset, and three end-to-end loop cases.

## 10. Arguments are integrity-checked

**Invariant.** When a tool argument carries a hash, the bytes are verified
before use, and a mismatch aborts the operation. A mangled payload never reaches
the disk.

**Enforced by.** `src/transport.js` — `encodeTransportArg` / `decodeTransportArg`
with base64 **or** hex encoding and an MD5 over the decoded bytes. Wired into
`write_file`, `append_to_file`, `write_files` (`content_md5`) and
`replace_in_file` (`find_md5`, `replace_md5`).

| Case | Behaviour |
| --- | --- |
| hash matches | write proceeds, result says `integrity verified` |
| hash mismatches | throws, **nothing written** |
| hash malformed | throws (not silently ignored) |
| no hash | legacy path: base64/hex round-trip check only |

**Honest limitation.** The hash must be computed by the sender. For an LLM that
is reliable on short strings and unreliable on large files, so a match is proof
the payload survived the channel; the absence of a hash means no end-to-end
proof, only the encoding's own round-trip check. The prompt asks the model to
include a hash only when it is certain of the value, because a wrong hash blocks
a legitimate write.

**Verify.** `tests/transport-integrity.test.js` — round-trips (plain, base64,
hex, 10 KB of random bytes), tampered payload refused with nothing written,
malformed hash refused, legacy signature preserved, and per-tool coverage of all
four call sites.

## 11. Completion is verified

**Invariant.** `TASK_COMPLETE` is refused when the project's own check fails.

**Enforced by.** `src/verify.js` + the gate at the top of the completion branch in
`agent.js`.

- Detection is declarative: `package.json` scripts (`typecheck` → `lint` → `test`),
  a `Makefile` `check`/`test` target, `pyproject.toml`/`pytest.ini` → `pytest -q`,
  `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`.
- Only the first declared check runs — cheapest first. The command is never
  assembled from model output.
- On failure the output goes back to the model as a tool result and the loop
  continues, up to `MAX_VERIFICATION_ATTEMPTS` (default 2). After that the gate
  steps aside rather than looping.
- No declared check → the run is reported **unverified**, not verified, in the
  run summary (`Verification:` line).
- Timeout `VERIFY_TIMEOUT_MS` (default 120 s); output capped at 4 KB.

**Verify.** `tests/verify-gate.test.js` — detection per ecosystem, the npm
"no test specified" default, timeout handling, honest wording, and three
end-to-end loop cases (refused, accepted, disabled).

## 12. The shell is governed

**Invariant.** A command that can destroy data irreversibly never runs; a
command the policy does not recognise requires the user; and the child process
cannot read the operator's credentials.

**Enforced by.** `src/shell-policy.js`, used by `tools.js` (`run_command`) and
`agent.js` (`_needsPermission`).

| Verdict | Meaning | Effect |
| --- | --- | --- |
| `allow` | allowlisted development binary (`npm`, `git status`, `ls`, `pytest`, `make`, `cd`, …) | runs, no prompt |
| `confirm` | unrecognised binary, or known-destructive (`git push`, `git reset --hard`, `git clean`, `rm -rf`, `find -delete`, nested shells) | the permission menu asks |
| `deny` | irreversible — root deletes, `mkfs`, `dd` to a device, fork bomb, `chmod -R 777 /`, download piped into a shell, force-push to `main` | never runs |

Deny rules are evaluated against the **whole command line**, so quoting and pipes
cannot hide the shape (`echo start && rm -rf /` is still denied). The allowlist is
deliberately narrow and inspectable; `SHELL_POLICY=strict` denies unknown
binaries outright, `SHELL_POLICY=off` steps aside (the legacy blocklist still
applies unless `ALLOW_DANGEROUS_COMMANDS` is set).

**Environment.** `run_command` builds the child's environment from an allowlist
(`PATH`, `HOME`/`USERPROFILE`, `SystemRoot`, `TEMP`, `LANG`, …) and drops any
variable whose name matches a credential pattern — including ones the model asks
for explicitly. `SHELL_ENV_SCRUB=false` restores inheritance.

**Verify.** `tests/shell-policy.test.js` (55) — allow/confirm/deny corpora,
quoting and pipe evasion, `strict` mode, segment and binary parsing (including a
quoted Windows path), environment scrubbing, an end-to-end `run_command` proving
a secret in `process.env` is absent from the child, and the prompt-skipping rule.

## What is still missing

Honest list of gaps this release does **not** close. Each one has a test-shaped
hole; none is hidden behind a passing suite.

2. **Local context compression is bookkeeping.** The model's real context lives
   in the remote chat; `ConversationManager.compress()` rewrites a local log
   that is never re-sent. Deliberate rotation every N turns is the fix.
3. **The shell guard is a blocklist.** `security.BLOCKED_COMMANDS` is six
   substrings; `run_command` inherits the full `process.env`. An allowlist with
   a scrubbed environment is the fix.
4. **No provenance on untrusted content.** `read_url` output is fed to the model
   without a "this is data, not instructions" marker.
5. **Selector drift is untested.** The browser tests drive a mock page built from
   the adapter's own selectors, so they cannot detect a change in the real UI.
   Recorded-DOM fixtures are the fix.
6. **The transport hash depends on the sender.** See §10: the model computing an
   MD5 for a large file is not something to rely on.
7. **The CLI is still one large file.** Flags are parsed by a hand-written loop;
   the new flags follow that pattern deliberately rather than growing a second
   one.
