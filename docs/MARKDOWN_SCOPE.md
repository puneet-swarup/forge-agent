# Markdown governance — inventory and ownership

**Audited:** 2026-11-21, against `main` @ `b10bab4`.
Tracked Markdown files: **22**

**Purpose.** Say what every Markdown file in this repository is *for*, who owns
it, and where its authority ends — so a change lands in one place instead of
five, and so a reader knows which file wins when two disagree.

**Kept honest by.** `tests/markdown-scope.test.js`. The inventory, the file tree
and the count above cannot drift apart: a Markdown file added without a row here
fails the suite, and a row naming a file that does not exist fails it too. Re-run
`npx jest tests/markdown-scope.test.js` after touching any Markdown file.

The previous version of this file was imported from an older branch and listed
29 files — 9 of which do not exist on `main` (`AGENTS.md`, `FORGE_PLAN.md`,
`SESSION_CONTEXT.md`, `SESSION_TASK.md`, `summary.md` and four `.audio-backup/*`
reports) — while missing `docs/RELIABILITY.md`. That is exactly the drift the
test now prevents.

---

## The five rules

1. **One purpose per document.** A second document links to the owner instead of
   restating its rules. If you are copying a paragraph, link it.
2. **Code and tests are authoritative.** Prose describes intent; `src/` and
   `tests/` describe behaviour. When they disagree, the code is right and the
   prose is a bug.
3. **Historical records stay historical.** A release note, a phase report or an
   old test count is a record of what was true then. Never read it as status now.
4. **Generated artifacts are not documentation.** A session summary or a live
   plan file is output, not policy. It is listed here so nobody mistakes it for
   documentation, and it is gitignored so it does not arrive in a diff.
5. **Update the owner first, then the summaries.** Change the canonical file,
   then adjust links and one-line mentions elsewhere. Never the reverse.

---

## Tracked inventory (22 files)

| File | Purpose | Authority and boundary |
|---|---|---|
| `README.md` | Public entry point: what the agent is, install, quick start, feature summary. | Owns first-use orientation. Summarises and links; never the full protocol. Verify badges and counts before publishing. |
| `USER_GUIDE.md` | End-user how-to: CLI flags, sessions, commands, workflows, troubleshooting. | Owns user-facing behaviour and workflows. Links to `docs/SPAWN_PROTOCOL.md` for spawn guarantees and `TESTING_PHASE1-4.md` for manual acceptance; does not restate either. |
| `ARCHITECTURE.md` | As-built map: modules, ownership, data and control flow, engineering rationale. | Owns system structure. Source wins on disagreement, then fix this file. Design proposals stay clearly labelled as proposals. |
| `docs/RELIABILITY.md` | The runtime invariants: what is guaranteed, where it is enforced, how to verify it, and what is still missing. | **Canonical reliability record.** One numbered section per invariant, each naming its test. Add a section when a guarantee is added; the "What is still missing" list is part of the contract, not an appendix. |
| `docs/SPAWN_PROTOCOL.md` | Parent/child identity, spawn contract, environment, task handoff, heartbeat, liveness. | **Single canonical normative source for multi-agent spawning.** Any change to spawn behaviour updates this file in the same PR. |
| `docs/session-context-and-multiagent.md` | Design history and rationale for session context, context overflow, TODO workflow and multi-agent coordination. | Conceptual record, not a second protocol. Historical proposals stay labelled historical; current spawn behaviour defers to `docs/SPAWN_PROTOCOL.md`. |
| `docs/LOOM.md` | The Loom project index: what it is, the slice plan, and what is wired into the agent loop today. | **Canonical Loom status.** `src/loom_specs.md` is the normative specification; this file says what exists. Update the slice table in the PR that lands each slice, and never claim a slice is wired before it is. |
| `docs/MARKDOWN_SCOPE.md` | This file: inventory, ownership, overlaps, maintenance rules. | Owns documentation governance. Add a row whenever a Markdown file is added, moved, renamed or removed. |
| `docs/DEVELOPMENT.md` | Developer setup: clone, install, run, test, container workflow. | Owns environment setup. `CONTRIBUTING.md` links here instead of repeating OS-specific steps. |
| `docs/GOOGLE_ADAPTER.md` | Why the Google adapter is built the way it is: feasibility, selector strategy, limitations. | Owns Google-adapter design rationale. Implementation claims must match the adapter and its tests. |
| `docs/LOCAL_AND_COLAB_ADAPTERS.md` | The three self-hosted adapters (local, Ollama, Colab): when to use each, configuration, troubleshooting. | Owns local/remote adapter deployment. Architecture and the user guide link here rather than duplicating settings. |
| `NEXT_SESSION.md` | Developer handoff: workstream order, status with evidence, what is next, known blockers. | Owns current task state. A status is "done" only when its evidence column can be re-run and passes. Not a protocol, not a user guide. |
| `CHANGELOG.md` | Release history in Keep-a-Changelog form. | Owns the release record. Released entries are preserved as written; it is never current setup or support documentation. |
| `ROADMAP.md` | Strategic direction, milestones and future work. | Owns planning. Not a behavioural specification, and not a second changelog. |
| `CONTRIBUTING.md` | Contribution policy: branching, commits, review, test expectations, PR workflow. | Owns contributor policy, including the test-count rule. Delegates setup to `docs/DEVELOPMENT.md`. |
| `CODE_OF_CONDUCT.md` | Community behaviour and enforcement. | Governance only; no engineering overlap. |
| `SECURITY.md` | Vulnerability reporting, supported versions, response policy. | Owns security policy. Verify supported versions against `package.json` and the release notes. |
| `SUPPORTERS.md` | Acknowledgements and ways to support the project. | Recognition and funding only. |
| `TESTING_PHASE1-4.md` | Manual acceptance scenarios for the earlier project phases. | Historical manual guide, not a live test report. Its suite totals are historical; CI is the current verification mechanism. |
| `src/loom_specs.md` | Normative specification for the Loom index: invariants I1–I6, storage, modules, integration points. | **Canonical Loom spec.** Implementation follows it; `ARCHITECTURE.md` summarises and links rather than duplicating the invariants. Lives in `src/` because the implementation is expected beside it. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Structured checklist for a proposed change. | Contributor workflow template. Must agree with `CONTRIBUTING.md`; every path it references must exist. |
| `.github/DISCUSSIONS.md` | GitHub Discussions categories and participation guidance. | GitHub community configuration. |

---

## Generated and ignored artifacts (not documentation)

These are written at runtime. They are listed so a reader can tell output from
policy, and so the drift test can exclude them from the tracked count.

| File | What it is | Why it is not documentation |
|---|---|---|
| `FORGE_PLAN.md` | The agent's step-by-step plan for the task in flight. | Output of one task. Tracked only while active and deleted at sign-off (see the artifact protocol in `README.md`). Never a project plan. |
| `FORGE_TODO.md` | Optional human-authored backlog consumed by `--auto` / `--parallel`. | Gitignored and absent by default. Per-machine state, not policy. |
| `SESSION_CONTEXT.md` | Durable working memory for one session. | Auto-generated and regenerated by the framework; never hand-edited. |
| `SESSION_TASK.md` | Task assignment handed to a child session. | Generated by the spawn machinery; its semantics are owned by `docs/SPAWN_PROTOCOL.md`. |
| `summary.md` | Per-run session summary written to the session directory. | A run record. Retain locally if useful; never cite it as current policy. |

---

## Overlaps, and which file wins

### Spawning and sessions
`docs/SPAWN_PROTOCOL.md` is normative. `docs/session-context-and-multiagent.md`
explains how the design got there and is read as history.
`docs/RELIABILITY.md` §8 describes the guarantees the session context makes.
`USER_GUIDE.md` explains what the user types. Four files, one owner.

### Plans and TODOs
`FORGE_PLAN.md` is the per-session checklist; its lifecycle contract lives in
`src/lifecycle.js` and the enforcement status lives in `docs/RELIABILITY.md` and
`NEXT_SESSION.md`. This inventory deliberately records **no** enforcement status
— that is the drift that made the previous version of this file wrong.

### Development and testing
`docs/DEVELOPMENT.md` owns setup, `CONTRIBUTING.md` owns policy (including the
test-count rule), `.github/PULL_REQUEST_TEMPLATE.md` mirrors that policy and must
not introduce a second, different minimum.

### Architecture and focused specs
`ARCHITECTURE.md` describes structure and links out. `src/loom_specs.md` and
`docs/SPAWN_PROTOCOL.md` own their contracts. The adapter docs own adapter
configuration and limitations. `README.md` and `USER_GUIDE.md` summarise.

### History
`CHANGELOG.md`, `ROADMAP.md` and `TESTING_PHASE1-4.md` are each historical in a
different way — released, planned, and manually verified — and are never merged
into one another.

---

## Findings from this audit

Recorded here so they are not lost; only the first was fixed in the same PR.

- **Fixed — the test-count policy contradicted itself.** `CONTRIBUTING.md` asked
  for "at least 10 tests" for a new feature, "at least 3" in `tests/tools.test.js`
  and "at least 2" for templates, while `.github/PULL_REQUEST_TEMPLATE.md` asked
  for "minimum 5". There is now one rule, stated once in `CONTRIBUTING.md`, and
  the template points at it.
- **Open — `ROADMAP.md` still says "Current Version: 2.0.0"** while
  `package.json` says 2.2.0. The milestone list needs a real pass, not a
  one-word fix, so it is left for the roadmap workstream.
- **Open — the HTML documentation site is out of scope here.** `docs/*.html` is
  a generated-looking site with its own copy of the user guide; this inventory
  covers Markdown only. If it is kept, it needs its own ownership row and a
  generation rule.
- **Open — `README.md` still reads as a fork of the original project** in places.
  Attribution stays (MIT requires it); the framing is a separate workstream,
  already noted in `NEXT_SESSION.md`.

---

## Maintenance checklist

When changing a feature:

1. Update code and tests.
2. Update the canonical protocol or spec if its contract changed
   (`docs/SPAWN_PROTOCOL.md`, `src/loom_specs.md`).
3. Add or amend the invariant in `docs/RELIABILITY.md`, naming its test.
4. Update `USER_GUIDE.md` or `README.md` only for user-visible behaviour.
5. Update `CHANGELOG.md` under Unreleased when preparing a release.
6. Update `NEXT_SESSION.md` only for handoff state — never copy it into the
   architecture docs.

When adding, moving or removing a Markdown file:

1. Add, move or delete its row here, with a purpose and a boundary.
2. Fix the count in the header.
3. Run `npx jest tests/markdown-scope.test.js` — it fails until 1 and 2 are true.
