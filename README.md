# 🔨 Forge Agent

**Autonomous AI Coding Agent — No API Key Needed**

Forge Agent drives DeepSeek, ChatGPT, or Gemini through browser
automation to code, test, and ship software — completely free.

> **This repository is a fork of [Omar-Azam/forge-agent](https://github.com/Omar-Azam/forge-agent)**, substantially extended with session context, TODO automation, a multi-agent supervisor, and a full test/CI suite. Original project is MIT licensed.

[![npm](https://img.shields.io/badge/npm-@puneet--swarup%2Fforge--agent-cb3837?logo=npm&style=flat)](https://www.npmjs.com/package/@puneet-swarup/forge-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1597%20passing-brightgreen)](#)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fpuneet--swarup%2Fforge--agent-blue)](https://github.com/puneet-swarup/forge-agent/pkgs/container/forge-agent)

---

## 💙 Sponsors

Forge Agent is free and open source. If it saves you time:

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github)](https://github.com/sponsors/puneet-swarup)
[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi)](https://ko-fi.com/forgeagent)

---

## Why Forge Agent?

- **Free** — No API key. Uses DeepSeek, ChatGPT, or Gemini's free web UI.
- **Autonomous** — Reads files, writes code, runs tests. Loops until done.
- **Cross-platform** — Linux, macOS, Windows, and Docker.
- **50 days built** — 37+ tools, 1300+ tests, full docs, security audited.

---

## Installation

```bash
# npm (recommended)
npm install -g @puneet-swarup/forge-agent

# Docker (no Node.js required)
docker pull ghcr.io/puneet-swarup/forge-agent:latest
```

---

## Quick Start

```bash
# First time setup
forge-agent --setup

# Run a task
forge-agent "build a REST API with Express and JWT auth"

# Interactive mode — multiple tasks, shared context
forge-agent --interactive

# Short alias
fa "add TypeScript to this project"
```

---

## Features

| Feature | Description |
|---|---|
| 🌐 Browser Automation | Drives DeepSeek, ChatGPT, Gemini — no API key |
| 🔧 37+ Built-in Tools | File I/O, git, shell, search, tests, packages, diff, env, processes |
| 💾 Persistent Memory | Remembers project tech stack and past tasks |
| 🎭 Agent Profiles | default, backend, frontend, data-science, devops |
| 📋 Task Templates | 10 built-in templates — add TypeScript, Jest, Docker in one command |
| 🔄 Session Resume | Continue tasks that stopped halfway |
| 👁 Watch Mode | Auto re-run on file changes |
| 🔌 Custom Plugins | Drop a .js file to add any tool |
| 🔒 Security Sandbox | Blocks SSH keys, credentials, path traversal |
| 🐳 Docker Ready | Official image, no local Node.js setup needed |
| ⚡ Smart Caching | Skips repeated read-only tool calls |
| 🗜 Context Compression | Auto-compresses long conversations |
| 📝 Session Context | Durable, gitignored SESSION_CONTEXT.md survives compaction |
| ✅ TODO Auto-Run | --auto works through FORGE_TODO.md unattended |
| 🤖 Agent Supervisor | Spawn, monitor, and stop child agents |
| 📊 Benchmarks | Measure and compare performance |

---

## Built-in Tools (37+)

**File:** read_file · write_file · append_to_file · replace_in_file · delete_file · move_file · copy_file · create_directory · list_directory · get_file_info · write_files

**Search:** search_in_files · search_codebase · find_files

**Shell:** run_command · start_process · stop_process · list_processes · read_process_logs

**Git:** git_status · git_log · git_diff · git_branches · git_show · git_blame

**Dev:** run_tests · install_package · diff_files · patch_file

**Env:** read_env · set_env_var · delete_env_var · list_env_files · check_env_vars

**System:** take_screenshot · read_clipboard · write_clipboard

**Audio:** call_user · raise_alarm (cross-platform TTS & alarms — Windows/macOS/Linux, with terminal-bell fallback)

---

## Agent Profiles

```bash
forge-agent --profile=backend      # Node.js, Python, Go, REST APIs
forge-agent --profile=frontend     # React, Vue, HTML/CSS
forge-agent --profile=data-science # Python, pandas, ML
forge-agent --profile=devops       # Docker, CI/CD, shell scripts
```

---

## Task Templates

```bash
forge-agent --template=add-typescript    # Add TypeScript to any JS project
forge-agent --template=add-jest          # Set up Jest testing
forge-agent --template=add-docker        # Dockerfile + docker-compose
forge-agent --template=add-github-actions # CI/CD pipeline
forge-agent --template=fix-tests         # Run and fix all failing tests
forge-agent --template=code-review       # Comprehensive code review
forge-agent --list-templates             # See all 10 templates
```

---

## Session Resume

```bash
forge-agent --history         # Browse past tasks
forge-agent --resume          # Pick and resume a past task
forge-agent --resume=last     # Resume most recent task immediately
forge-agent --rerun           # Re-run most recent task fresh
forge-agent --auto            # run open FORGE_TODO.md items unattended
forge-agent --resume-work     # force the resume path for pending work
```

---

## Session Context & TODO

Forge keeps a durable, gitignored SESSION_CONTEXT.md at the project root
recording the goal, decisions, progress and current git state of a run. It
survives model context compaction, so it can be re-fed after the model forgets
earlier turns. Created at session start, removed at session end.

FORGE_TODO.md is a persistent, human-authored task list. --auto loops through
all its open items top-to-bottom in a single run, ticking each [ ] to [x] on
success, and halts on the first failure. Auto mode applies to FORGE_TODO.md only
- a SESSION_CONTEXT.md is always advisory and never auto-acted on.

Interactive commands: /context (show|clear|seed) and
/todo (add <text> | done <n> | clear-done).

Multi-Agent (Supervisor Mode): a supervisor can spawn_agent, list_agents, and
kill_agent. Each child uses its own --session (own Chromium profile); children
share files, never the browser.

---

## Docker

```bash
# Single task
docker run --rm -v "$(pwd):/workspace" --network host \
  ghcr.io/puneet-swarup/forge-agent "build a REST API"

# Interactive
docker run --rm -it -v "$(pwd):/workspace" --network host \
  ghcr.io/puneet-swarup/forge-agent --interactive

# With Make
make run TASK="build a REST API"
make interactive
```

---

## Custom Plugins

```js
// ~/.deepseek-agent/tools/fetch_weather.js
module.exports = {
  name: 'fetch_weather',
  description: 'Get current weather for a city',
  parameters: { city: { type: 'string', required: true } },
  async execute({ city }) {
    const https = require('https');
    return new Promise((res, rej) => {
      https.get(`https://wttr.in/${city}?format=3`, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      }).on('error', rej);
    });
  },
};
```

```bash
forge-agent --list-plugins       # see all loaded plugins
forge-agent --new-plugin my_tool # generate a stub
```

---

## CLI Reference (key flags)

```
forge-agent [OPTIONS] [TASK]

Core:      --interactive -i  --dir  --model  --profile  --plan  --think
Sessions:  --resume  --rerun  --history  --no-memory  --session  --session-dir
TODO:      --auto  --resume-work
Supervisor: spawn_agent  list_agents  kill_agent  (tools)
Templates: --template  --list-templates  --save-template
Output:    --format  --output  --no-tui  --compact
Watch:     --watch  --watch-pattern  --watch-debounce
Performance: --max-iterations  --timeout  --no-timeout
Plugins:   --list-plugins  --new-plugin
Config:    --setup  --config-path
Debug:     --debug  --headless  --diagnostics  --security
Help:      --help  --help=<topic>  --cheatsheet  --man
```

Full reference: `forge-agent --help` or [docs/cli-reference.html](docs/cli-reference.html)

---

## Configuration

```json
// ~/.deepseek-agent/config.json
{
  "MODEL": "deepseek",
  "MAX_ITERATIONS": 100,
  "RESPONSE_TIMEOUT": 600000,
  "ACTIVE_PROFILE": "default",
  "MEMORY_ENABLED": true,
  "CACHE_ENABLED": true
}
```

Run `forge-agent --setup` for guided configuration.

---

## Key Stats — v2.0.0

- 🔧 **37+ tools** built in
- 🧪 **1300+ tests** across 49 suites
- 📁 **13 docs pages** including full CLI reference
- 📋 **10 task templates** built in
- 💡 **10 example projects** in gallery
- ⚙️ **40+ CLI flags**
- 🐳 **Docker image** published
- 🔒 **Security audited** with path sandbox
- 📦 **50 days** of development

---

## Documentation

Full documentation: [https://puneet-swarup.github.io/forge-agent](https://puneet-swarup.github.io/forge-agent)

- [**Complete User Guide**](USER_GUIDE.md) - every feature with copy-paste examples
- [**Testing Guide**](TESTING_PHASE1-4.md) - verify each feature by hand
- [Getting Started](docs/getting-started.html)
- [All Tools](docs/tools.html)
- [CLI Reference](docs/cli-reference.html)
- [Agent Profiles](docs/profiles.html)
- [Task Templates](docs/templates.html)
- [Custom Plugins](docs/plugins.html)
- [Docker Guide](docs/docker.html)
- [Configuration](docs/configuration.html)
- [Security](docs/security.html)
- [Examples Gallery](docs/examples.html)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup,
code style, and how to add new tools.

All contributions welcome: new tools, bug fixes, docs improvements,
new templates, plugin examples.

---

## Support This Project

Forge Agent is free and open source. If it saves you time:

- ⭐ **Star the repo** — helps others discover it
- 💰 **[Sponsor development](https://github.com/sponsors/puneet-swarup)**
- 📢 **Share it** — post about it, tell your team
- 🐛 **Report bugs** — good reports make it better
- 📝 **Improve docs** — any PR helps

---

## License

MIT — see [LICENSE](LICENSE)
