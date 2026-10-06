# Forge Agent - Complete User Guide

A hands-on, example-driven guide to using Forge Agent end to end. Every section
has copy-paste commands and shows what you should see.

If you are brand new, read sections 1-3 in order, then jump to whatever feature
you need.

---

## Contents

1. What Forge Agent is
2. Install & first run
3. Core concepts (tasks, sessions, context, TODO)
4. Everyday workflows
5. Named sessions & running agents side by side
6. Session context (SESSION_CONTEXT.md)
7. TODO lists and unattended runs (--auto)
8. Multi-agent supervisor
9. Slash commands (interactive mode)
10. Profiles, templates, watch mode
11. Troubleshooting
12. Safety & cleanup

---

## 1. What Forge Agent is

Forge Agent is an autonomous coding agent that drives a **web AI** (DeepSeek by
default, also ChatGPT and Gemini) through a real browser - **no API key needed**.
You give it a task in plain English; it reads your files, writes code, runs
commands and tests, and loops until done.

Key idea: it is a *driver*, not a model. You stay logged into the web UI, and
Forge automates the typing, the scraping, and the tool calls.

---

## 2. Install & first run

### 2.1 Requirements

- Node.js 18, 20 or 22
- A machine that can open a browser (headless is supported)
- A free account on at least one of DeepSeek / ChatGPT / Gemini

### 2.2 Install

    npm install -g @omar-azam/forge-agent

Or from a clone of the repo:

    npm install
    npm link          # exposes `forge-agent` and `fa` on your PATH

### 2.3 First-time setup

The first run walks you through a short wizard and opens the browser so you can
log in once (the login is saved in the session profile):

    forge-agent --setup

Follow the prompts. When it asks you to log in, do so in the browser window,
then return to the terminal and press Enter.

### 2.4 Your first task

    cd ~/my-project
    forge-agent "list the files here and summarise what this project does"

What happens:
1. A browser opens on the AI site (already logged in).
2. Forge sends your task plus a system prompt describing its tools.
3. The AI replies with tool calls; Forge runs them (read_file, list_directory, ...).
4. Results are sent back; the loop continues until the AI says TASK_COMPLETE.

### 2.5 The short alias

    fa "add a README section about deployment"

`fa` is identical to `forge-agent`.

---

## 3. Core concepts

### 3.1 Task

The string you pass. Either one-shot:

    forge-agent "fix the failing test in src/auth.test.js"

or many tasks in one session with shared context:

    forge-agent -i          # interactive mode

### 3.2 Session

A **session** is a NAMED workspace with its own browser profile (its own login
and cookies). This is what lets you run several agents at once without them
clobbering each other's login.

    forge-agent --session mybot "refactor the logger"

`--session` takes a NAME (not a path). The name maps to a folder at
`~/.deepseek-agent/sessions/<name>`. To use an explicit folder instead, use the
advanced `--session-dir <path>`.

### 3.3 Context

Two different things are called "context":

- **Conversation context** - the messages in the current chat. When it gets too
  long, Forge compresses it automatically (`/compact` to force it).
- **Session context** - the durable `SESSION_CONTEXT.md` file (section 6). It
  survives compression so the model never truly "forgets" your decisions.

### 3.4 TODO

`FORGE_TODO.md` is a plain markdown checklist that Forge can work through
unattended with `--auto` (section 7).

---

## 4. Everyday workflows (copy-paste examples)

### 4.1 Fix a bug

    forge-agent "the test in tests/cart.test.js is failing; find and fix the bug"

Forge reads the test, runs it, inspects the code, edits, and re-runs until green.

### 4.2 Add a feature

    forge-agent "add a --verbose flag to src/cli.js and update the README"

### 4.3 Refactor with a plan first

    forge-agent --plan "split src/agent.js into smaller modules"

The `--plan` flag makes Forge show its execution plan and wait for your OK before
changing anything.

### 4.4 Multiple related tasks (shared context)

    forge-agent -i

At the prompt, type tasks one after another. The AI keeps the conversation, so
task 2 already knows what task 1 did:

    > add input validation to the signup handler
    > now write tests for that validation
    > update the API docs

### 4.5 Pick a model

    forge-agent --model=chatgpt "..."
    forge-agent --model=gemini "..."

### 4.6 Use a profile

    forge-agent --profile=backend "add pagination to /users"
    forge-agent --profile=frontend "make the navbar responsive"

Profiles adjust the system prompt and tool focus.

### 4.7 Save a task as a template

    forge-agent --save-template=add-jest "set up Jest with a sample test"
    forge-agent --template=add-jest

### 4.8 Watch mode (auto re-run on change)

    forge-agent --watch "run the tests and fix any failures"

Forge re-runs whenever files change (great for tight test-fix loops).

### 4.9 Output formats

    forge-agent --format=json "list TODOs in the code"
    forge-agent --format=markdown "summarise the repo" --output=SUMMARY.md

---

## 5. Named sessions & running agents side by side

Each named session gets its own Chromium profile, so you can run several agents
at once, each logged in independently.

### 5.1 Start two agents at once

In terminal A:

    forge-agent --session backend "add pagination to the API"

In terminal B:

    forge-agent --session frontend "update the dashboard components"

They do not interfere: different profiles, different logins, different work.

### 5.2 Auto-generate a name

    forge-agent --session auto "try a risky refactor"

Produces a unique human-readable name like `brave-otter-9f3a` and its own profile.

### 5.3 Set a role label

    forge-agent --session backend --role api "add rate limiting"

`--role` is just a label (defaults to the session name) shown in `ps`.

### 5.4 See what is running

    forge-agent ps
    forge-agent ps --json

Shows ID/NAME, ROLE, PID, STATUS, UPTIME, MODEL, CWD for every live instance.

### 5.5 Advanced: explicit profile directory

    forge-agent --session-dir /data/profiles/ci "run the CI task"

Use `--session-dir` when you want to control the exact folder. `--session`
remains a NAME.

---

## 6. Session context (SESSION_CONTEXT.md)

### 6.1 What it is

A gitignored markdown file Forge keeps at your project root during a run. It
records the goal, decisions, progress, and current git state. If the model's
chat context is compressed (or you clear it), Forge re-feeds this file so the
model does not lose your earlier decisions.

It is created at session start and deleted at session end. It is auto-added to
`.gitignore` so it can never be committed by accident.

### 6.2 A peek at the file

    # SESSION_CONTEXT - brave-otter-9f3a
    ## Goal
    fix the failing auth tests
    ## Decisions
    - [09:22] mock the network layer instead of hitting the real API
    ## Progress
    - [x] read tests/auth.test.js
    - [ ] apply the fix
    ## Current State (auto-synced with git)
    - Branch : main
    - HEAD   : a1b2c3d "wip: auth refactor"
    - Dirty  : src/auth/login.js

### 6.3 See / clear / re-seed it (interactive)

Inside `forge-agent -i`:

    /context          # show the current SESSION_CONTEXT.md
    /context seed     # re-send it into the chat (after a /clear)
    /context clear    # delete it now

### 6.4 Turning off the gitignore guard

    SESSION_CONTEXT_GITIGNORE=false forge-agent "..."

---

## 7. TODO lists and unattended runs (--auto)

### 7.1 Create a FORGE_TODO.md

    cat > FORGE_TODO.md <<'EOF'
    # Sprint tasks
    - [ ] add input validation to the signup handler
    - [ ] write tests for that validation
    - [ ] update the API docs
    EOF

`- [ ]` is an open item, `- [x]` is done.

### 7.2 Let Forge work through them unattended

    forge-agent --auto

What happens:
1. Forge reads FORGE_TODO.md.
2. It runs the first open item.
3. On success it ticks the box `[ ]` -> `[x]` and moves to the next.
4. On the first failure it **stops** and leaves that item open, so the file
   always reflects reality.

Example run log:

    --auto: 3 open item(s) to process.
    > [1] add input validation to the signup handler
      Marked done: "add input validation to the signup handler"
    > [2] write tests for that validation
      Marked done: "write tests for that validation"
    > [3] update the API docs
      Marked done: "update the API docs"
    --auto finished. 3 item(s) completed.

### 7.3 Important rules

- `--auto` acts on `FORGE_TODO.md` ONLY. It never auto-acts on a
  `SESSION_CONTEXT.md` (that is always advisory context).
- If there is no FORGE_TODO.md, `--auto` exits cleanly with nothing to do.
- `--auto` still asks permission before dangerous tools (unless pre-approved).

### 7.4 Manage the list interactively with /todo

Inside `forge-agent -i`:

    /todo                     # list items with numbers
    /todo add deploy to staging
    /todo done 2              # tick item #2
    /todo clear-done          # remove completed items

### 7.5 Resume work from a previous run

At startup, if a FORGE_TODO.md or SESSION_CONTEXT.md exists, Forge asks:

    Pending work detected:
      - FORGE_TODO.md      - 2 open item(s)
    Continue from this work? [y/N]

Answering `n` starts fresh (and offers to delete a stale SESSION_CONTEXT.md).

---

## 8. Multi-agent supervisor

A supervisor instance can spawn and control child agents.

### 8.1 Ask the agent to spawn a worker

Inside a session:

    spawn a child agent with session worker-auth to add JWT auth

Forge calls the `spawn_agent` tool, which starts a new process with its own
session/profile.

### 8.2 Tools available

- `spawn_agent(session, task, context?)` - start a child.
- `list_agents` - list running instances.
- `kill_agent(name)` - stop a child by session name or PID.

### 8.3 Watch and stop children

    forge-agent ps
    forge-agent ps --json

### 8.4 The one hard rule

Children share FILES (like SESSION_CONTEXT.md), **never the browser**. Each child
uses its own `--session` because Chromium's profile takes an exclusive lock. Two
agents cannot share one window - this is by design, not a bug.

---

## 9. Slash commands (interactive mode)

Type these at the `forge-agent -i` prompt:

| Command | What it does |
|---|---|
| `/help` | list all commands |
| `/status` | show session status |
| `/model <name>` | switch model |
| `/profile <name>` | switch profile |
| `/clear` | new chat, re-seeds from SESSION_CONTEXT.md |
| `/compact` | compress the conversation now |
| `/context [show\|seed\|clear]` | manage SESSION_CONTEXT.md |
| `/todo [add\|done\|clear-done]` | manage FORGE_TODO.md |
| `/memory` | show project memory |
| `/history` | recent tasks |
| `/tools` | list available tools |
| `/config` | show/change config |
| `/dir <path>` | change working directory |
| `/version` | version |

Example:

    > /todo add write migration script
    Added TODO: write migration script
    > /todo
    FORGE_TODO.md
      [ ] 1. write migration script
    1 open, 0 done.

---

## 10. Profiles, templates, watch mode

### 10.1 Profiles

| Profile | Use for |
|---|---|
| default | general work |
| backend | APIs, databases, servers |
| frontend | UI, components, styling |
| data-science | notebooks, pandas, ML |
| devops | Docker, CI, infra |

    forge-agent --profile=devops "add a GitHub Actions workflow"

### 10.2 Templates

    forge-agent --list-templates
    forge-agent --template=add-typescript
    forge-agent --save-template=my-task "...description..."

### 10.3 Watch mode

    forge-agent --watch "run the tests and fix failures"
    forge-agent --watch --watch-pattern="src/**/*.js" "..."

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| "login required" | log in in the browser, press Enter |
| selectors not found | run `forge-agent --test-model`; the site UI may have changed |
| response takes forever | normal for big tasks; `--timeout=900` to extend |
| `--auto` says nothing to do | no `FORGE_TODO.md` or all items done |
| `/context` shows memory help | update to the latest version |
| two agents conflict | give each a unique `--session` |
| SESSION_CONTEXT.md appears in git | add it to .gitignore (Forge does this automatically) |
| command not found: forge-agent | use `npm link` or run `node src/index.js` |

---

## 12. Safety & cleanup

- Forge asks permission before write/delete/shell tools; you can pre-approve a
  category per project (stored in `.forge-permissions.json`, gitignored).
- `SESSION_CONTEXT.md` and `FORGE_TODO.md` are gitignored and never committed.
- `SESSION_CONTEXT.md` is deleted at session end; FORGE_TODO.md is yours to keep.
- Verify before pushing:

      git status
      git check-ignore SESSION_CONTEXT.md FORGE_TODO.md

- Child agents each get their own profile; stop them with `kill_agent`.

---

## Need more?

- `TESTING_PHASE1-4.md` - how to verify every feature by hand
- `docs/` - the full documentation site
- `forge-agent --help` and `forge-agent --help=<topic>` for CLI topics
