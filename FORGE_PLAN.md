# FORGE_PLAN - terminal step-communication cleanup (2026-11-05)

> Protocol: tick each step only after its gate. One commit per phase. Baseline
> green: `node scripts/run-jest.js` + `node scripts/check-syntax.js --all` +
> `npm run typecheck`. DELETED at the end after user confirms.
>
> Tick: `node scripts/plan.js tick <n>` | status: `node scripts/plan.js status`

## Goal

Fix two CLI display annoyances reported by the user:
1. The per-tool display is confusing: `Step N — desc` divider, then a `⚡ tool`
   preview line, then a `✓ tool result` line that repeats the tool name.
2. The final answer prints twice (raw content + completion box).

Make the per-step output clean: one action line, one result line (no name
repetition), and the answer shown exactly once.

---

## Phase P1 - tool step lines (de-duplicate)

- [x] P1.1 renderToolCall: drop the separate `⚡` preview when a step divider
      already preceded it; instead the result line carries the outcome.
- [x] P1.2 renderToolResult: show ONLY the result text (indented, glyph ✓/✗),
      no repeated tool name.
- [x] P1.3 Gate: tui tests green; visual smoke via a scripted render.

## Phase P2 - single answer render

- [x] P2.1 Remove the duplicate `console.log(content)` in the TUI branch of
      agent.js so the answer is shown once (via logger.answer/finalOutput).
- [x] P2.2 Gate: full suite green; no regression in answer/format tests.

## Phase P3 - docs + finish

- [x] P3.1 CHANGELOG entry under [Unreleased] -> Fixed.
- [x] P3.2 Full suite + syntax + typecheck green; commit; ask user to confirm
      deletion of this FORGE_PLAN.md.
