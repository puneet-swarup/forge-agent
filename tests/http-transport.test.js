// tests/http-transport.test.js — step 2: a model with no browser at all.
//
// These tests launch no Playwright. That is the point: `local` and `colab`
// currently start a browser, serve a bundled page and scrape it to make one HTTP
// call. If the contract is right, an endpoint needs none of that — and this file
// is the proof, because it runs in a fraction of a second with no browser job.
'use strict';

const http = require('http');

const { HttpChatTransport, completionUrl } = require('../src/http-transport');
const { conforms } = require('../src/chat-transport');

/** A stand-in OpenAI-compatible server. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** The happy path: echo back a fixed reply. */
const replyWith = (text) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
};

describe('endpoint URL', () => {
  test('a bare host gets the full path', () => {
    expect(completionUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/chat/completions');
  });

  test('a /v1 base gets only the rest', () => {
    expect(completionUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
  });

  test('a full path is left alone', () => {
    const full = 'https://x.ngrok-free.dev/v1/chat/completions';
    expect(completionUrl(full)).toBe(full);
  });

  test('a trailing slash does not double up', () => {
    expect(completionUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1/chat/completions');
  });
});

describe('the contract', () => {
  test('it conforms', () => {
    expect(conforms(new HttpChatTransport({ baseUrl: 'http://x' })).ok).toBe(true);
  });

  test('it declares what it can do, and no page to watch', () => {
    const caps = new HttpChatTransport({ baseUrl: 'http://x' }).capabilities;
    expect(caps.observable).toBe(false);
    expect(caps.stop).toBe(true);
    expect(caps.uploads).toBe(false);
  });
});

describe('a full turn', () => {
  test('send then awaitReply returns the reply', async () => {
    const { server, url } = await startServer(replyWith('OK'));
    const t = new HttpChatTransport({ baseUrl: url, model: 'deepseek-r1' });

    try {
      await t.send('Reply with exactly: OK');
      await expect(t.awaitReply()).resolves.toBe('OK');
    } finally {
      server.close();
    }
  });

  test('the request carries the conversation and the model name', async () => {
    let seen = null;
    const { server, url } = await startServer((req, res, body) => {
      seen = JSON.parse(body);
      replyWith('fine')(req, res);
    });
    const t = new HttpChatTransport({ baseUrl: url, model: 'deepseek-r1' });

    try {
      await t.send('hello');
      await t.awaitReply();
      expect(seen.model).toBe('deepseek-r1');
      expect(seen.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(seen.stream).toBe(false);
    } finally {
      server.close();
    }
  });

  test('the assistant reply joins the history for the next turn', async () => {
    const { server, url } = await startServer(replyWith('first'));
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('one');
      await t.awaitReply();
      await t.send('two');
      await t.awaitReply();

      expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    } finally {
      server.close();
    }
  });

  test('newChat drops the history', async () => {
    const { server, url } = await startServer(replyWith('x'));
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('one');
      await t.awaitReply();
      await t.newChat();
      expect(t.messages).toEqual([]);
    } finally {
      server.close();
    }
  });

  test('isGenerating is true between send and reply', async () => {
    const { server, url } = await startServer((req, res) => {
      setTimeout(() => replyWith('slow')(req, res), 60);
    });
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('hi');
      expect(await t.isGenerating()).toBe(true);
      await t.awaitReply();
      expect(await t.isGenerating()).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('failure is a throw with a reason', () => {
  test('a non-200 carries the server message', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"model not found"}}');
    });
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('hi');
      await expect(t.awaitReply()).rejects.toThrow(/400.*model not found/s);
    } finally {
      server.close();
    }
  });

  test('a non-JSON body says so, because that is a different bug', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>You are about to visit ngrok</html>');
    });
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('hi');
      await expect(t.awaitReply()).rejects.toThrow(/did not return JSON/);
    } finally {
      server.close();
    }
  });

  test('an unreachable endpoint fails without hanging', async () => {
    const t = new HttpChatTransport({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 });
    await t.send('hi');
    await expect(t.awaitReply()).rejects.toThrow(/request failed/);
  });

  test('no endpoint configured is refused at send, not at await', async () => {
    const t = new HttpChatTransport({ baseUrl: '' });
    await expect(t.send('hi')).rejects.toThrow(/no endpoint/);
  });

  test('awaitReply without send is an error, not a silent empty reply', async () => {
    await expect(new HttpChatTransport({ baseUrl: 'http://x' }).awaitReply())
      .rejects.toThrow(/no prompt in flight/);
  });

  test('a timeout is reported in seconds', async () => {
    const { server, url } = await startServer(() => { /* never answers */ });
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('hi');
      await expect(t.awaitReply({ timeoutMs: 100 })).rejects.toThrow(/no reply within/);
    } finally {
      server.close();
    }
  });
});

describe('stop', () => {
  test('aborting in flight rejects the reply and clears the state', async () => {
    const { server, url } = await startServer(() => { /* never answers */ });
    const t = new HttpChatTransport({ baseUrl: url });

    try {
      await t.send('hi');
      const pending = t.awaitReply({ timeoutMs: 5000 });
      await t.stop();

      await expect(pending).rejects.toThrow(/stopped/);
      expect(await t.isGenerating()).toBe(false);
    } finally {
      server.close();
    }
  });

  test('stop with nothing in flight is a no-op, not an error', async () => {
    const t = new HttpChatTransport({ baseUrl: 'http://x' });
    await expect(t.stop()).resolves.toEqual({ stopped: false });
  });
});
