// tests/helpers/mock-chat-server.js - a tiny local web page that mimics a
// chat UI so the adapter's send -> scrape loop can be exercised end-to-end in
// CI without a real login or network.
//
// It serves one HTML page implementing the selectors the DeepSeek adapter
// looks for. When a message is "sent", it appends an assistant reply after a
// short delay, optionally streaming it to emulate real generation.
//
// Assistant bubbles deliberately include an action toolbar (Copy / Download)
// and a hidden raw copy of the reply, just like DeepSeek, so the scraper can
// be tested for chrome leakage and duplicated output.
'use strict';

const http = require('http');

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock Chat</title></head>
<body>
  <main class="chat-content" id="messages"></main>
  <textarea id="chat-input" placeholder="Message"></textarea>
  <button type="submit" id="send" aria-label="Send">Send</button>
  <script>
    const messages = document.getElementById('messages');
    const input    = document.getElementById('chat-input');
    const send     = document.getElementById('send');

    // Build a message bubble. Assistant bubbles carry a message-action
    // toolbar (Copy/Download) plus a hidden raw copy of the text, mirroring
    // the DeepSeek DOM that used to leak "Copy"/"Download" and duplicates.
    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = role === 'assistant' ? 'assistant message' : 'user message';
      div.setAttribute('data-role', role);

      const body = document.createElement('span');
      body.className = 'reply-text';
      body.textContent = text;
      div.appendChild(body);

      if (role === 'assistant') {
        const bar = document.createElement('div');
        bar.className = 'message-actions toolbar';
        const copy = document.createElement('button');
        copy.setAttribute('aria-label', 'Copy');
        copy.textContent = 'Copy';
        const dl = document.createElement('button');
        dl.setAttribute('aria-label', 'Download');
        dl.textContent = 'Download';
        bar.appendChild(copy);
        bar.appendChild(dl);
        div.appendChild(bar);

        const raw = document.createElement('div');
        raw.className = 'raw-copy';
        raw.setAttribute('aria-hidden', 'true');
        raw.style.display = 'none';
        raw.textContent = text;
        div.appendChild(raw);
      }

      messages.appendChild(div);
      return body;
    }

    // A stop button is present while the assistant is generating — exactly
    // what the adapter's _isGenerating() probe looks for. It is removed the
    // instant streaming finishes, so a mid-stream pause is NOT mistaken for
    // completion.
    let generating = 0;
    function showGenerating() {
      generating++;
      if (!document.getElementById('stop')) {
        const b = document.createElement('button');
        b.id = 'stop';
        b.setAttribute('aria-label', 'Stop generating');
        b.textContent = 'Stop';
        document.body.appendChild(b);
      }
    }
    function hideGenerating() {
      generating = Math.max(0, generating - 1);
      if (generating === 0) {
        const b = document.getElementById('stop');
        if (b) b.remove();
      }
    }

    function replyFor(userText) {
      // Deterministic canned replies the tests can assert on.
      if (userText.includes('TOOLCALL')) {
        var bt = String.fromCharCode(96);   // backtick
        var fence = bt + bt + bt;
        var nl = String.fromCharCode(10);
        return 'Here is the call:' + nl + nl + fence + 'tool_call' + nl + '{"name":"show_info","args":{"content":"hi"}}' + nl + fence + nl;
      }
      return 'Echo: ' + userText;
    }

    // Stream text into a node one character at a time while showing the
    // generating (stop) indicator, then clear it and resolve.
    function streamInto(node, text, onDone) {
      showGenerating();
      let i = 0;
      const stream = setInterval(() => {
        node.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(stream);
          hideGenerating();
          if (onDone) onDone();
        }
      }, 8);
    }

    send.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      addMessage('user', text);
      input.value = '';
      const node = addMessage('assistant', '');

      // PAUSE_TEST: stream "part one", pause longer than STABLE_DELAY
      // mid-generation, then stream "part two". A correct scraper must NOT
      // accept the mid-stream quiet gap as completion.
      if (text.includes('PAUSE_TEST')) {
        const first  = 'part one ';
        const second = 'part two done';
        const full   = '<<<FORGE_START>>>' + first + second + '<<<FORGE_END>>>';
        // Keep the generating indicator up for the WHOLE reply, including the
        // mid-stream pause, so the adapter's _isGenerating() probe correctly
        // reports "still working" and does not return a half response.
        showGenerating();
        let i = 0;
        let paused = false;
        let pausedOnce = false;
        const s = setInterval(() => {
          if (!paused && !pausedOnce && i >= first.length) {
            paused = true;
            pausedOnce = true; // one-shot: do not re-pause after resuming
            setTimeout(() => { paused = false; }, 900); // quiet gap > STABLE_DELAY
            return;
          }
          if (paused) return;
          node.textContent = full.slice(0, ++i);
          if (i >= full.length) {
            clearInterval(s);
            hideGenerating();
          }
        }, 8);
        return;
      }

      // NO_MARKER_TEST: reply WITHOUT the response envelope, to exercise the
      // adapter's DOM-quiet fallback path (markers absent => still correct).
      if (text.includes('NO_MARKER_TEST')) {
        streamInto(node, replyFor(text));
        return;
      }

      // WS_MARKER_TEST: markers with surrounding whitespace and a little prose
      // BEFORE the START marker (a sloppy-but-honouring model). Adapter must
      // still detect END-after-START and strip markers from the returned text.
      if (text.includes('WS_MARKER_TEST')) {
        const NL = String.fromCharCode(10);
        const body = 'Sure, here you go:' + NL + NL +
          '  <<<FORGE_START>>>  ' + NL + 'answer-body' + NL + '  <<<FORGE_END>>>  ' + NL;
        streamInto(node, body);
        return;
      }

      // Default: wrap the reply in the explicit response envelope markers that
      // the system prompt asks the model to emit. This lets the adapter detect
      // completion deterministically via <<<FORGE_END>>> instead of guessing.
      const START = '<<<FORGE_START>>>';
      const END   = '<<<FORGE_END>>>';
      const NL    = String.fromCharCode(10);
      streamInto(node, START + NL + replyFor(text) + NL + END);
    });
  </script>
</body></html>`;

/**
 * Start the mock chat server.
 * @param {number} [port]  0 = random free port
 * @returns {Promise<{ url:string, port:number, close:Function }>}
 */
function startMockChatServer(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + p,
        port: p,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockChatServer };
