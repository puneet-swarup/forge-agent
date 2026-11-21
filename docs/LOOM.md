# Loom — implementation status

Loom is Forge Agent's persistent project index: files, symbols, dependency
edges and one-line purposes, stored inside the project, compiled into a small
digest that goes into the model's first prompt. The normative specification is
[`src/loom_specs.md`](../src/loom_specs.md) (v1). **The spec is the authority for
design decisions; this page is the authority for what exists today.**

Loom ships in slices. Each slice is one pull request, and each one is usable on
its own — nothing is added to the agent loop until the layer beneath it is
tested.

| Slice | Scope | Status |
| --- | --- | --- |
| 1 | Storage foundation: config, paths, hashing, ignore rules, driver (SQLite + JSON fallback), migrations, schema, `open`/`close`/`status`/`stats` | **done** (`src/loom/`) |
| 2 | Extractors (`extract/js.js`, `py.js`, `go.js`, `rs.js`, `sql.js`, `md.js`, `data.js`), `findBlockEnd`, import resolution | **done** (`src/loom/extract/`, `src/loom/resolve.js`) |
| 3 | Indexer: refresh sweep, git short-circuit, dirty flag, worker, tombstones, access rows, caps and warm-up order | not started |
| 4 | Digest compiler, `recall` / `whats_here` / `related`, heat, summaries, portable export | not started |
| 5 | Agent-loop integration: attach/reattach after `newChat`, `loom.around()` in the tool dispatcher, `search_codebase`, `--loom` CLI, chaos tests | not started |

## What slice 2 provides

```
src/loom/extract/
  index.js     registry: extension → { lang, module }; extract(text, relPath)
  blocks.js    line helpers and findBlockEnd (the character scanner)
  js.js        .js .mjs .cjs .jsx .ts .tsx
  py.js        .py
  go.js        .go
  rs.js        .rs
  sql.js       .sql
  md.js        .md
  data.js      .json .yaml .yml .toml
src/loom/resolve.js   import specifier → project-relative path
```

`extract(text, relPath)` returns `{ symbols, imports, loc, partial, lang,
supported }`. Every symbol is `{name, kind, line_start, line_end, signature,
exported, parent, doc, confidence}` with 1-indexed inclusive lines; every import
is `{specifier, kind}` with `kind ∈ require|import|from|use|mod`. An extension
the registry does not know is not an error: it returns `supported: false` so the
caller can store `parse_state='skipped'`.

**The scanner is the part that matters.** `findBlockEnd` walks characters in the
states the spec names — code, single quote, double quote, template, line
comment, block comment — plus a **regex** state, which the spec does not list.
Without it, `.replace(/"/g, '')` opens a string that never closes and the scan
runs to EOF. On this repository that was the difference between 16 files marked
`partial` and 5. Regex-vs-division is decided the usual way: a `/` starts a
regex when the previous significant character cannot end an expression
(`( , = : [ ! & | ? { } ; + - * % < > ~ ^`) or the previous word is a keyword
such as `return`, `typeof` or `await`.

Two spec behaviours are worth knowing before reading a `line_end`:

- **The 400-line cap.** A block that has not closed within 400 lines returns
  `line_end = min(start + 40, loc)`, `confidence: 0.4`, `partial: true`. That is
  deliberate: a range Loom cannot measure is never served as if it had been
  measured, and 0.4 is below the digest's 0.70 symbol threshold. In this
  repository five files contain a block longer than 400 lines
  (`src/adapters/base-adapter.js`, `src/adapters/local-chat-adapter.js`,
  `src/agent.js`, `src/index.js`, `src/tui.js`); all five are marked partial.
  A consequence worth stating: a method's `parent` is the enclosing class *by
  line range*, so methods that fall outside a placeholder range get no parent.
- **`partial` is per file, not per symbol.** One unmeasurable block marks the
  file, which is what the indexer will use to decide that the file's structure
  is untrustworthy.

Python has no braces, so its ranges come from indentation (the first following
non-blank line at or left of the declaration). Its known limitation is recorded
in `extract/py.js`: a triple-quoted string containing a column-0 line, or a
column-0 comment inside a function body, ends the block early. Rust scans with
`lifetimes: true` so `&'a str` does not open a character literal, and Go with
`interpolation: false` so a raw string is not read as a template.

### Import resolution

`resolve.js` follows the spec exactly: `./`, `../`, `/`, `@/` and `~/` are
local; everything else is external with `resolved: null`. Root markers are
stripped to the project root, and candidates are tried in order — the bare path,
then `.js .mjs .cjs .jsx .ts .tsx`, then `index.<ext>` of the same six. The first
existing file wins; nothing that would escape the project is ever a candidate,
and `tsconfig.json` `paths` are deliberately not read in v1. Existence is
injectable (`opts.exists`), so the graph can be rebuilt against a file list
without touching the disk.

## What slice 1 provides

```
src/loom/
  index.js     public API + error boundary (open, close, status, stats, db, config)
  config.js    LOOM_* parsing; never throws; invalid values warn and fall back
  paths.js     project-relative normalisation, project id, index location, .gitignore
  hash.js      sha256 helpers and the mtime/size fast negative
  ignore.js    hard deny, secret deny, and a minimal .gitignore matcher
  db.js        table-oriented store; node:sqlite when present, JSON otherwise
  migrate.js   schema versioning, checksums, meta seeding, access retention
  schema/001_init.sql
  log.js       debug/warn/info that cannot throw
```

Three properties are already enforced and covered by tests:

- **I1 — nothing throws into a tool handler.** `index.js` catches every failure,
  logs it at debug level, and returns a neutral value. A store that cannot be
  created disables Loom for the run instead of failing the task.
- **I2 — `LOOM_ENABLED=0` does no I/O.** `open()` returns before the first `fs`
  call; no `.forge/loom` directory is created.
- **I6 — every stored path is project-relative with forward slashes.** Path
  normalisation is the only place that knows about `path.sep`, and absolute or
  escaping paths are rejected rather than rewritten.

### The two backends

`node:sqlite` is experimental and absent from Node 20, which `package.json`
still supports (`engines: >=20`). So the JSON store is not a degraded mode — on
Node 20 it is *the* mode. Both backends implement the same table-oriented
interface (`insert`, `update`, `remove`, `where`, `replaceWhere`, `all`, `get`,
`count`), because a JSON file cannot execute SQL and a second dialect would
drift from the schema. `migrate.js` branches on `db.kind` for DDL only.

The JSON store is one file, written atomically (`.tmp` + `rename`) and debounced
by 500 ms; `close()` always writes synchronously.

### Failure behaviour

| Condition | What happens |
| --- | --- |
| `LOOM_ENABLED=0` | No I/O at all; `open()` returns `{skipped:true}` |
| `node:sqlite` missing | JSON store, same interface |
| Corrupt store | Renamed to `index.json.bad` / `index.db.bad`, rebuilt; `dbRebuilds` counts it |
| Unknown schema version | Rebuild (the index is derivable, never authoritative) |
| Migration checksum mismatch | Rebuild, warn |
| Project directory not writable | Index moves to `~/.forge-agent/loom/<project-id>/` |
| Store cannot be created | Loom disabled for the run; the task continues |

## Deviations from the spec, and why

- **Test runner.** The spec decides `node:test` for `tests/loom/`. The suite here
  is **jest**, like the other 127 suites: CI runs `npm test` (jest) over
  `tests/**/*.test.js`, so node:test files in that directory would either fail
  jest or need a second CI job to run a suite jest already covers. One runner,
  one report.
- **`log.js`.** The spec's module list has no logging module; `src/logger.js`
  has no `debug`. A three-function wrapper keeps Loom's diagnostics quiet and
  unable to throw, instead of adding a `debug` method to the shared logger.
- **Keyed inserts are upserts.** The spec's `imports` table has no primary key
  and `meta`/`migrations`/`summaries` are keyed by identity, so `insert()` with a
  caller-supplied key replaces the row in both backends. That is what the
  migration runner and the JSON store need, and it keeps the two backends
  behaviourally identical.

## Verifying

```bash
npx jest tests/loom                 # 254 passed, 2 skipped (SQLite, absent on Node 20)
npm run typecheck
```

Slice 2 adds `tests/loom/extract.test.js` (66) and `tests/loom/resolve.test.js`
(26). Two of the extractor tests run over `src/` itself: every source file is
scanned without throwing and every range is inside the file, which is how the
scanner is kept honest against the code it has to read.

The two skipped tests are the SQLite backend. They run wherever `node:sqlite`
loads (Node >= 22.5 with `--experimental-sqlite`, Node >= 23.4 without), and
skip elsewhere by design rather than passing without exercising anything.
