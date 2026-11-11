# Local Ollama and Colab (Remote Tunnel) Adapters

This page explains the three self-hosted adapters, when to use each, how they
are configured, and how a locally installed model becomes reachable.

## TL;DR — which flag do I use?

| Flag | Adapter | Use when | Endpoint |
|---|---|---|---|
| `--model=ollama` | `ollama-adapter.js` | You installed Ollama on this machine | `http://localhost:11434` |
| `--model=colab` | `colab-adapter.js` | A Colab notebook is exposed via ngrok | your tunnel URL |
| `--model=local` | `local-chat-adapter.js` | Any OpenAI-compatible endpoint | `OLLAMA_BASE_URL` |

## Why the split?

The original code had a single `local-chat-adapter.js` acting as a **proxy**:
it starts a local HTTP server (port 1337) that serves a chat UI and forwards
`/api/chat` to whatever `OLLAMA_BASE_URL` points at.

That was overloaded. It conflated two very different deployments:

1. **A locally installed model** (Ollama daemon on `localhost:11434`).
2. **A remote tunnel** (a Colab/ngrok endpoint), which usually requires an
   API key and is reached over the public internet.

Keeping the tunnel logic in the "local" adapter meant:

- Misleading naming: `--model=local` reached a *remote* server.
- Silent fallback: a missing URL defaulted to `localhost`, so a remote run
   could quietly hit the wrong backend.
- No place for tunnel-specific behaviour (auth headers, ngrok interstitial
   bypass, clearer configuration errors).

The fix introduces a dedicated `colab-adapter.js` that extends the proxy but
hard-requires a remote endpoint and warns loudly when it is misconfigured.
The generic proxy (`local-chat-adapter.js`) stays available as `--model=local`.

## Locally installed models (Ollama)

If you have Ollama installed, the model runs on your own machine. You do
**not** need a tunnel, an API key, or any remote service.

### 1. Start the daemon and install a model

```bash
ollama serve                 # listens on http://localhost:11434
ollama pull deepseek-r1:8b   # download a model
```

### 2. Point Forge Agent at it

```bash
forge-agent --model=ollama --local-model deepseek-r1:8b "your task"
```

### How it becomes accessible

`ollama-adapter.js` reads `OLLAMA_BASE_URL` (default `http://localhost:11434`)
and `OLLAMA_MODEL`, then calls the daemon's OpenAI-compatible
`/v1/chat/completions` route directly. `getModelUrl()` points the embedded UI
at the same daemon. Because everything is loopback, no firewall hole or
bearer token is involved.

Useful environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Daemon address |
| `OLLAMA_MODEL` | `deepseek-r1:8b` | Model to request |
| `OLLAMA_UI_URL` | (same as base) | UI URL override |

## Remote Colab / ngrok tunnel

A Colab notebook often exposes an OpenAI-compatible server through ngrok.
That endpoint is remote, is usually bearer-token protected, and its URL
changes every session.

### Configure and run

```bash
forge-agent --model=colab \
  --model-url https://your-tunnel.ngrok-free.dev \
  --api-key "$COLAB_API_KEY" "your task"
```

Or via a gitignored `.env` (copy `.env.example`):

```dotenv
OLLAMA_BASE_URL=https://your-tunnel.ngrok-free.dev
OLLAMA_API_KEY=your-key
OLLAMA_MODEL=deepseek-r1-16k:latest
```

Then: `forge-agent --model=colab "your task"`.

### Configuration precedence

Highest to lowest:

1. CLI flags (`--model-url`, `--api-key`, `--local-model`, `--local-port`)
2. Real environment variables
3. `.env` file in the project root (loaded by `src/config.js`)
4. `forge-agent.config.json`
5. Built-in defaults

The API key is never hard-coded. Keep it in `.env` (gitignored).

### Tunnel behaviour

`colab-adapter.js` adds the `ngrok-skip-browser-warning` header so free ngrok
tunnels return JSON instead of an HTML interstitial, and sends
`Authorization: Bearer <key>` when a key is configured. `probe()` checks the
endpoint's `/v1/models` route and never throws.

## Dedicated instances (no throttle)

All three self-hosted adapters set `static DEDICATED_INSTANCE = true`, so
`BaseAdapter._sendDelayMs()` returns `0` — there is no artificial delay
between prompts because you own the backend. Public browser UIs keep the
default `SEND_DELAY` throttle.

## Testing

Dedicated test suites cover both adapters and the factory registration:

- `tests/ollama-adapter.test.js` — daemon URL/model resolution, probe safety.
- `tests/colab-adapter.test.js` — inheritance, dedicated flag, config/env
  precedence, endpoint building, invalid-URL handling, probe never throws,
  factory alias resolution (`colab`/`tunnel`/`ngrok`/`remote-ollama`).
- `tests/colab-adapter-config.test.js` — DEFAULTS keys, CLI flag overrides,
  `.env.example` presence.

Run them with:

```bash
npx jest tests/colab-adapter.test.js tests/ollama-adapter.test.js tests/colab-adapter-config.test.js
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_NGROK_3200` / endpoint offline | Colab notebook not running or tunnel closed | Start the notebook / restart ngrok |
| HTML returned instead of JSON | ngrok browser warning | Handled automatically by the adapter; ensure you use `--model=colab` |
| 401/403 from endpoint | Missing/invalid API key | Set `OLLAMA_API_KEY` / `--api-key` |
| Connection refused on :11434 | Ollama not running | Run `ollama serve` |
| `[Colab] No remote OLLAMA_BASE_URL configured` | URL left at localhost | Pass `--model-url` or set `OLLAMA_BASE_URL` |
