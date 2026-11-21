// tests/prompt-single-source.test.js — there is exactly ONE system prompt.
//
// The regression this locks down: src/prompt.js and src/system-prompt.js each
// built a complete, different prompt. agent.js sent one; the tests validated
// the other. The model was judged against a contract it never saw.
'use strict';

const fs = require('fs');
const path = require('path');

const promptModule = require('../src/prompt');
const systemPrompt = require('../src/system-prompt');
const { TOOLS } = require('../src/tools');

const START = '<<<FORGE_START>>>';
const END = '<<<FORGE_END>>>';

describe('single prompt source', () => {
  test('prompt.js re-exports the one builder from system-prompt.js', () => {
    expect(promptModule.buildSystemPrompt).toBe(systemPrompt.buildSystemPrompt);
  });

  test('prompt.js contains no prompt text of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'prompt.js'), 'utf8');
    expect(src).not.toMatch(/You are Forge Agent/);
    expect(src).not.toMatch(/AVAILABLE TOOLS/);
  });

  test('no other module embeds a system prompt', () => {
    const dir = path.join(__dirname, '..', 'src');
    const offenders = [];

    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!entry.name.endsWith('.js')) continue;
        if (entry.name === 'system-prompt.js') continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/You are Forge Agent/.test(src)) offenders.push(path.relative(dir, p));
      }
    };

    walk(dir);
    expect(offenders).toEqual([]);
  });
});

describe('the prompt the agent actually sends', () => {
  const message = promptModule.buildFirstMessage('add JWT auth', './a.js', 'default', '');

  test('requires the response envelope the adapter completes on', () => {
    expect(message).toContain(START);
    expect(message).toContain(END);
  });

  test('states one call format only', () => {
    expect(message).toContain('<tool_call>');
    expect(message).toContain('</tool_call>');
    expect(message).not.toMatch(/```tool_call/);
  });

  test('states the stopping rule', () => {
    expect(message).toContain('TASK_COMPLETE');
  });

  test('states the artifact protocol that lifecycle.js enforces', () => {
    expect(message).toContain('MANDATORY ARTIFACTS PROTOCOL');
    expect(message).toContain('FORGE_PLAN.md');
    expect(message).toContain('SESSION_CONTEXT.md');
  });

  test('does not ask the model to base64-encode source code', () => {
    expect(message).not.toMatch(/must\s+base64/i);
  });

  test('fits the context budget (a 22.5k first message was paid on every chat)', () => {
    expect(message.length).toBeLessThan(16000);
  });

  test('includes the task and the directory listing', () => {
    expect(message).toContain('add JWT auth');
    expect(message).toContain('./a.js');
  });

  test('injects project context when provided', () => {
    const m = promptModule.buildFirstMessage('t', null, 'default', '', {
      projectContext: 'PROJECT-CONTEXT-SENTINEL',
    });
    expect(m).toContain('PROJECT-CONTEXT-SENTINEL');
  });

  test('adds the profile section only when a non-default profile is active', () => {
    const withProfile = promptModule.buildFirstMessage('t', null, 'backend', '');
    const without = promptModule.buildFirstMessage('t', null, 'default', '');
    expect(withProfile).toContain('ACTIVE PROFILE: BACKEND');
    expect(without).not.toContain('ACTIVE PROFILE');
  });
});

describe('tool catalogue is generated from the registry', () => {
  const docs = systemPrompt.buildToolDocumentation();

  test('every registered tool is documented — none can be orphaned', () => {
    const missing = Object.keys(TOOLS).filter((name) => !docs.includes(name + '('));
    expect(missing).toEqual([]);
  });

  test('documented tools all exist in the registry', () => {
    const documented = [...docs.matchAll(/^ {2}([a-z_]+)\(/gm)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(20);
    for (const name of documented) {
      expect(TOOLS).toHaveProperty(name);
    }
  });

  test('required arguments are marked', () => {
    expect(docs).toMatch(/read_file\(path\*/);
  });
});

describe('resume message restores the contract', () => {
  const { ConversationManager } = promptModule;

  test('carries the envelope, the call format and the task', () => {
    const cm = new ConversationManager();
    const msg = cm.buildResumeMessage({
      task: 'RESUME-TASK-SENTINEL',
      progress: 'wrote src/a.js',
      plan: '- [x] one\n- [ ] two',
      recentErrors: ['ENOENT: nope'],
      reason: 'the previous chat stalled',
    });

    expect(msg).toContain(START);
    expect(msg).toContain('<tool_call>');
    expect(msg).toContain('RESUME-TASK-SENTINEL');
    expect(msg).toContain('wrote src/a.js');
    expect(msg).toContain('- [ ] two');
    expect(msg).toContain('ENOENT: nope');
    expect(msg).toMatch(/the previous chat stalled/);
  });

  test('is recorded in the conversation so logs stay coherent', () => {
    const cm = new ConversationManager();
    const msg = cm.buildResumeMessage({ task: 't' });
    expect(cm.messages[cm.messages.length - 1].content).toBe(msg);
  });
});
