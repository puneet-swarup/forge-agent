// tests/ollama-page-contract.test.js — the adapter and its bundled page must agree.
//
// The ollama adapter shipped selectors for #send-button and #new-chat while the
// page it drives has #send-btn and #new-chat-btn. Nothing caught it: the
// selectors were only ever exercised against a live browser, and the failure
// looked like "the UI changed" rather than "these two files disagree".
//
// Both files are in this repository. This test reads them and compares, so a
// rename on either side fails here instead of on someone's machine.
'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'html', 'local-ollama-chat.html'), 'utf8');

const OllamaAdapter = require('../src/adapters/ollama-adapter');
const selectorsFor = (method) => Object.create(OllamaAdapter.prototype)[method]();

/** Every id the page defines. */
const pageIds = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

/** Every class token the page defines. */
const pageClasses = new Set(
  [...HTML.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
);

/** The id or class a simple selector depends on. */
function dependencyOf(selector) {
  const id = selector.match(/^#([\w-]+)$/);
  if (id) return { kind: 'id', name: id[1] };

  const tagId = selector.match(/^[a-z]+\[?[^#]*#([\w-]+)/);
  if (tagId) return { kind: 'id', name: tagId[1] };

  const cls = selector.match(/^\.([\w-]+)$/);
  if (cls) return { kind: 'class', name: cls[1] };

  return null; // structural or attribute selector: nothing to check here
}

describe('the ollama adapter matches the page it ships', () => {
  const groups = {
    input: '_getInputSelectors',
    send: '_getSendSelectors',
    newChat: '_getNewChatSelectors',
    stop: '_getStopSelectors',
  };

  for (const [group, method] of Object.entries(groups)) {
    test(`${group}: at least one selector exists in the page`, () => {
      const deps = selectorsFor(method).map(dependencyOf).filter(Boolean);

      const found = deps.filter((d) =>
        d.kind === 'id' ? pageIds.has(d.name) : pageClasses.has(d.name));

      expect(found.length).toBeGreaterThan(0);
    });
  }

  test('the composer selector is the page\'s textarea', () => {
    expect(selectorsFor('_getInputSelectors')).toContain('textarea#chat-input');
    expect(pageIds.has('chat-input')).toBe(true);
  });

  test('the send selector names an id the page has', () => {
    // The regression: #send-button vs #send-btn.
    const sendIds = selectorsFor('_getSendSelectors')
      .map(dependencyOf)
      .filter((d) => d && d.kind === 'id')
      .map((d) => d.name);

    expect(sendIds.some((id) => pageIds.has(id))).toBe(true);
    expect(pageIds.has('send-btn')).toBe(true);
  });

  test('the new-chat selector names an id the page has', () => {
    const ids = selectorsFor('_getNewChatSelectors')
      .map(dependencyOf)
      .filter((d) => d && d.kind === 'id')
      .map((d) => d.name);

    expect(ids.some((id) => pageIds.has(id))).toBe(true);
  });

  test('the response selector targets the class the page renders', () => {
    // The page sets className = `message ${role}`, so `.message.assistant` is real.
    const src = HTML.includes('message ${role}') || HTML.includes("'message ' + role");
    expect(src).toBe(true);
    expect(selectorsFor('_getResponseSelectors').join(' ')).toContain('assistant');
  });

  test('the page posts to an OpenAI-compatible path', () => {
    // The page proxies to OLLAMA_BASE_URL; a real Ollama daemon and a llama.cpp
    // server both serve /v1/chat/completions, so the page and the probe agree.
    expect(HTML).toMatch(/\/api\/chat|\/v1\/chat\/completions/);
  });
});
