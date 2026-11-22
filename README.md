# Forge Agent

Forge Agent is an autonomous coding agent that drives web AI chat UIs — DeepSeek,
Gemini, Qwen, ChatGPT and Google — through Playwright browser automation, with no
API key and no LLM API: "the model" is a browser tab the agent types into and
reads replies from. It ships the tools to read, write, run and verify code, and
loops on a task until the work is finished, the project's own check passes, or a
budget stops it.

```bash
npm install -g @puneet-swarup/forge-agent
forge-agent --setup                                   # one-time: config, browser, health check
forge-agent "add a /health endpoint to the Express app in this repo"
```

That is the whole loop. The first run opens a browser window — sign in to the
provider once and the profile persists in `~/.forge-agent`, so later runs start
already authenticated.

---

## Quick start

```bash
# Install (Node >= 20)
npm install -g @puneet-swarup/forge-agent

# First run: interactive setup wizard, then a health check
forge-agent --setup
forge-agent --doctor

# One task, in the current directory
forge-agent "convert the test suite from Mocha to Jest"

# Multiple tasks with shared context
forge-agent --interactive

# Short alias, any of the above
fa "add TypeScript to this project"
```

Work in another directory with `--dir <path>`, pick a model with `--model`, and
resume an interrupted run with `--resume`.

---

## What makes this different

Most agent failures are not model failures — they are boundary failures: a stale
reply read as a new one, a file truncated mid-write, a "done" that was never
tested. Forge Agent treats those as invariants with named enforcement points and
tests. Each one is specified, with its enforcing module and its test, in
[docs/RELIABILITY.md](docs/RELIABILITY.md).

- **The turn boundary is measured** — a reply is accepted only after the
  transcript has changed since the message was sent, so the previous answer can
  never be returned as this one ([§1](docs/RELIABILITY.md#1-the-turn-boundary-is-measured)).
- **There is exactly one system prompt**, and it is the one the agent actually
  sends ([§2](docs/RELIABILITY.md#2-one-contract-and-the-model-is-told-it)).
- **A stalled chat restarts with its contract** — system prompt, task, plan,
  progress and recent errors are re-sent rather than the run being abandoned
  ([§3](docs/RELIABILITY.md#3-a-stalled-chat-restarts-with-its-contract)).
- **Secrets are redacted before egress** — high-confidence key shapes are masked
  on both paths that send tool output to the chat UI
  ([§4](docs/RELIABILITY.md#4-nothing-secret-leaves-the-machine-unredacted)).
- **Writes are atomic, reversible and guarded** — temp-file plus `rename`, a
  pre-image snapshot, read-before-write by content hash, and a diff in every
  result ([§5](docs/RELIABILITY.md#5-writes-are-atomic-reversible-and-guarded)).
- **Runs are bounded** by step, wall-clock and tool-call budgets that end the run
  with a partial summary instead of a hang
  ([§6](docs/RELIABILITY.md#6-runs-are-bounded)).
- **Prose is not a program** — only a well-formed call to a registered tool
  executes, never an illustration or a code sample
  ([§7](docs/RELIABILITY.md#7-prose-is-not-a-program)).
- **Session context is durable and re-fed** through a gitignored
  `SESSION_CONTEXT.md` that survives a chat restart
  ([§8](docs/RELIABILITY.md#8-session-context-is-durable-and-re-fed)).
- **Throttling is handled when it happens**, backing off only on the provider's
  own signal instead of paying a fixed pause per prompt
  ([§9](docs/RELIABILITY.md#9-throttling-is-handled-when-it-happens)).
- **Tool arguments are integrity-checked** — a payload carrying a hash is
  verified before use, and a mismatch writes nothing
  ([§10](docs/RELIABILITY.md#10-arguments-are-integrity-checked)).
- **Completion is verified** — `TASK_COMPLETE` is refused when the project's own
  typecheck, lint or test script fails
  ([§11](docs/RELIABILITY.md#11-completion-is-verified)).
- **The shell is governed** by an allow/confirm/deny policy evaluated over the
  whole command line, with a scrubbed child environment
  ([§12](docs/RELIABILITY.md#12-the-shell-is-governed)).
- **The remote context is rotated on the agent's own schedule**, re-sending the
  contract and a state digest before the provider can truncate it
  ([§13](docs/RELIABILITY.md#13-the-remote-context-is-rotated-on-our-terms)).
- **The plan is gated at both ends** — `FORGE_PLAN.md` must exist before the
  first mutating tool and be fully ticked before completion
  ([§14](docs/RELIABILITY.md#14-the-plan-is-gated-at-both-ends)).

The same document ends with an honest list of what is *not* closed yet.

---

## Features

| Area | What you get |
| --- | --- |
| **Models** | `deepseek` (default), `gemini`, `qwen`, `chatgpt`, `sarvam` (Indus UI), `sarvam-api` (hosted API), plus `local`, `ollama` and `colab` endpoints — switch with `--model`. `google` is a **research fallback only**: it drives a search surface, not a chat UI |
| **Tools** | 45 registered tools (the 2.0 release documented 37+): file read/write/replace/delete, directory and search, `run_command`, git (status, log, diff, blame, branches, show), tests, packages, env files, processes, child agents, clipboard, screenshots |
| **Profiles** | `default`, `backend`, `frontend`, `data-science`, `devops` — `--profile`, or `--custom-profile=<file>` for your own JSON |
| **Sessions** | Named sessions with their own browser profile and login (`--session`, `--session auto`), instance listing (`ps` / `--ps`), resume and history (`--resume`, `--continue`, `--history`), per-run summaries (`--summary`) |
| **Budget** | Enforced step, wall-clock and tool-call limits — `--max-iterations` (default 100), `--max-runtime` (`90`, `30s`, `90m`, `2h`), `--max-tool-calls` |
| **Snapshots** | Pre-session snapshots of every file the agent mutates — list with `--snapshots`, restore one file with `--rollback=<path>` |
| **Templates** | 10 built-in task templates (`add-typescript`, `add-jest`, `add-docker`, `add-github-actions`, `add-eslint`, `add-env-setup`, `write-readme`, `add-auth`, `fix-tests`, `code-review`) |
| **Examples** | 10 runnable example projects (`--examples`) |
| **Memory** | Project tech stack and past tasks remembered per working directory (`--clear-memory`, `--no-memory`) |
| **Unattended runs** | `--auto` works through `FORGE_TODO.md`; `--parallel` runs open items across child agents; `--watch` re-runs on file change |
| **Output** | `--format` (`text`, `markdown`, `json`, `json-raw`, `minimal`, `silent`), `--output=<file>`, `--json`, `--no-tui`, `--compact` |
| **Security** | `--security` shows the posture, `--strict-sandbox` confines file access to the working directory, `--audit-log` appends every tool call to a log |
| **Docker** | `Dockerfile`, `docker-compose.yml`, and a published image for hosts without Node.js |
| **Loom (in progress)** | Persistent project index. **Slice 1 of 5 is done — storage only** (config, paths, hashing, ignore rules, schema, SQLite/JSON driver). Extractors, indexer, digest and agent-loop integration are not started, and nothing in the loop uses it yet: see [docs/LOOM.md](docs/LOOM.md) |

---

## Configuration

Defaults live in `src/config.js`. Override them, in increasing priority, with a
`forge-agent.config.json` in the working directory, environment variables, or
CLI flags.

```json
{
  "HEADLESS": false,
  "MAX_ITERATIONS": 100,
  "RESPONSE_TIMEOUT": 600000,
  "STABLE_DELAY": 1500,
  "MAX_OUTPUT_LENGTH": 8000,
  "DEBUG": false
}
```

Settings worth knowing:

| Key | Default | Effect |
| --- | --- | --- |
| `RESPONSE_TIMEOUT` | `600000` | Total wait for one reply, in ms (`--timeout`, `--no-timeout`) |
| `MAX_ITERATIONS` | `100` | Loop iterations per run (`--max-iterations`) |
| `MAX_RUNTIME_MS` | `0` (off) | Wall-clock limit (`--max-runtime`) |
| `MAX_TOOL_CALLS` | `0` (off) | Executed tool calls per run (`--max-tool-calls`) |
| `CONTEXT_ROTATION_TURNS` | `25` | Assistant turns between planned chat rotations; `0` disables |
| `PROMPT_PAUSE` | `false` | The old fixed 10–20 s pause before each prompt; `--prompt-pause` turns it on |
| `PLAN_GATE` | `true` | `FORGE_PLAN.md` gating at start and completion |
| `SHELL_POLICY` | `standard` | `strict` denies unknown binaries, `off` steps aside |
| `MAX_VERIFICATION_ATTEMPTS` | `2` | Tries at the project's own check before the gate steps aside |
| `VERIFY_TIMEOUT_MS` | `120000` | Timeout for that check |
| `LOOM_ENABLED` | — | `0` is a hard kill switch for the Loom index (no I/O) |

For `--model=ollama` and `--model=colab`, copy `.env.example` to `.env` and set
the endpoint, token and model name. `--model-url`, `--api-key` and
`--local-model` do the same per run.

### Most useful flags

```bash
forge-agent --interactive                  # multiple tasks, shared context
forge-agent --model=gemini "task"          # switch provider
forge-agent --profile=backend "task"       # backend conventions
forge-agent --session auto                 # isolated browser profile + login
forge-agent --resume=last                  # pick up the last task
forge-agent --plan "task"                  # show the plan before acting
forge-agent --max-iterations=200 --max-runtime=90 "task"
forge-agent --snapshots                    # what can be rolled back
forge-agent --rollback=src/a.js            # restore one file
forge-agent --no-interactive               # never prompt (CI)
forge-agent --format=json --output=run.json "task"
forge-agent --doctor                       # Node, Chromium, config, login
```

`forge-agent --help` prints every flag; `forge-agent --help=<topic>` covers
`getting-started`, `profiles`, `templates`, `plugins`, `watch`, `performance`,
`security`, `models` and `resume`; `forge-agent --cheatsheet` is the one-page
version.

---

## Requirements and supported platforms

- **Node.js >= 20** (enforced in `package.json` and checked by `--doctor`).
- **Playwright with Chromium** — installed with the package; if Chromium is
  missing, run `npx playwright install chromium`.
- **A browser you can log in to** — a free account with the chosen provider. No
  API key is needed for the browser-driven models.
- **A terminal** and a directory the agent may write to.

Supported platforms: **Linux, macOS and Windows** (POSIX and Windows paths are
handled throughout, and `install.sh` / `install.bat` are both shipped), plus
**Docker** via the included `Dockerfile` and `docker-compose.yml`.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it is actually implemented: the layer map, the agent loop, the protocol seam, the tool registry, adapters, and known pitfalls |
| [docs/RELIABILITY.md](docs/RELIABILITY.md) | Every runtime invariant with its enforcing module, its test, and the list of guarantees still missing |
| [NEXT_SESSION.md](NEXT_SESSION.md) | Workstreams, their verified status, and the coordination rules for more than one worker in the repo |
| [docs/LOOM.md](docs/LOOM.md) | Loom's slice plan and exactly what slice 1 provides today |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup for contributors, coding conventions, tests, and the PR process |
| [docs/](docs/index.html) | The HTML documentation site: getting started, tools, CLI reference, profiles, templates, plugins, configuration, examples |
| [CHANGELOG.md](CHANGELOG.md) | Release history, including what each reliability pass changed |

Run the suite with `npm test`. At the time of writing it is **131 suites /
2,504 tests — 2,485 passing, 19 skipped**, all green. The 19 skips are the
browser suites, which skip wherever Chromium cannot launch and run in CI. The
other gates are `npm run typecheck` (clean) and `node scripts/verify-prompt.js`
(the prompt the agent actually sends, 19 checks).

---

## Credits

MIT licensed — see [LICENSE](LICENSE). Forge Agent was originally created by
[Omar Azam](https://github.com/Omar-Azam/forge-agent) and this repository began
as a fork of that project. It has since been substantially extended here: the
reliability pass described in [docs/RELIABILITY.md](docs/RELIABILITY.md), the
Loom project index (in progress), session isolation and resume, the agent
supervisor, and the CI/CD pipeline.
