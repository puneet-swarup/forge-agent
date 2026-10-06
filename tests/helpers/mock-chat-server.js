// tests/helpers/mock-chat-server.js - a tiny local web page that mimics a
// chat UI so the adapter's send -> scrape loop can be exercised end-to-end in
// CI without a real login or network.
//
// It serves one HTML page implementing the selectors the DeepSeek adapter
// looks for. When a message is "sent", it appends an assistant reply after a
// short delay, optionally streaming it to emulate real generation.
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

    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = role === 'assistant' ? 'assistant message' : 'user message';
      div.setAttribute('data-role', role);
      div.className += ' markdown-content';
      div.textContent = text;
      messages.appendChild(div);
      return div;
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

    send.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      addMessage('user', text);
      input.value = '';
      const reply = replyFor(text);
      // Emulate streaming: reveal the reply in chunks.
      const node = addMessage('assistant', '');
      let i = 0;
      const stream = setInterval(() => {
        node.textContent = reply.slice(0, ++i);
        if (i >= reply.length) clearInterval(stream);
      }, 8);
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
