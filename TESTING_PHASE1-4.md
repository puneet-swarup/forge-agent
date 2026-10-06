# Testing Guide - Session Context, TODO Auto-Run, Multi-Agent (Phases 1-4)

This guide lets you verify everything built in Phases 0-4 manually, on a real
machine, against a real install. Each step lists the exact command, what you
should see, and how to confirm it is safe.

Scope: Phase 0 (CLI cleanup), Phase 1 (SESSION_CONTEXT.md), Phase 2/3
(FORGE_TODO.md detection + --auto + /todo), Phase 4 (agent supervisor).

---

## 0. Setup

### 0.1 Install

From the repo root:

    npm install
    npm link          # optional: makes `forge-agent` available on PATH

If you do not want to npm link, run everything with `node src/index.js`.

### 0.2 Recommended scratch dir

Do NOT test in the Forge repo itself (session files are meant to be gitignored).
Use a scratch project:

    mkdir /tmp/forge-scratch && cd /tmp/forge-scratch
    git init -q
    printf 'node_modules/\n' > .gitignore
    echo demo > README.md
    git add -A && git commit -qm init

All commands below assume you are inside a scratch dir unless stated otherwise.

### 0.3 Disable optional audio during tests

    export FORGE_NO_AUDIO=1        # bash/zsh
    setx FORGE_NO_AUDIO 1          # Windows (new shell)

Most Phase 1-3 checks happen BEFORE the browser launches, so you can verify
them without logging into DeepSeek.

---

## 1. Phase 0 - CLI parsing sanity

### 1.1 --session is a NAME, --session-dir is a PATH

    node -e "process.argv=['node','script','--session','mybot','--role','tester']; process.env.FORGE_HOME='/tmp/forgehome'; require('./src/index.js'); console.log(process.env.FORGE_SESSION_NAME, process.env.FORGE_SESSION_DIR, process.env.FORGE_ROLE);"

Expect: `mybot  /tmp/forgehome/sessions/mybot  tester`

### 1.2 equals-form works

    node -e "process.argv=['node','script','--session=mybot','--role=boss']; process.env.FORGE_HOME='/tmp/forgehome'; require('./src/index.js'); console.log(process.env.FORGE_SESSION_NAME, process.env.FORGE_ROLE);"

Expect: `mybot boss`

### 1.3 ps lists instances

    forge-agent ps
    forge-agent ps --json

Expect: a table (or JSON) of running instances; empty is fine if none running.
Safe? Yes - pure read of the session registry under ~/.deepseek-agent/sessions.

---

## 2. Phase 1 - SESSION_CONTEXT.md

### 2.1 Unit-level: create / update / read / destroy

    node -e "
    const fs=require('fs'),os=require('os'),path=require('path');
    const d=fs.mkdtempSync(path.join(os.tmpdir(),'sctx-'));
    const {SessionContext}=require('./src/session-context.js');
    const c=new SessionContext({projectDir:d,sessionName:'test-otter',task:'fix tests'});
    console.log('create:',c.create().ok);
    c.addDecision('mock the network');
    c.addProgress('read tests',true);
    c.addProgress('apply fix',false);
    c.update();
    console.log(fs.readFileSync(path.join(d,'SESSION_CONTEXT.md'),'utf8'));
    console.log('destroy:',c.destroy().ok,'exists:',c.exists());
    fs.rmSync(d,{recursive:true,force:true});
    "

Expect: a markdown file with ## Goal, ## Decisions, ## Progress,
## Current State, ## Open Questions; destroy prints `true false`.

### 2.2 Auto-gitignore guard

    node -e "
    const fs=require('fs'),os=require('os'),path=require('path');
    const d=fs.mkdtempSync(path.join(os.tmpdir(),'gi-'));
    const {ensureGitignored}=require('./src/session-context.js');
    console.log(ensureGitignored(d).status);
    console.log(ensureGitignored(d).status);
    console.log(fs.readFileSync(path.join(d,'.gitignore'),'utf8'));
    fs.rmSync(d,{recursive:true,force:true});
    "

Expect: `created` then `present` (idempotent - no duplicate entry).

### 2.3 Interactive /context and re-seed on /clear

Needs the browser (interactive mode). In a scratch dir:

    forge-agent -i
    /context          # shows SESSION_CONTEXT.md
    /context seed     # re-seeds the chat from it
    /context clear    # removes it

Safe? The file is created in the current working directory, added to
.gitignore, and deleted at session end. `git status` should never show it.

---

## 3. Phase 2/3 - FORGE_TODO.md, detection, --auto, /todo

### 3.1 Create a TODO file

    cat > FORGE_TODO.md <<'EOF'
    # TODO
    - [ ] print the working directory
    - [x] already finished task
    - [ ] list files
    EOF

### 3.2 /todo command (interactive)

    forge-agent -i
    /todo                 # list items: 2 open, 1 done
    /todo add write docs  # append a new open item
    /todo done 1          # tick item #1
    /todo clear-done      # remove completed items

Expect: each returns a short status line; FORGE_TODO.md reflects changes.

### 3.3 Detection at startup

    forge-agent -i

At startup you should see:

    Pending work detected:
      - FORGE_TODO.md      - 2 open item(s)
    Continue from this work? [y/N]

Answer n -> start fresh. Answer y -> load the context.

### 3.4 --auto unattended run

    forge-agent --auto

Expect:
- Logs `--auto: N open item(s) to process.`
- Runs each item top-to-bottom.
- Ticks each [ ] to [x] on success.
- Halts on the first failure, leaving that item open.
- Finishes with `--auto finished. N item(s) completed.`

Safe? Auto mode only ever acts on FORGE_TODO.md. It never acts on a
SESSION_CONTEXT.md. It still respects the normal permission/sandbox prompts.

### 3.5 --auto does nothing when there is no TODO

    rm FORGE_TODO.md
    forge-agent --auto

Expect: `--auto: no open FORGE_TODO.md items. Nothing to do.` and a clean exit.

---

## 4. Phase 4 - Multi-agent supervisor

### 4.1 Spawn / list / kill (module level, no browser)

    node -e "
    const sup=require('./src/agent-supervisor.js');
    console.log('entry:', sup.entryPoint());
    console.log('list:', sup.listChildren().length);
    console.log('kill-missing:', JSON.stringify(sup.killChild('nope-xyz')));
    "

Expect: an existing entry path, a list (possibly empty), and a
{ok:false, error:'No matching...'} for the bogus kill.

### 4.2 Spawn a real child (needs browser/login)

From an interactive session, ask the agent to call spawn_agent:

    spawn a child agent with session worker-1 to run the task "echo hello"

Or call the module directly:

    node -e "
    const sup=require('./src/agent-supervisor.js');
    const info=sup.spawnAgent({session:'worker-demo', task:'echo hello', detached:true});
    console.log(info);
    "

Then verify and stop it:

    forge-agent ps
    forge-agent ps --json
    node -e "console.log(require('./src/agent-supervisor.js').killChild('worker-demo'))"

Expect kill: {ok:true, pid:...}

Safe? & important limitation: each child uses its OWN --session, i.e. its own
Chromium profile dir. Two agents cannot share one browser window - Chromium's
persistent profile takes an exclusive lock. Children share FILES
(SESSION_CONTEXT.md), never the browser. Launching two agents on the SAME
--session will fail/conflict by design.

---

## 5. Automated test run (fastest full check)

    npm test

Expect: all suites pass. As of this writing: 1586 passing, 0 failing.
The two `FAILURES (2)` lines Jest prints are just captured console.log output
(benchmark + intentional error-display tests), not real failures.

Focused suites for the new features:

    npx jest tests/session-context.test.js
    npx jest tests/todo-manager.test.js
    npx jest tests/work-startup.test.js
    npx jest tests/agent-supervisor.test.js
    npx jest tests/commands.test.js

### Browser + supervisor + auto-loop integration tests

These use a REAL headless Chromium against a LOCAL mock chat page (no login,
no network), so they run in CI. They auto-skip if Chromium is not installed.

    npx jest tests/integration-browser.test.js
    npx jest tests/integration-supervisor.test.js
    npx jest tests/integration-auto-loop.test.js

Total after all phases: 1594 passing, 0 failing (2 Jest 'FAILURES' lines are
just captured console.log output, not failures).

### CI

Two jobs run on every push/PR:
- Test: unit suite across Node 18/20/22 (Chromium skipped for speed).
- Integration: installs Chromium and runs the browser E2E + supervisor + auto-loop
  integration tests.

---

## 6. Safety checklist (run through after testing)

    git status
    git check-ignore SESSION_CONTEXT.md FORGE_TODO.md

- [ ] SESSION_CONTEXT.md is created in the CWD and removed at session end.
- [ ] It is listed in .gitignore (auto-added if missing).
- [ ] FORGE_TODO.md is only acted on by --auto; SESSION_CONTEXT never is.
- [ ] --auto halts on the first failure instead of churning.
- [ ] Spawned children use distinct sessions; no shared-browser attempt.
- [ ] kill_agent stops the child (check `forge-agent ps`).
- [ ] Permission prompts still appear for dangerous tools inside --auto.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| --auto says nothing to do | no FORGE_TODO.md or all done | add open `- [ ]` items |
| /context shows memory help | stale alias (fixed) | update to latest commit |
| child spawn fails | missing browser/login | log in once, or use a headless-safe task |
| two agents conflict | same --session used twice | give each a unique --session |
| SESSION_CONTEXT.md shows in git | gitignore guard skipped | add the line manually |

---

## 8. What is covered by automated tests vs. manual

Automated (CI-runnable, no login needed):
- Unit tests for session-context, todo-manager, work-startup, agent-supervisor,
  /todo command.
- Browser E2E against a local mock chat page (send + scrape + tool_call parse).
- Supervisor lifecycle (spawn a real child, verify, kill).
- --auto loop wiring (run all items, halt on failure).

Still manual (need a real login):
- End-to-end runs against the REAL DeepSeek/ChatGPT/Gemini UIs. Selectors can
  drift when those sites change; run `forge-agent --test-model` to check.
- Load/soak testing of many concurrent children (see the performance notes in
the response-time optimization discussion).
