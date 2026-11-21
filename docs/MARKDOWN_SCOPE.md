# Markdown Documentation Inventory and Ownership

**Audit date:** 2026-11-21 (re-audit against `main` @ `b10bab4`, after PRs #3–#8).
**Enforced by:** `tests/markdown-scope.test.js` — the inventory fails CI when a
Markdown file is added without a row here, or a row outlives its file.
**Purpose:** Define the responsibility and authority of every Markdown file in
this repository, identify functional overlap, and establish maintenance
boundaries.

## Documentation rules

1. A document should have one clearly defined purpose. Other documents should link to it rather than reproduce its detailed instructions or rules.
2. Implementation and tests are authoritative for actual runtime behavior. Normative protocol documents define intended contracts; user guides explain how to use those contracts.
3. Historical records remain historical. Do not treat old test counts, release notes, archived reports, or design proposals as current implementation status.
4. Generated session artifacts are not permanent documentation and must be identified as such.
5. Update the canonical owner when behavior changes, then update summaries or links in other documents only as needed.
6. The inventory is checked in CI. Adding, moving or deleting a Markdown file is one commit with its row here.

## Repository Markdown inventory

**21 tracked Markdown files**: 11 at the repository root, 7 under `docs/`,
2 under `.github/`, and 1 at `src/loom_specs.md`. Generated session artifacts are
listed separately below and are not part of this count.

### Root

| File | Scope and function | Authority / maintenance boundary |
|---|---|---|
| `README.md` | Public project introduction, installation, quick start, feature summary, first-use orientation. | Public entry point. Keep concise; link to `USER_GUIDE.md`, `ARCHITECTURE.md` and focused docs. Do not duplicate detailed protocols. Badges and counts must be verified before publishing. |
| `USER_GUIDE.md` | End-user CLI reference and practical workflows: sessions, commands, task management, troubleshooting. | Canonical user-facing how-to. Explains workflows, not internal protocol implementation. Links to `docs/SPAWN_PROTOCOL.md` for exact spawn guarantees and to `TESTING_PHASE1-4.md` only for manual acceptance procedures. |
| `ARCHITECTURE.md` | As-built component map, module ownership, system design, data/control flow, engineering rationale. | Architecture reference; source code wins for actual behavior. Links to the normative documents instead of restating their rules. Design proposals stay labelled as proposals. |
| `ROADMAP.md` | Strategic direction, milestones, future work. | Planning document, not a behavioral specification. Do not duplicate the changelog. **Stale:** still states "Current Version: 2.0.0" while `package.json` is 2.2.0 — fix belongs in this file. |
| `CHANGELOG.md` | Chronological release history and notable changes. | Historical record. Preserve released entries; never cite it as current setup, protocol or support documentation. New work lands under `## [Unreleased]`. |
| `CONTRIBUTING.md` | Contribution standards, review expectations, tests, commits, pull-request workflow. | Canonical contributor policy, including the single test-count policy (see *Development and testing*). Delegates platform setup to `docs/DEVELOPMENT.md`. |
| `CODE_OF_CONDUCT.md` | Community behavior and enforcement expectations. | Governance document. No engineering overlap. |
| `SECURITY.md` | Vulnerability reporting, supported versions, security response policy. | Canonical security policy. Verify supported versions and implementation claims against current releases and code. |
| `SUPPORTERS.md` | Acknowledgements and ways to support the project. | Community recognition and funding information. No protocol authority. |
| `NEXT_SESSION.md` | Persistent developer handoff: workstream table (T1–T6), verified state, evidence commands, next action per item. | Active handoff only — not a protocol, user guide or architecture doc. Read by the autonomous roadmap runner; update status only after the evidence command passes. |
| `TESTING_PHASE1-4.md` | Manual feature acceptance scenarios for earlier project phases. | Historical/manual test guide, not a live test report. Its suite totals are historical; automated tests and CI are the current verification mechanism. |

### `docs/`

| File | Scope and function | Authority / maintenance boundary |
|---|---|---|
| `docs/MARKDOWN_SCOPE.md` | This inventory: ownership, overlap, maintenance rules, drift enforcement. | Canonical documentation-governance inventory. Update whenever a Markdown file is added, moved, removed or changes role. |
| `docs/RELIABILITY.md` | Runtime guarantees: turn boundary, single prompt, recovery, redaction, workspace safety, budgets, parser validation, throttling, transport integrity, verification gate, path portability, shell policy, context rotation, plan gate. | Canonical for runtime invariants. Every invariant names the module that enforces it and the test that fails if it breaks; a claim without a test is not allowed. |
| `docs/SPAWN_PROTOCOL.md` | Parent/child identity, spawn contract, environment, task handoff, heartbeat, liveness, lifecycle semantics. | **Single canonical normative source for multi-agent spawning.** Other documents link here for exact spawn rules. Update whenever spawn behavior changes. |
| `docs/DEVELOPMENT.md` | Developer environment setup, installation, local development workflow. | Canonical development setup guide. `CONTRIBUTING.md` links here rather than repeating OS-specific setup. |
| `docs/GOOGLE_ADAPTER.md` | Google adapter design rationale, selector strategy, feasibility, known limitations. | Adapter-specific design and limitations. Keep implementation claims synchronized with the adapter and its tests. |
| `docs/LOCAL_AND_COLAB_ADAPTERS.md` | Local Ollama/OpenAI-compatible and remote Colab adapter configuration and troubleshooting. | Adapter-specific deployment guide. Link from architecture and user guide rather than duplicating settings there. |
| `docs/session-context-and-multiagent.md` | Explanatory design history for session context, context overflow, TODO workflows, multi-agent coordination. | Conceptual/design note, not a second spawn protocol. Historical proposals stay historical; current spawn behavior defers to `docs/SPAWN_PROTOCOL.md`. |

### `.github/` and `src/`

| File | Scope and function | Authority / maintenance boundary |
|---|---|---|
| `.github/PULL_REQUEST_TEMPLATE.md` | Structured checklist for proposed changes: type, testing, tools, templates, docs. | Contributor workflow template. Must agree with `CONTRIBUTING.md` — same test-count policy, and documentation links must point at files that exist. |
| `.github/DISCUSSIONS.md` | GitHub Discussions categories and community participation guidance. | GitHub community configuration. No runtime overlap. |
| `src/loom_specs.md` | Implementation specification for the Loom project index: invariants I1–I6, module layout, storage, extractors, digest, integration points. | Normative Loom engineering spec (v1). Implementation follows it; `docs/LOOM.md` (arriving with PR #10) tracks delivery status, and neither may contradict the other. |

## Generated artifacts — not permanent documentation

These are written at runtime, are gitignored, and must never be cited as policy
or as current status. They are listed here because rule 4 requires them to be
identified.

| Artifact | Written by | Lifecycle |
|---|---|---|
| `FORGE_PLAN.md` | The agent at the start of a multi-step task | Tracked *while a task is active* and deleted in a dedicated commit on user sign-off (see `.gitignore`). It is the live execution checklist, not a project document. |
| `FORGE_TODO.md` | Optional user/project task queue | Gitignored, absent by default. Consumed by startup `--auto` / `--parallel`. |
| `SESSION_CONTEXT.md` | Runtime session working memory | Gitignored. Never a second handoff or protocol. |
| `SESSION_TASK.md` | Parent → child task assignment | Gitignored. Its semantics are owned by `docs/SPAWN_PROTOCOL.md`. |
| `summary.md`, `summary.json` | Per-run summary in the session directory | Gitignored run record. Not documentation. |

**Removed since the previous audit:** `AGENTS.md`, `FORGE_PLAN.md` as a *tracked
document*, `SESSION_CONTEXT.md`, `SESSION_TASK.md`, `summary.md` and the whole
`.audio-backup/` directory (`FINAL-STATUS.md`, `PHASE0-REPORT.md`,
`PHASE1-REPORT.md`, `PR-DESCRIPTION.md`) are no longer tracked files. Their rows
are gone from the inventory rather than kept as history — git history is the
archive. **Added since:** `docs/RELIABILITY.md`.

## Functional overlap and resolution

### Multi-agent and session lifecycle

- `docs/SPAWN_PROTOCOL.md` owns the normative spawn contract.
- `docs/session-context-and-multiagent.md` is conceptual/design history, not a second normative protocol. Verify individual claims against current source.
- `USER_GUIDE.md` owns user-facing command/workflow explanations and links to the spawn protocol rather than repeating heartbeat, identity, environment or liveness rules.
- Generated artifacts never replace the persistent handoff `NEXT_SESSION.md`.

### Plans and TODOs

- `FORGE_PLAN.md` is the per-session execution checklist and verification record. On `main` the lifecycle helpers (`src/lifecycle.js`, `scripts/lifecycle.js`, `scripts/plan.js`) exist and the prompt states the protocol, but the agent loop does not yet call the gates — PR #9 closes that gap. **Until it merges, no document may claim every run is gated by the plan**; `README.md` currently says "Enforced by `node scripts/lifecycle.js check-end`", which overstates `main`.
- `FORGE_TODO.md` is gitignored and absent by default but remains a supported optional task queue. Do not imply the historical `/todo` slash command is available without confirming it in the active command registry.

### Development and testing

- `docs/DEVELOPMENT.md` owns environment setup and local development commands.
- `CONTRIBUTING.md` owns contribution policy and review expectations, and is the single owner of the test-count policy: **new feature — at least 5 tests; new tool — at least 3 in `tests/tools.test.js`; new template — at least 2 in `tests/templates.test.js`; bug fix — a regression test that fails without the fix.** `.github/PULL_REQUEST_TEMPLATE.md` mirrors that policy and must not introduce different numbers. (The previous audit found three different minima across the two files; they are now one policy.)
- `TESTING_PHASE1-4.md` remains a manual acceptance guide; direct readers to CI for live verification.

### Architecture, reliability and focused specifications

- `ARCHITECTURE.md` describes system-level structure and ownership.
- `docs/SPAWN_PROTOCOL.md`, `src/loom_specs.md` and `docs/RELIABILITY.md` own their respective detailed contracts: spawning, the Loom index, and runtime guarantees.
- Adapter documents own configuration, rationale and limitations for their adapters.
- `README.md` and `USER_GUIDE.md` summarize and link; they must not become alternate specifications.

## Verified repository constraints from this audit

- `package.json` declares Node.js `>=20.0.0`; `.github/workflows/ci.yml` tests Node 20 and 22. Contributor and user documents must state Node 20 as the minimum unless support or CI is deliberately changed.
- No document may state a fixed suite total as current. The authoritative number is the run in CI; `README.md`, `CHANGELOG.md` and `TESTING_PHASE1-4.md` carry historical figures that must stay in their release context.
- `docs/*.html` is the published site and is outside this inventory; it is not a Markdown source of record.
- `ROADMAP.md` is stale (2.0.0 vs 2.2.0) and `README.md` overstates plan-gate enforcement on `main` (PR #9). Both are recorded here as owner-file fixes, not silently edited by unrelated changes.

## Maintenance checklist

When changing a feature:

1. Update code and tests.
2. Update the canonical protocol/specification if its contract changed.
3. Update the focused operational guide if user configuration or workflow changed.
4. Update `USER_GUIDE.md` or `README.md` only for user-visible behavior and navigation.
5. Update `CHANGELOG.md` for the release record when preparing a release.
6. Update `NEXT_SESSION.md` only for persistent handoff state; never copy it into architecture documents.
7. If you added, moved or deleted a Markdown file, update this inventory in the same commit — `tests/markdown-scope.test.js` fails otherwise.
