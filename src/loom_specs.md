Loom — Implementation Specification
Version 1 · Status: ready for implementation · Target: forge-agent, Node.js ≥ 22.5
This document is self-contained. An implementer should not need to make design decisions. Where a choice exists, it is made here and marked DECIDED.
0. Scope
0.1 What is built
A persistent, incremental index of the project's files, symbols, dependency edges and purpose summaries, stored inside the project, compiled into a small text digest that is injected into the model's first prompt so subsequent sessions do not re-read files for orientation.
0.2 What is not built
No external database, daemon, network service, or new npm dependency.
No embeddings or vector search.
No file-body archive. Structure only.
No replacement for read_file. Exact text always comes from disk.
0.3 Invariants (merge blockers)
#
Invariant
I1
No Loom call throws into a tool handler or rejects a promise the agent awaits.
I2
LOOM_ENABLED=0 makes every public API a no-op with zero I/O and zero allocation beyond the call frame.
I3
The digest never presents a symbol line range derived from superseded file content.
I4
Loom never modifies any file under src/adapters/.
I5
Loom never sends a prompt to a non-dedicated model.
I6
All stored paths are project-relative with forward slashes. No absolute paths in the DB or portable export.
1. Integration surface
Exactly three touch points. Nothing else in the existing codebase changes.
1.1 Orchestrator — context injection
BaseAdapter.setProjectContext(context) already exists and stores _projectContext. BaseAdapter.sendMessage() already prepends it when _isFirstMessage is true. Do not edit base-adapter.js.
js
// orchestrator, after adapter construction, before first sendMessage()
const adapter = getAdapter(modelName, page, config);

await loom.open({ root: process.cwd(), session: sessionId });
await loom.refresh();

const digest = await loom.digest();
adapter.setProjectContext(digest);
loom.writeSessionContext(digest);   // §9.3
Re-injection rule. newChat() sets _isFirstMessage = true in both BaseAdapter and every overriding adapter. Therefore after any newChat() call the orchestrator must repeat:
js
await adapter.newChat();
adapter.setProjectContext(await loom.digest());
Provide a helper loom.attach(adapter) that performs setProjectContext + writeSessionContext, and call it at both sites. This is the only reason the orchestrator needs to know about newChat.
1.2 Tool dispatcher — indexing middleware
All project file I/O happens in tools. Adapters perform browser I/O only and never read project files. One wrapper covers the entire surface:
js
// tool dispatcher
const result = await loom.around(toolName, args, () => dispatch(toolName, args));
Contract for around:
If disabled → return invoke().
Run pre-hook inside try/catch. Swallow all errors, increment counters.hookErrors.
const result = await invoke() — outside any Loom try/catch. Tool errors propagate untouched.
Run post-hook inside try/catch. Swallow all errors.
return result unchanged.
Loom must never alter, wrap, delay, or suppress a tool's result or error.
1.3 search_codebase — internal refactor
Change its implementation to read Loom's symbols and loom_fts tables instead of re-scanning the filesystem. Keep its existing signature, ranking semantics and return shape. Fall back to the current filesystem scan when Loom is disabled or unavailable.
1.4 Hook matrix
Tool
Pre
Post
read_file
—
Passive index from returned content; access(op='read', lines=n)
write_file, write_files
—
Reindex each path; capture intent note (§6.5); access(op='write')
append_to_file, replace_in_file, patch_file
—
Reindex path; intent note; access(op='edit')
move_file
—
Rewrite rel_path; repair imports.resolved; access(op='edit')
copy_file
—
Index destination as new file
delete_file
—
Tombstone (deleted=1), cascade symbols/imports/summary
list_directory, find_files
—
Inventory rows only (parse_state='skipped'), no parse
get_file_info
—
Update mtime_ms, bytes
search_in_files, search_codebase
—
access(op='search_hit') per returned path
git_diff, git_status, git_log
—
markDirty()
run_command
—
markDirty() — see §5.5
spawn_agent
Inject LOOM_PROJECT_ID, LOOM_SESSION into child env
—
all others
—
—
read_file returns bounded sections. Index the whole file on first passive touch by reading it once from disk inside the post-hook (one fs.readFile, not a tool call). Subsequent partial reads only add access rows. This avoids storing half-parsed files.
2. Module layout
src/loom/
  index.js          public API, error boundary, counters
  config.js         env parsing + validation
  db.js             driver selection, pragmas, FTS probe
  migrate.js        migration runner
  schema/
    001_init.sql
  paths.js          rel-path normalization, project id
  hash.js           stat fast path, sha256
  ignore.js         deny list + .gitignore
  extract/
    index.js        registry, dispatch by extension
    js.js           .js .mjs .cjs .jsx .ts .tsx
    py.js           .py
    go.js           .go
    rs.js           .rs
    sql.js          .sql
    md.js           .md
    data.js         .json .yaml .yml .toml
  resolve.js        import specifier → rel_path
  graph.js          edge rebuild, importers_sig, role drift
  summarize.js      heuristic + model queue
  refresh.js        sweep, git short-circuit, dirty state
  heat.js           scoring
  digest.js         budget compiler
  query.js          recall / whats_here / related
  portable.js       export / import
  worker.js         bulk indexing worker
  watch.js          optional fs watcher
  cli.js            --loom subcommands
tests/loom/
  fixtures/
  *.test.js
DECIDED: test runner is node:test + node:assert/strict. No new dependencies. Run via node --test tests/loom/.
3. Storage
3.1 Location
<project>/.forge/loom/
  index.db
  index.db-wal
  index.db-shm
  portable.json      (optional, generated on demand)
  .gitignore
On open(), create .forge/loom/.gitignore if absent with exactly:
index.db
index.db-wal
index.db-shm
*.bad
Never modify an existing .gitignore. Never touch the project root .gitignore.
Fallback. If the project directory is not writable (fs.accessSync(root, fs.constants.W_OK) throws), use ~/.forge-agent/loom/<project-id>/index.db and log once at info. project-id = sha256(path.resolve(root)).slice(0,16).
The DB contains only relative paths (I6), so copying .forge/loom/index.db between machines works directly.
3.2 Driver
js
// src/loom/db.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA foreign_keys = ON');
    return { kind: 'sqlite', db, fts: probeFts(db) };
  } catch (err) {
    logger.debug(`[Loom] sqlite unavailable: ${err.message}`);
    return { kind: 'json', file: file.replace(/\.db$/, '.json'), fts: false };
  }
}

function probeFts(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)");
    db.exec("DROP TABLE temp.__fts_probe");
    return true;
  } catch { return false; }
}
node:sqlite is experimental in Node 24. The JSON fallback is mandatory, not optional.
JSON fallback capabilities: full digest, whats_here, related, write-through, refresh. recall degrades to weighted substring scan. Persist the whole store as one JSON file, written atomically (.tmp + rename), debounced 500 ms.
DatabaseSync is synchronous. Bulk indexing runs in worker_threads (§3.4). Only single-file write-through executes inline.
3.3 Schema — schema/001_init.sql
sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT NOT NULL UNIQUE,
  lang          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  content_sha   TEXT NOT NULL,
  loc           INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL,
  parse_state   TEXT NOT NULL DEFAULT 'ok',
  importers_sig TEXT NOT NULL DEFAULT '',
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_state ON files(parse_state, deleted);
CREATE INDEX idx_files_sha   ON files(content_sha);

CREATE TABLE symbols (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end   INTEGER NOT NULL,
  signature  TEXT NOT NULL DEFAULT '',
  exported   INTEGER NOT NULL DEFAULT 0,
  parent     TEXT NOT NULL DEFAULT '',
  doc        TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.6
);
CREATE INDEX idx_sym_name ON symbols(name);
CREATE INDEX idx_sym_file ON symbols(file_id, line_start);

CREATE TABLE imports (
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  resolved  TEXT,
  kind      TEXT NOT NULL
);
CREATE INDEX idx_imp_file     ON imports(file_id);
CREATE INDEX idx_imp_resolved ON imports(resolved);

CREATE TABLE summaries (
  file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  source      TEXT NOT NULL,
  sha         TEXT NOT NULL,
  base_conf   REAL NOT NULL,
  made_at     INTEGER NOT NULL,
  role_stale  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE access (
  id      INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  session TEXT NOT NULL,
  op      TEXT NOT NULL,
  lines   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_access_file ON access(file_id, ts);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  scope      TEXT NOT NULL,
  text       TEXT NOT NULL,
  origin     TEXT NOT NULL,
  sha_at     TEXT NOT NULL DEFAULT '',
  made_at    INTEGER NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_notes_scope ON notes(scope);

CREATE TABLE migrations (
  version  INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  run_at   INTEGER NOT NULL
);
FTS table, created only when fts === true:
sql
CREATE VIRTUAL TABLE loom_fts USING fts5(
  rel_path, symbol_names, purpose, content=''
);
loom_fts.rowid equals files.id. Rebuild the row on every reindex: DELETE FROM loom_fts WHERE rowid=? then INSERT.
Seed meta: schema_version='1', project_id, forge_version, built_at, full_rehash_at.
Access retention: on open(), DELETE FROM access WHERE ts < now - 90 days.
3.4 Worker protocol
worker.js receives { type:'bulk', root, files:[{rel_path,bytes,mtime_ms}], dbFile }, opens its own connection (WAL permits this), parses in batches of 50, and posts { type:'batch', rows } back. The main thread writes rows. On worker error or 30 s timeout, fall back to inline indexing capped at 200 files and log at debug.
4. Indexing
4.1 Ignore rules — ignore.js
Hard deny, evaluated before .gitignore:
node_modules/  .git/  dist/  build/  out/  coverage/  .next/  .nuxt/
__pycache__/  .venv/  venv/  target/  vendor/  .forge/
*.min.js  *.map  *.lock  package-lock.json  yarn.lock  pnpm-lock.yaml
*.png *.jpg *.jpeg *.gif *.webp *.ico *.pdf *.zip *.gz *.tar *.woff *.woff2
*.ttf *.eot *.mp4 *.mp3 *.wav *.so *.dll *.dylib *.exe *.bin *.pyc
Secret deny — never index, never summarize, regardless of any setting:
.env  .env.*  *.pem  *.key  *.p12  *.pfx  id_rsa*  id_ed25519*
*credentials*  *secret*  *.keystore
Then apply .gitignore if present. Implement a minimal matcher supporting *, **, ?, leading /, trailing /, and ! negation. Do not add a dependency.
Caps: LOOM_MAX_FILES=2000, LOOM_MAX_FILE_BYTES=512000. Over-cap files get a files row with parse_state='skipped', loc counted, no symbols.
Warm-up ordering when the cap binds: entry points first, then files already in access, then shallowest paths, then alphabetical. Deterministic.
4.2 Extractor interface
js
/**
 * @param {string} text
 * @param {string} relPath
 * @returns {{
 *   symbols: Array<{name,kind,line_start,line_end,signature,exported,parent,doc,confidence}>,
 *   imports: Array<{specifier,kind}>,
 *   loc: number,
 *   partial: boolean
 * }}
 */
function extract(text, relPath)
kind ∈ function|class|method|const|type|export|heading|table|key.
imports[].kind ∈ require|import|from|use|mod.
Lines are 1-indexed, inclusive.
4.3 JS/TS extractor — extract/js.js
Patterns, applied in order, all with gm:
kind
regex
conf
class
^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)
0.95
function
^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)
0.95
method
^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{
0.80
const-fn
^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>
0.90
const-upper
^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=
0.85
type
^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)
0.90
Exclude names matching ^(if|for|while|switch|catch|return|function|constructor)$ from method. Set parent to the nearest enclosing class name by brace depth.
Imports:
require\(\s*['"]([^'"]+)['"]\s*\) → require
^\s*import\s+(?:[^'"]*\sfrom\s+)?['"]([^'"]+)['"] → import
^\s*export\s+[^'"]*\sfrom\s+['"]([^'"]+)['"] → import
Exports: match module\.exports\s*=\s*\{([^}]*)\}, split on ,, take the identifier before any :. Also exports\.([A-Za-z_$][\w$]*)\s*=. Mark matching symbols exported=1. Symbols on lines starting with export are already exported=1.
doc: nearest preceding /** … */ first sentence, or // line, ≤160 chars, else ''.
signature: the matched source line, trimmed, ≤200 chars.
4.4 findBlockEnd — required algorithm
Character scanner over the file from the start line. States: code | single | double | template | line_comment | block_comment. Handle \ escapes in all string states. ${ inside template pushes a nested code state with its own depth.
Scan forward from line_start until the first { in code state. Increment depth.
Continue; { in code increments, } decrements.
When depth returns to 0, return that line number.
If 400 lines are scanned without balancing, or EOF is reached: return min(line_start + 40, loc), set confidence = 0.4, set partial = true.
Do not use a naive brace counter. Braces inside strings and comments are common in this codebase (see the selector strings in qwen-adapter.js).
4.5 Other extractors
Ext
Symbols
Imports
.py
^\s*(?:async\s+)?def\s+(\w+) (0.95), ^\s*class\s+(\w+) (0.95). Block end by indentation: first subsequent non-blank line with indent ≤ def's indent.
^\s*from\s+([\w.]+)\s+import → from; ^\s*import\s+([\w.]+) → import
.go
^func\s+(?:\([^)]*\)\s*)?(\w+) (0.95), ^type\s+(\w+) (0.9). Brace scanner.
import\s+"([^"]+)" and block form → import
.rs
^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+) (0.95), ^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+) (0.9)
^\s*use\s+([\w:]+) → use; ^\s*mod\s+(\w+) → mod
.sql
CREATE\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+) → table (0.9)
none
.md
^(#{1,3})\s+(.+)$ → heading, name = text (0.95)
none
.json/.yaml/.toml
top-level keys only → key (0.9)
none
Unregistered extensions: files row with parse_state='skipped', loc counted, no symbols.
4.6 Import resolution — resolve.js
if specifier starts with '.' or '/' or '@/' or '~/' → local candidate
else → external, resolved = NULL
Strip @/ and ~/ to project root. Try in order, first existing file wins:
p
p.js  p.mjs  p.cjs  p.jsx  p.ts  p.tsx
p/index.js  p/index.mjs  p/index.cjs  p/index.ts  p/index.tsx
If none exist, resolved = NULL and the import is treated as external. Do not read tsconfig.json paths in v1.
5. Freshness
5.1 Two tiers
DECIDED: structure and prose have different validity rules.
Structure (symbols, imports, ranges)
Prose (summaries.purpose)
On content change
Regenerate immediately, synchronously
Mark stale, regenerate lazily
Cost
~2 ms
0 ms heuristic / seconds if model
May be served stale
Never (I3)
Never — omitted instead
5.2 refresh() algorithm
1. if disabled → return {skipped:true}
2. candidates = gitCandidates() ?? allIndexedFiles()
3. for each candidate:
     stat fails → tombstone
     st.mtimeMs === row.mtime_ms && st.size === row.bytes → unchanged (fast negative)
     else sha = sha256File()
       sha === row.content_sha → update mtime_ms/bytes only
       else → changed
4. if dirtyFlag → candidates = allIndexedFiles() (ignore git)
5. if (changed + gone) / total > LOOM_REBUILD_THRESHOLD → full rebuild
6. reindex(changed)        // parse + structural write + heuristic summary invalidation
7. rebuildGraph()          // §5.6
8. queueLazySummaries()
9. clear dirtyFlag; update meta.built_at
10. return {changed, gone, rebuilt, elapsedMs}
mtime is a fast negative only. Equal mtime and size ⇒ assume unchanged. A mismatch is a candidate, never proof of change — git checkout, rsync, Docker copies and cross-filesystem moves rewrite mtime without altering bytes. Hash decides.
5.3 Git short-circuit
git rev-parse --is-inside-work-tree
git diff --name-only HEAD
git ls-files --others --exclude-standard
git diff --name-only --diff-filter=D HEAD
Union, normalized to rel-paths, filtered by ignore.js. Any git failure → return null and fall back to full stat sweep. Timeout 3000 ms per command.
5.4 Full rehash
Same-size/same-mtime/different-bytes is possible with deliberate mtime preservation. Force a full hash sweep when:
--loom verify is run, or
now - meta.full_rehash_at > 7 days on open().
5.5 Dirty flag
run_command can mutate arbitrary files (npm install, git pull, formatters) and no post-hook can enumerate them. After every run_command, git_diff, git_status, git_log → markDirty().
While dirty, the next refresh(), recall(), whats_here() or digest() performs a full stat sweep first. This is mandatory; without it the index silently rots.
5.6 Role drift — graph.js
After reindex, for every file compute:
js
importers_sig = sha256(
  db.all("SELECT DISTINCT f.rel_path FROM imports i JOIN files f ON f.id=i.file_id
          WHERE i.resolved=? AND f.deleted=0 ORDER BY f.rel_path", [relPath])
    .map(r => r.rel_path).join('\n')
).slice(0, 16);
If importers_sig changed while content_sha did not, the file's role changed. Set summaries.role_stale = 1. This is computed from the imports table without re-reading the file.
5.7 Confidence
js
function proseConfidence(s, f, neighborChurn) {
  if (s.sha !== f.content_sha) return 0;              // hard gate
  const ageDays = (Date.now() - s.made_at) / 86400000;
  return s.base_conf
    * Math.exp(-ageDays / 60)
    * (s.role_stale ? 0.5 : 1)
    * (neighborChurn > 0.3 ? 0.7 : 1);
}
neighborChurn = fraction of files in the same directory whose content_sha changed in this refresh.
Digest inclusion thresholds: symbols ≥ 0.70, prose ≥ 0.50. Below threshold, omit the element; never serve it degraded-but-unlabelled.
5.8 Optional watcher — watch.js
Enabled by LOOM_WATCH=1, default 0. fs.watch(root, {recursive:true}) works on Windows and macOS; on Linux fall back to per-directory watchers for directories containing indexed files, capped at 200. Debounce 300 ms per path, then markDirty(). Never let a watcher error escape.
6. Summaries
6.1 Heuristic (default)
Deterministic template, no model call:
{role} {primaryClause}{exportClause}{importClause}
role from path: src/adapters/* → "Model adapter."; src/* → "Core module."; tests/* → "Tests."; docs/* → "Documentation."; root config → "Configuration."; else "Module."
primaryClause from leading doc comment, else from the dominant symbol kind.
exportClause = Exports: a, b, c. (max 6, exported only, conf ≥ 0.7)
importClause = Used by N files. when N ≥ 2
Hard cap 240 chars, truncate at a word boundary. source='heuristic', base_conf=0.70.
Worked example, this repo:
src/adapters/base-adapter.js — Model adapter. Shared base class for model adapters. Exports: BaseAdapter. Used by 8 files.
6.2 Model-assisted (opt-in)
LOOM_MODEL_SUMMARIES=0 by default. When enabled:
js
const { getModelInfo } = require('../adapter-factory');
const info = getModelInfo(process.env.LOOM_SUMMARY_MODEL || 'ollama');
if (info.dedicated !== true) {
  logger.warn('[Loom] Refusing non-dedicated summary model; using heuristic.');
  return heuristic(file);
}
Do not hard-code model names. Resolve through the registry and gate on dedicated. Today local, ollama, colab are dedicated; deepseek, qwen, chatgpt, gemini, google are not. Shared public UIs carry anti-block pacing (_sendDelayMs() returns SEND_DELAY for them) and background traffic would throttle the agent's real work. This is invariant I5, enforced in code.
Queue: max 20 files per session, 1 concurrent request, 30 s timeout each, base_conf=0.85, source='model'. Failures fall back to heuristic silently.
6.3 Invalidation
On content_sha change: delete the summaries row, write a heuristic replacement immediately, and enqueue for model refresh only if enabled. Never block on a model.
6.4 Digest degradation
When prose is absent or below threshold:
- src/adapter-factory.js (129L) — Exports: getAdapter, getModelUrl,
  getModelDisplayName, getModelInfo, resolveModelName, SUPPORTED_MODELS.
  (purpose pending re-index)
6.5 Intent capture at write time
The highest-trust summary source. When the agent writes a file, the tool call carries the task context. In the post-hook for mutating tools, insert:
js
notes.insert({
  scope: relPath,
  text: `${op}: ${reasonFromTaskContext}`.slice(0, 200),
  origin: 'agent',
  sha_at: newContentSha,
  verified: 1
});
Intent recorded at authoring is more reliable than intent inferred later. Cap 3 agent notes per file, evict oldest.
6.6 Notes are not hash-keyable
A note asserts behavior that other files can invalidate. On refresh, for each note with scope != 'project': if the scoped file's content_sha != notes.sha_at, set verified = 0. Digest renders these with a (unverified) suffix. Project-scope notes never auto-expire.
7. Heat
js
const OP_WEIGHT = { edit: 4, write: 3, read: 2, search_hit: 1 };
const HALF_LIFE_DAYS = 14;

heat(f) =
  Σ_access  OP_WEIGHT[op] * Math.exp(-ageDays / HALF_LIFE_DAYS)
  + (isEntryPoint(f) ? 3 : 0)
  + (importerCount(f) >= 3 ? 2 : 0)
  + (noteCount(f) > 0 ? 2 : 0);
Entry point detection: package.json main/bin/exports targets; any file matching ^(src/)?(cli|index|main|app)\.[jt]sx?$; any file with zero importers and ≥1 local import.
Exclude from heat ranking entirely: parse_state != 'ok', deleted = 1.
Ties broken by rel_path ascending. All ordering deterministic.
8. Digest
8.1 Budget
LOOM_DIGEST_TOKENS=1200. charBudget = tokens * 4. Hard ceiling.
8.2 Section order and caps
#
Section
Cap
1
# Project map (Loom, N files indexed)
always
2
Stack: … · root: …
always
3
Entry: …
1 line, ≤6 paths
4
## Hot files
12 entries
5
## Key symbols
24 entries
6
## Notes
6 entries
7
Changed, not re-indexed: …
1 line, ≤8 paths
8
Verification reminder
always
Sections 1, 2, 8 are never truncated. Fill 3→7 in order; stop adding when the next line would exceed charBudget. Never truncate mid-line. Increment counters.digestTruncations when any section is dropped.
8.3 Line formats
Hot file:  - {rel_path} ({loc}L) — {purpose}{ Export clause}
Symbol:    - {name} [{kind}] {rel_path}:{line_start}-{line_end}
Note:      - {text}{ (unverified)}
Key symbols selection: exported only, confidence ≥ 0.70, drawn from hot files in heat order, then line_start ascending within a file.
Footer, verbatim:
Line ranges are approximate. Always read_file a region before editing it.
8.4 Reference output
# Project map (Loom, 47 files indexed)
Stack: Node.js, Playwright, CommonJS · root: forge-agent
Entry: src/cli.js, src/adapter-factory.js

## Hot files
- src/adapters/base-adapter.js (412L) — Model adapter. Shared base class.
  Exports: BaseAdapter. Used by 8 files.
- src/adapters/qwen-adapter.js (268L) — Model adapter. Qwen selectors and
  discovery overrides. Exports: QwenAdapter.
- src/adapter-factory.js (129L) — Core module. Central model registry.
  Exports: getAdapter, getModelUrl, getModelInfo, resolveModelName, SUPPORTED_MODELS.

## Key symbols
- sendMessage [method] src/adapters/base-adapter.js:118-176
- _waitForTextStable [method] src/adapters/base-adapter.js:214-268
- _cleanText [method] src/adapters/base-adapter.js:330-388
- resolveModelName [function] src/adapter-factory.js:64-79

## Notes
- Adapter discovery uses catch(_){} — page-level errors are swallowed. (unverified)

Line ranges are approximate. Always read_file a region before editing it.
8.5 Read-before-edit rule
The digest and all query results provide orientation only. Tool descriptions for recall, whats_here, related, project_map must each state: "Line ranges are approximate. Read the region with read_file before any edit." The mutating tools' descriptions must not suggest the index is sufficient basis for a write.
9. Public API
9.1 src/loom/index.js
js
await loom.open({ root, session })   // idempotent; never throws
await loom.refresh()                 // → {changed, gone, rebuilt, elapsedMs}
await loom.digest()                  // → string ('' when disabled)
await loom.around(tool, args, invoke)// → invoke()'s result, unchanged
loom.attach(adapter)                 // setProjectContext + writeSessionContext
await loom.recall(query, {limit=20}) // → hits[]
await loom.whatsHere(relPath)        // → {purpose, exports, imports, importers, loc, touched}
await loom.related(relPath)          // → {imports:[], importedBy:[]}
await loom.note(scope, text)
await loom.exportPortable()
await loom.stats()                   // counters
await loom.close({timeoutMs=2000})
Every method wrapped in the error boundary. On internal failure: increment counter, logger.debug, return the neutral value ('', [], null, invoke()).
9.2 recall ranking
FTS5 available:
sql
SELECT f.rel_path, bm25(loom_fts) AS rank
FROM loom_fts JOIN files f ON f.id = loom_fts.rowid
WHERE loom_fts MATCH ? AND f.deleted = 0
ORDER BY rank LIMIT 200;
Then re-score: final = (1/(1+rank)) * (1 + log1p(heat)) * exactSymbolBoost * exportedBoost, where exactSymbolBoost = 5 when the query equals a symbol name (case-insensitive), else 1; exportedBoost = 2 when the matched symbol is exported, else 1.
No FTS5: weighted substring over symbols.name, files.rel_path, summaries.purpose with the same boosts.
Return {rel_path, symbol, kind, line_start, line_end, score}. Never return file content.
9.3 writeSessionContext
DECIDED: yes, write the digest to SESSION_CONTEXT.md at the project root, atomically (.tmp + rename). The CLI already expects this file and currently warns when it is missing. This makes the digest human-inspectable and survives index loss. Write only when the content differs from what is on disk.
9.4 Counters
hookErrors, parseErrors, busySkips, digestTruncations, workerFallbacks, dbRebuilds, droppedUpdates. Exposed via loom.stats() and --loom doctor.
10. Tool schemas
json
{ "name": "project_map", "args": {} }
{ "name": "recall",     "args": { "query": "string", "limit": "number?" } }
{ "name": "whats_here", "args": { "path": "string" } }
{ "name": "related",    "args": { "path": "string" } }
All read-only. Each writes one access(op='search_hit') row per returned path. Each description ends with the read-before-edit sentence from §8.5.
11. Configuration
Variable
Default
Validation
LOOM_ENABLED
1
0|1
LOOM_DIR
<root>/.forge/loom
path
LOOM_DIGEST_TOKENS
1200
int 200–8000
LOOM_MAX_FILES
2000
int 1–100000
LOOM_MAX_FILE_BYTES
512000
int 1024–10⁷
LOOM_MODEL_SUMMARIES
0
0|1
LOOM_SUMMARY_MODEL
ollama
must resolve via resolveModelName; must be dedicated
LOOM_WORKER
1
0|1
LOOM_WATCH
0
0|1
LOOM_HEAT_HALFLIFE_DAYS
14
int 1–365
LOOM_REBUILD_THRESHOLD
0.3
float 0.05–1
LOOM_REHASH_DAYS
7
int 1–365
Invalid values: log one warn naming the variable and the offending value, fall back to the default, continue. Never throw on config.
12. CLI
forge-agent --loom doctor              driver, fts, schema version, file count,
                                       dirty flag, counters, last refresh, DB size
forge-agent --loom map                 print digest to stdout
forge-agent --loom recall <query>      ranked hits
forge-agent --loom verify              force full rehash + refresh
forge-agent --loom rebuild             drop and rebuild
forge-agent --loom export              write portable.json
forge-agent --loom import              hydrate from portable.json
forge-agent --loom note <scope> <text> add a note
forge-agent --loom stats               counters as JSON
doctor must distinguish: disabled / sqlite-unavailable / json-fallback / fts-missing / corrupt / dirty / healthy.
13. Portable export
portable.json — deterministic key order, sorted arrays, relative paths, no timestamps, no heat, no access log.
json
{
  "loom_version": 1,
  "files": [
    {
      "path": "src/adapter-factory.js",
      "sha": "…",
      "lang": "js",
      "loc": 129,
      "purpose": "Core module. Central model registry.",
      "exports": ["getAdapter","getModelUrl","getModelDisplayName","getModelInfo","resolveModelName","SUPPORTED_MODELS"],
      "symbols": [{"n":"resolveModelName","k":"function","s":64,"e":79,"c":0.95}],
      "imports": ["./adapters/qwen-adapter"]
    }
  ],
  "notes": [{"scope":"project","text":"…"}]
}
Import path: hydrate rows, then run refresh(). Because mtime differs after a copy, every file gets hashed once; matching content_sha means no re-parse and no re-summarize. Cost on 2 000 files is a few hundred milliseconds.
Do not commit index.db. Commit portable.json if cross-machine sharing via git is wanted.
14. Multi-agent
Index is project-scoped. spawn_agent children inherit LOOM_PROJECT_ID and open the same DB.
WAL + busy_timeout=3000: one writer, concurrent readers.
On SQLITE_BUSY: retry once after 50 ms, then drop the update and increment busySkips. The index is derivable, never authoritative.
access.session distinguishes children; heat aggregates across all sessions.
notes are shared — a gotcha found by one child benefits all.
Children never trigger warm-up if meta.built_at is present; they only refresh().
15. Failure matrix
Condition
Behaviour
Task impact
LOOM_ENABLED=0
All no-op
none
node:sqlite missing
JSON fallback
slower recall
FTS5 missing
Substring ranking
lower recall quality
SQLITE_BUSY
Retry once, drop, count
none
DB corrupt
Rename index.db → index.db.bad, rebuild in worker
one cold start
Schema version unknown
Rebuild
one cold start
Migration checksum mismatch
Rebuild, log warn
one cold start
Parse throws
parse_state='error', exclude from digest
none
Worker crash/timeout
Inline fallback, cap 200 files
slower warm-up
Project not writable
Global fallback dir
none
Disk full
Disable for process lifetime
none
Digest over budget
Truncate per §8.2
none
Watcher error
Disable watcher, keep dirty-flag path
none
16. Tests
Runner: node --test tests/loom/. Fixtures under tests/loom/fixtures/.
16.1 Unit
File
Assertions
hash.test.js
fast negative on equal mtime+size; hash detects same-size edit; touch-without-change causes no reparse
ignore.test.js
node_modules, .env, binaries, .forge/ excluded; .gitignore negation honoured
extract-js.test.js
fixture with class, methods, arrow consts, module.exports destructuring; exported flags correct
block-end.test.js
braces inside single/double/template strings, line and block comments, nested ${}; unbalanced → line_start+40, conf 0.4
resolve.test.js
./x → x.js; directory → index.js; bare specifier → NULL
graph.test.js
importers_sig stable under reorder; changes when an importer is added
confidence.test.js
sha mismatch → 0; role_stale → ×0.5; churn > 0.3 → ×0.7
heat.test.js
op weights, decay at 14 days ≈ 0.368, entry bonus, deterministic ties
digest.test.js
never exceeds tokens*4; sections 1/2/8 always present; symbols < 0.7 excluded; prose < 0.5 omitted; footer verbatim
config.test.js
invalid values warn + default, never throw
portable.test.js
byte-identical output across two runs; no absolute paths; no timestamps
16.2 Integration
Cold index of fixture repo → exact file/symbol/import counts.
Edit one file → parse counter increments by exactly 1.
Simulated branch switch (rewrite 3 files, revert 1) → git short-circuit finds the delta.
Write-through: write_file then whats_here shows new exports immediately.
move_file → rel_path rewritten, imports.resolved repaired, no orphan symbols.
delete_file → cascade removes symbols, imports, summary.
run_command → dirty flag set; next recall performs full sweep.
Two concurrent processes indexing → no SQLITE_BUSY escapes; both read correct structure.
JSON fallback parity for digest and whats_here.
portable.json import on a copied tree → zero re-parses.
16.3 Chaos — merge blocker
With the DB (a) deleted mid-session, (b) locked by another process, (c) truncated to zero bytes, run a full agent task and assert:
Task completes successfully.
No unhandled rejection, no uncaught exception.
Index self-heals on next open().
Added wall-clock overhead < 3 %.
16.4 Correctness — merge blocker
For 100 randomly mutated fixture files, assert the digest never contains a symbol range derived from superseded content. Any stale range presented as current fails the build. This is invariant I3.
16.5 Performance
Operation
Budget
Warm refresh(), 2 000 files
< 300 ms
Cold warm-up, 2 000 files (worker)
< 5 s
digest()
< 50 ms
recall()
< 20 ms
read_file post-hook
< 2 ms p99
Write-through hook
< 2 ms p99
Idle CPU
< 1 %
DB size, 2 000 files
3–8 MB
17. Phases
Phase
Deliverable
Gate
1
config, paths, hash, ignore, db, migrate, schema/001
I2 proven; unit tests green
2
extract/*, resolve, passive indexing from read_file
Symbol accuracy verified on this repo
3
refresh, graph, write-through, git short-circuit, dirty flag
§16.2 + §16.4 green
4
heat, digest, attach, writeSessionContext
Measured turn reduction on a repeated task
5
query, four tools, search_codebase refactor
Tool tests green
6
worker, summarize model path, watch, portable, CLI
§16.3 green; one-week soak
Phase 4 is the first point where user-visible value appears. Do not enable model summaries before phase 6.
18. Decisions register
Question
Decision
Storage location
In-project .forge/loom/; global fallback only when unwritable
Commit the DB?
No. Commit portable.json optionally
Write digest to SESSION_CONTEXT.md?
Yes, atomically, only on change
AST parsing in v1?
No. Heuristic extractors + mandatory read-before-edit
Embeddings?
No. FTS5 + structural boosts
Auto-notes from failure bundles?
No in v1. Agent-authored notes at write time only
Cross-project convention sharing?
No. Strictly project-scoped
Mid-session context refresh?
Not in v1. Would require editing base-adapter.js; re-injection after newChat() covers the practical case
New dependencies?
None. node:sqlite, node:test, node:crypto, worker_threads
Two implementation notes worth flagging to whoever picks this up:
§4.4 is not optional. A naive brace counter will produce wrong ranges throughout this codebase — the selector arrays in qwen-adapter.js and deepseek-adapter.js are full of {, } and quote characters inside strings. The state-machine scanner is required for I3 to hold.
§5.5 is the rot preventer. run_command is an unbounded mutation surface. Without the dirty flag, npm install or a formatter silently invalidates the index and the agent starts trusting stale ranges — which is the exact failure class this feature is supposed to prevent.