# Google Adapter — Feasibility & Design

## Verdict

A Google adapter can be implemented and is worthwhile, but not as a
"Google Search scraper". Google's search results page (google.com/search?q=...)
contains no model that understands the Forge tool-call protocol and will never
emit {"name": ..., "args": ...} JSON. Treating it as a chat backend is
architecturally wrong.

## Two viable paths

### Path A — Drive the live chat composer (chosen)

The adapter behaves like every other Forge adapter: it attaches to an
LLM chat UI in the already-open Playwright browser, discovers the composer,
types the prompt, presses send, and scrapes the reply. This is the same loop
used by chatgpt-adapter.js, gemini-adapter.js, deepseek-adapter.js and
qwen-adapter.js. The only Google-specific work is a correct set of selectors
for whichever Google surface the user has parked the browser on:

- gemini.google.com/app — Gemini chat (handled by gemini-adapter.js)
- google.com/search?...&udm=50 — AI Mode / AI Overview panel
- google.com/ai — AI Mode chat surface

The adapter uses broad selectors so it keeps working across all three.

### Path B — Google Search grounding via an API

Calling Gemini's API with the google_search tool would give real AI answers,
but requires an API key and moves Forge off its "no API key" design. It is not
appropriate for the default google model entry.

## Why the old implementation failed

google-adapter.js previously did:

js
const searchUrl = `https://google.com/search?q=${encodeURIComponent(text)}`;
await this.page.goto(searchUrl, ...);


This has three problems:

1. The full system prompt (tens of KB) is shoved into a URL — it gets truncated
 and search engines reject it.
2. The result page is SERP HTML, not a conversation, so waitForResponse
 scraped ads/snippets instead of a model reply.
3. It broke the base-class contract: sendMessage bypassed _typeText, send
 delays and the _isFirstMessage / project-context logic.

## New implementation

The rewritten adapter:

- Extends BaseAdapter and inherits sendMessage / waitForResponse — no
 URL-navigation bypass.
- Provides Google AI-mode selectors (composer, send button, stop button, AI
 answer container) with fallbacks for the classic search box.
- Uses discoverComposer / discoverSendButton / discoverLatestResponse
 overrides that prefer the last matching element (AI chat lives at the
 bottom of the page).
- Falls back gracefully when the browser is parked on a plain search page.

## Limitations

- AI Overview panels are not a full chat: they do not accept multi-turn
 tool-call loops well. For reliable Forge runs prefer --model=gemini.
- Selectors track Google's UI and may need maintenance.
- The adapter refuses to run against google.com/search?q= for the protocol
 prompt and logs a warning directing users to Gemini or AI Mode.
