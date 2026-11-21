# Markdown Documentation Inventory and Ownership

**Audit date:** 2026-11-21 (follow-up verification)  
**Purpose:** Define the responsibility and authority of every Markdown file in this repository, identify functional overlap, and establish maintenance boundaries.

## Documentation rules

1. A document should have one clearly defined purpose. Other documents should link to it rather than reproduce its detailed instructions or rules.
2. Implementation and tests are authoritative for actual runtime behavior. Normative protocol documents define intended contracts; user guides explain how to use those contracts.
3. Historical records remain historical. Do not treat old test counts, release notes, archived reports, or design proposals as current implementation status.
4. Generated session artifacts are not permanent documentation and must be identified as such.
5. Update the canonical owner when behavior changes, then update summaries or links in other documents only as needed.

## Repository Markdown inventory

The audited inventory contains **29 Markdown files outside `node_modules`**: 16 at the repository root, 6 under `docs/`, 2 under `.github/`, 4 under `.audio-backup/`, and 1 at `src/loom_specs.md`. This count includes generated session artifacts and archived reports; it does not imply that all 29 are maintained normative documentation. `node_modules` documentation is excluded.

| File | Scope and function | Authority / maintenance boundary |
|---|---|---|
| `AGENTS.md` | Repository-specific instructions for agents working in this checkout. | Operational instructions for task planning, verification, preservation, and user confirmation. Keep aligned with actual repository workflow. |
| `FORGE_PLAN.md` | Active execution checklist for the current repository task/session. | User-visible source of truth for task status. Mark complete only after verification; retain until explicit user confirmation permits deletion. |
| `docs/MARKDOWN_SCOPE.md` | Inventory of Markdown files, their ownership, overlaps, and maintenance rules. | Canonical documentation-governance inventory. Update when files are added, moved, removed, or change role. |
| `README.md` | Public project introduction, installation, quick start, feature summary, and first-use orientation. | Public entry point. Keep concise; link to `USER_GUIDE.md`, `ARCHITECTURE.md`, and focused docs. Do not duplicate detailed protocols. Verify badges and counts before publishing. |
| `USER_GUIDE.md` | End-user CLI reference and practical workflows, including sessions, commands, task management, and troubleshooting. | Canonical user-facing how-to. Explain workflows, not internal protocol implementation. Link to `docs/SPAWN_PROTOCOL.md` for exact spawn guarantees and `TESTING_PHASE1-4.md` only for manual acceptance procedures. |
| `ARCHITECTURE.md` | As-built component map, module ownership, system design, data/control flow, and engineering rationale. | Architecture reference. Source code wins for actual behavior. Link to canonical protocol and adapter docs instead of restating their rules. Keep design proposals clearly labeled as proposals. |
| `ROADMAP.md` | Strategic direction, milestones, and future work. | Planning document, not a behavioral specification. Mark completed items and date-sensitive targets accurately; do not duplicate the changelog. |
| `CHANGELOG.md` | Chronological release history and notable changes. | Historical record. Preserve released entries; do not use it as current setup, protocol, or support documentation. Add an Unreleased section only when project release practice calls for it. |
| `CONTRIBUTING.md` | Contribution standards, code review expectations, tests, commits, and pull request workflow. | Canonical contributor policy. Delegate detailed platform setup to `docs/DEVELOPMENT.md`. Keep test-count requirements consistent with the PR template. |
| `CODE_OF_CONDUCT.md` | Community behavior and enforcement expectations. | Governance document. No functional overlap with engineering protocols. |
| `SECURITY.md` | Vulnerability reporting, supported versions, and security response policy. | Canonical security policy. Verify supported versions and implementation claims against current releases and code. |
| `SUPPORTERS.md` | Acknowledgements and ways to support the project. | Community recognition and funding information. No protocol authority. |
| `TESTING_PHASE1-4.md` | Manual feature acceptance scenarios and hands-on verification guidance for earlier project phases. | Historical/manual test guide, not a live test report. Avoid fixed claims about current suite totals; automated tests and CI are the current verification mechanisms. |
| `NEXT_SESSION.md` | Persistent developer handoff: task order, known state, hazards, and next-session acceptance criteria. | Active handoff only. It is not the general protocol or user guide. Update status after verified work; preserve unfinished tasks. |
| `SESSION_CONTEXT.md` | Runtime-generated session context and working memory. | Ephemeral generated artifact. Not a permanent specification; do not manually turn it into a second handoff or protocol. |
| `SESSION_TASK.md` | Runtime-generated task assignment and progress context for a child/worker session. | Ephemeral task metadata. Its spawn lifecycle and required semantics are governed by `docs/SPAWN_PROTOCOL.md`. |
| `src/loom_specs.md` | Detailed implementation specification for the Loom index, invariants, modules, storage, and integration points. | Normative Loom engineering spec. Keep implementation aligned with it; architecture may summarize and link to it but should not duplicate its detailed invariants. |
| `docs/DEVELOPMENT.md` | Developer environment setup, installation, and local development workflow. | Canonical development setup guide. `CONTRIBUTING.md` should link here rather than repeat OS-specific setup. |
| `docs/GOOGLE_ADAPTER.md` | Google adapter design rationale, selector strategy, feasibility, and known limitations. | Adapter-specific design/limitations. Keep implementation claims synchronized with the Google adapter and its tests. |
| `docs/LOCAL_AND_COLAB_ADAPTERS.md` | Local Ollama/OpenAI-compatible and remote Colab adapter configuration and troubleshooting. | Adapter-specific deployment guide. Link from architecture and user guide; do not duplicate all settings in those documents. |
| `docs/SPAWN_PROTOCOL.md` | Parent/child identity, spawn contract, environment, task handoff, heartbeat, liveness, and lifecycle semantics. | **Single canonical normative source for multi-agent spawning.** Other docs must link here for exact spawn rules. Update this file whenever spawn behavior changes. |
| `docs/session-context-and-multiagent.md` | Explanatory design history and rationale for session context, context overflow, TODO workflows, and multi-agent coordination. | Conceptual/design note, not a second spawn protocol. Mark historical proposals as historical and defer current spawn behavior to `SPAWN_PROTOCOL.md`. |
| `summary.md` | Generated summary of an individual run/session. | Generated artifact, not maintained project documentation. Retain only if useful as a run record; do not cite it as current policy. |
| `.github/DISCUSSIONS.md` | GitHub Discussions categories and community participation guidance. | GitHub community configuration documentation. No overlap with runtime protocols. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Structured checklist for proposed changes, testing, tools, templates, and docs. | Contributor workflow template. Must agree with `CONTRIBUTING.md`; references to documentation pages must point to files that actually exist. |
| `.audio-backup/FINAL-STATUS.md` | Historical handoff/status for the audio-tools work. | Archived project record. Not current task state or current test status. |
| `.audio-backup/PHASE0-REPORT.md` | Historical repository reconnaissance and earlier implementation baseline. | Archived research record. Preserve as history; do not treat old findings as current. |
| `.audio-backup/PHASE1-REPORT.md` | Historical audio-tools phase report. | Archived implementation record. Preserve as history; do not use its test counts as current. |
| `.audio-backup/PR-DESCRIPTION.md` | Historical pull request description for the audio-tools change. | Archived PR artifact. Not a current contribution policy or implementation specification. |

## Functional overlap and resolution

### Multi-agent and session lifecycle

- `docs/SPAWN_PROTOCOL.md` owns the normative spawn contract.
- `docs/session-context-and-multiagent.md` is conceptual/design history, not a second normative protocol. Its header now labels it historical/proposal material; verify individual claims against current source. `docs/SPAWN_PROTOCOL.md` remains authoritative for spawn behavior.
- `USER_GUIDE.md` owns user-facing command/workflow explanations. It should link to the spawn protocol rather than repeat heartbeat, identity, environment, or liveness rules.
- `SESSION_CONTEXT.md` and `SESSION_TASK.md` are runtime artifacts with different purposes; neither replaces the persistent developer handoff `NEXT_SESSION.md`.

### Plans and TODOs

- `FORGE_PLAN.md` is the per-session execution checklist and verification record. Lifecycle helpers and prompt guidance exist, but runtime enforcement is incomplete; documentation must not imply every agent run is gated by the plan.
- `FORGE_TODO.md` is gitignored and absent by default, but remains a supported optional user/project task queue. Startup `--auto` and `--parallel` consume its open items; do not imply that the historical `/todo` slash command is currently available without confirming it in the active command registry.
- `FORGE_PLAN.md` remains the active per-session execution checklist. User documentation should explain only active workflows and link to implementation details where appropriate.

### Development and testing

- `docs/DEVELOPMENT.md` owns environment setup and local development commands.
- `CONTRIBUTING.md` owns contribution policy and review expectations; link to DEVELOPMENT for setup details.
- `.github/PULL_REQUEST_TEMPLATE.md` mirrors the contributor checklist and must not introduce conflicting minimum test counts.
- `TESTING_PHASE1-4.md` remains a manual acceptance guide. Its old suite totals are labelled historical; direct readers to the current automated test command/CI for live verification.

### Architecture and focused specifications

- `ARCHITECTURE.md` describes system-level structure and ownership.
- `docs/SPAWN_PROTOCOL.md` and `src/loom_specs.md` own their respective detailed normative contracts.
- Adapter-specific docs own configuration, rationale, and limitations for their adapters.
- `README.md` and `USER_GUIDE.md` summarize and link; they should not become alternate specifications. The README's duplicate practical spawn example and stale test-count claims have been corrected. Its artifact table now distinguishes the optional, supported `FORGE_TODO.md` task queue (gitignored and absent by default) from the active `FORGE_PLAN.md` execution checklist; `PENDING_WORK.md` is removed.

### Historical and generated records

- `CHANGELOG.md`, `ROADMAP.md`, and `.audio-backup/*` serve distinct historical/planning purposes and should not be merged.
- `SESSION_CONTEXT.md`, `SESSION_TASK.md`, and `summary.md` are generated artifacts; do not use them as permanent sources of truth.

## Verified repository constraints from this audit

- `package.json` declares Node.js `>=20.0.0`.
- `.github/workflows/ci.yml` tests Node 20 and 22. `CONTRIBUTING.md` and `USER_GUIDE.md` should therefore state a consistent minimum of Node 20 (unless package support or CI is deliberately changed).
- The PR template currently says five tests for new features but three tests for new tools, while the contributor guide has a different minimum. These requirements must be reconciled into one clear policy; avoid arbitrary per-file counts unless justified by test scope.
- `TESTING_PHASE1-4.md` is a manual historical guide. Its old suite totals are now explicitly labelled historical, its Node matrix points to current CI (20/22 at this audit), and its legacy container session path now points readers to `src/paths.js` and the `.forge-agent` default.
- `CHANGELOG.md` contains release history and old historical test claims; preserve those in their release context.

## Maintenance checklist

When changing a feature:

1. Update code and tests.
2. Update the canonical protocol/specification if its contract changed.
3. Update the focused operational guide if user configuration or workflow changed.
4. Update `USER_GUIDE.md` or `README.md` only for user-visible behavior and navigation.
5. Update `CHANGELOG.md` for the release record when preparing a release.
6. Update `NEXT_SESSION.md` only for persistent handoff state; do not copy it into permanent architecture docs.

This inventory records the 29 Markdown files found outside `node_modules` during the 2026-11-21 audit. Re-run the inventory when adding, moving, or removing Markdown files; distinguish maintained documentation from generated and archived records.
