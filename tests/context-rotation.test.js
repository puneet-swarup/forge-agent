// tests/context-rotation.test.js — the remote context is rotated on our terms.
//
// The model's real context window belongs to the remote chat, not to this
// process. `ConversationManager.compress()` rewrites a local log that is never
// re-sent, so the remote context grows until the provider truncates it silently
// — and the model then loses the tool contract and answers in prose. Rotation
// starts a fresh chat on our schedule and re-sends the contract plus a digest.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/permission-menu', () => ({
  showPermissionMenu: jest.fn(async () => 'session'),
}));

describe('ConversationManager.resetTo', () => {
  test('replaces the log with a single message', () => {
    const { ConversationManager } = require('../src/prompt');
    const cm = new ConversationManager();
    cm.messages.push({ role: 'user', content: 'a' });
    cm.messages.push({ role: 'assistant', content: 'b' });

    cm.resetTo('the resume message');

    expect(cm.messages).toHaveLength(1);
    expect(cm.messages[0]).toEqual({ role: 'user', content: 'the resume message' });
  });
});

describe('rotation in the loop', () => {
  let workdir;
  let config;
  let orig;

  beforeEach(() => {
    config = require('../src/config');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rotate-'));
    orig = { ...config };
    config.WORKING_DIR = workdir;
    config.MEMORY_ENABLED = false;
    config.NO_TUI = true;
    config.VERIFY_BEFORE_COMPLETE = false;
    config.CONTEXT_ROTATION_TURNS = 3;
  });

  afterEach(() => {
    Object.assign(config, orig);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  function makeAgent(responses) {
    const queue = [...responses];
    const ForgeAgent = require('../src/agent');
    const agent = new ForgeAgent({});
    const sent = [];
    const chats = { count: 0 };

    agent.browser = {
      async launch() {}, async close() {},
      async newChat() { chats.count++; },
      async sendMessage(t) { sent.push(t); },
      async waitForResponse() {
        if (!queue.length) throw new Error('no scripted response left');
        return queue.shift();
      },
    };
    return { agent, sent, chats };
  }

  const toolCall = '<tool_call>{"tool":"list_directory","args":{}}</tool_call>';

  test('rotates after N turns, with the contract in the new chat', async () => {
    const { agent, sent, chats } = makeAgent([
      toolCall, toolCall, toolCall,       // 3 turns -> rotation
      toolCall,                            // after rotation
      'done\nTASK_COMPLETE',
    ]);

    const result = await agent.run('keep going');

    expect(result).toContain('TASK_COMPLETE');
    expect(chats.count).toBe(1);

    const resume = sent.find((m) => m.includes('CONTEXT RESET'));
    expect(resume).toBeTruthy();
    expect(resume).toContain('<<<FORGE_START>>>');       // the contract
    expect(resume).toContain('keep going');              // the task
    expect(resume).toMatch(/routine rotation after 3 turns/);
  }, 60000);

  test('the turn counter resets, so rotation repeats on schedule', async () => {
    config.CONTEXT_ROTATION_TURNS = 2;
    const { agent, chats } = makeAgent([
      toolCall, toolCall,          // rotation 1
      toolCall, toolCall,          // rotation 2
      'done\nTASK_COMPLETE',
    ]);

    await agent.run('keep going');
    expect(chats.count).toBe(2);
  }, 60000);

  test('the local log is trimmed to the resume message', async () => {
    const { agent } = makeAgent([toolCall, toolCall, toolCall, 'done\nTASK_COMPLETE']);
    await agent.run('keep going');

    // After rotation the log mirrors the new chat: the resume message only,
    // plus whatever the run appended afterwards.
    expect(agent.conversation.messages.length).toBeLessThan(6);
  }, 60000);

  test('rotation can be switched off', async () => {
    config.CONTEXT_ROTATION_TURNS = 0;
    const { agent, chats } = makeAgent([toolCall, toolCall, toolCall, toolCall, 'done\nTASK_COMPLETE']);

    await agent.run('keep going');
    expect(chats.count).toBe(0);
  }, 60000);

  test('stall recovery and rotation share one code path', async () => {
    const ForgeAgent = require('../src/agent');
    const agent = new ForgeAgent({});
    expect(agent._recoverWithNewChat.constructor.name).toBe('AsyncFunction');
    // _recoverWithNewChat delegates to _rotateChat rather than duplicating it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
    expect(src).toMatch(/_recoverWithNewChat\(task, progress\) \{\s*return this\._rotateChat/);
  });
});
