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
| 2 | Extractors (`extract/js.js`, `py.js`, `go.js`, `rs.js`, `sql.js`, `md.js`, `data.js`), `findBlockEnd`, import resolution | not started |
| 3 | Indexer: refresh sweep, git short-circuit, dirty flag, worker, tombstones, access rows, caps and warm-up order | not started |
| 4 | Digest compiler, `recall` / `whats_here` / `related`, heat, summaries, portable export | not started |
| 5 | Agent-loop integration: attach/reattach after `newChat`, `loom.around()` in the tool dispatcher, `search_codebase`, `--loom` CLI, chaos tests | not started |

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
npx jest tests/loom                 # 162 passed, 2 skipped (SQLite, absent on Node 20)
npm run typecheck
```

The two skipped tests are the SQLite backend. They run wherever `node:sqlite`
loads (Node >= 22.5 with `--experimental-sqlite`, Node >= 23.4 without), and
skip elsewhere by design rather than passing without exercising anything.
