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
| 2 | Extractors (`extract/*.js`), `findBlockEnd`, import resolution (`resolve.js`), dependency graph (`graph.js`) | **done** |
| 3 | Digest compiler (`digest.js`, §8 budget and §7 heat) and attach to the first message (`attach.js`) | **done** |
| 4 | Indexer: refresh sweep, dirty flag, tombstones, access rows, role drift, caps; the digest now reads the store | **done** (`refresh.js`) — git short-circuit deferred, see below |
| 5 | Query and prose: `recall` / `whats_here` / `related` (`query.js`), model summaries (`summarize.js`), portable export; then `loom.around()` in the tool dispatcher, reattach after `newChat`, `--loom` CLI, chaos tests | not started |

## What slice 4 provides

```
src/loom/
  refresh.js   the incremental sweep, the dirty flag, tombstones, access rows
```

`refresh({ db, root, env })` is the whole indexer:

1. collect the candidates — the same walk `attach.js` used, now one shared list
   (`collectCandidates`), filtered through `ignore.js` (hard deny, secret deny,
   `.gitignore`) and capped by `LOOM_MAX_FILES`;
2. per candidate, `stat`; a missing file is tombstoned, `statMatches` is the fast
   negative, otherwise the hash decides;
3. index the changed ones: `files` row, then `symbols` and `imports` replaced
   wholesale, plus the §6.1 heuristic summary;
4. re-index everything when churn crosses `LOOM_REBUILD_THRESHOLD`;
5. recompute `importers_sig` (§5.6 role drift) and rebuild the graph.

Reading back: `filesForGraph(db)` returns rows in the shape `graph.buildGraph`
takes, and `readGraph(db, opts)` is the graph itself. A summary is only included
when its `sha` matches the file's current content and it is not role-stale —
prose is never served stale (I3).

Access is what the index is for: `recordAccess(db, relPath, 'read'|'write'|
'edit'|'search_hit')` writes a row, `accessRows(db)` returns them in the shape
`renderDigest` takes, and the digest's §7 heat then ranks the files the agent
actually touched above their alphabetical neighbours.

### Deliberate deviation: no git short-circuit

§5.3 narrows the candidate set with three `git` calls. This implementation stats
every candidate instead: the same answer, no subprocess, no 3 s timeout, no
dependency on git being installed. The §5.1 fast negative is what keeps that
cheap, and the §5.5 dirty flag still forces a full rehash when a tool could have
changed bytes without changing mtime.

### Rebuilds keep their ids

A rebuild re-indexes every candidate rather than dropping the tables, and reuses
the row matched on `rel_path`. File ids stay stable, so the `access` rows that
point at them — and the heat they carry — survive a rebuild instead of being
silently orphaned.

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
npx jest tests/loom                 # 354 passed, 2 skipped (SQLite, absent on Node 20)
npx jest tests/loom/refresh.test.js # 20 — the sweep, the dirty flag, access, role drift
npm run typecheck
```

The two skipped tests are the SQLite backend. They run wherever `node:sqlite`
loads (Node >= 22.5 with `--experimental-sqlite`, Node >= 23.4 without), and
skip elsewhere by design rather than passing without exercising anything.
