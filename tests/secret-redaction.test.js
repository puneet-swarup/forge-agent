// tests/secret-redaction.test.js — nothing secret leaves the machine.
//
// Everything the agent reads is sent to a third-party chat UI, which keeps its
// own history. `.env` was masked by read_file, but a key in a config module, a
// Kubernetes manifest or a PEM went out verbatim. security.sanitiseOutput()
// existed but was only applied to the saved history file.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

const { redactSecrets, redactSecretsText } = require('../src/security');

describe('redactSecrets — token shapes', () => {
  const cases = [
    ['openai-key', 'key = "sk-abcdefghijklmnopqrstuvwxyz012345"'],
    ['aws-access-key', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['github-token', 'token: ghp_' + 'a'.repeat(36)],
    ['slack-token', 'xoxb-123456789012-abcdefghijkl'],
    ['google-api-key', 'key=AIza' + 'B'.repeat(35)],
    ['stripe-key', 'sk_live_' + 'a1'.repeat(12)],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ];

  test.each(cases)('redacts a %s', (kind, input) => {
    const { text, redactions } = redactSecrets(input);
    expect(text).not.toBe(input);
    expect(text).toContain('[REDACTED');
    expect(redactions.map((r) => r.kind)).toContain(kind);
  });

  test('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const { text, redactions } = redactSecrets(pem);
    expect(text).toBe('[REDACTED:private-key]');
    expect(redactions[0].kind).toBe('private-key');
  });

  test('redacts a credential assignment but keeps the key name', () => {
    const { text } = redactSecrets('const cfg = { apiKey: "abcd1234efgh5678", port: 3000 };');
    expect(text).toContain('apiKey: "[REDACTED]"');
    expect(text).toContain('port: 3000');
  });

  test('redacts a secret .env line but leaves references and flags', () => {
    const input = [
      'DB_PASSWORD=hunter2supersecret',
      'API_KEY=${ENV_KEY}',
      'EMPTY_TOKEN=',
      'DEBUG=true',
    ].join('\n');

    const { text } = redactSecrets(input);
    expect(text).toContain('DB_PASSWORD=[REDACTED]');
    expect(text).toContain('API_KEY=${ENV_KEY}');   // a reference, not a secret
    expect(text).toContain('DEBUG=true');
  });
});

describe('redactSecrets — must not damage ordinary code', () => {
  const safe = [
    'const apiKey = process.env.API_KEY;',
    'const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";',
    'integrity: "sha512-abc123+/def456=="',
    'if (password.length < 8) throw new Error("too short");',
    'tokenCount = 42;',
    'const url = "https://example.com/a/b?c=d";',
    'app.listen(PORT, () => console.log(`listening on ${PORT}`));',
  ];

  test.each(safe)('leaves %s untouched', (line) => {
    const { text, redactions } = redactSecrets(line);
    expect(text).toBe(line);
    expect(redactions).toHaveLength(0);
  });

  test('leaves a whole source file untouched', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'parser.js'), 'utf8');
    const { text, redactions } = redactSecrets(src);
    expect(text).toBe(src);
    expect(redactions).toHaveLength(0);
  });

  test('handles non-strings without throwing', () => {
    expect(redactSecrets(null).text).toBe('');
    expect(redactSecrets(undefined).text).toBe('');
    expect(redactSecretsText(123)).toBe('123');
  });
});

describe('agent egress', () => {
  let workdir;
  let orig;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-red-'));
    const config = require('../src/config');
    orig = { WORKING_DIR: config.WORKING_DIR, MEMORY_ENABLED: config.MEMORY_ENABLED };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
  });

  afterEach(() => {
    const config = require('../src/config');
    Object.assign(config, orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('a secret read from a config file never reaches the browser', async () => {
    fs.writeFileSync(
      path.join(workdir, 'config.js'),
      'module.exports = { apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz" };\n',
      'utf8'
    );

    const DeepSeekAgent = require('../src/agent');
    const agent = new DeepSeekAgent({});

    const sent = [];
    agent.browser = {
      async launch() {}, async close() {}, async newChat() {},
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() {
        if (sent.length === 1) {
          return '<tool_call>{"tool":"read_file","args":{"path":"config.js"}}</tool_call>';
        }
        return 'done\nTASK_COMPLETE';
      },
    };

    await agent.run('read the config');

    const outbound = sent.join('\n');
    expect(outbound).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz');
    expect(outbound).toContain('[REDACTED');
  }, 30000);

  test('_forEgress reports what it redacted and preserves clean text', () => {
    const DeepSeekAgent = require('../src/agent');
    const agent = new DeepSeekAgent({});

    expect(agent._forEgress('read_file', 'plain text')).toBe('plain text');
    expect(agent._forEgress('read_file', 'x = "AKIAIOSFODNN7EXAMPLE"')).toContain('[REDACTED:aws-access-key]');
  });
});
