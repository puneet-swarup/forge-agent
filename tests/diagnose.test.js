// tests/diagnose.test.js — the report a human uses to fix an adapter.
//
// `--test-model` says "not ready". This says which of the eleven send-button
// candidates matched, and what the buttons on the page actually look like.
'use strict';

const diagnose = require('../src/diagnose');

describe('selectorsFor', () => {
  test('reads the declared selectors for a group', () => {
    const adapter = { _getSendSelectors: () => ['a', 'b'] };
    expect(diagnose.selectorsFor(adapter, 'send')).toEqual(['a', 'b']);
  });

  test('an adapter without the method yields an empty list, not a throw', () => {
    expect(diagnose.selectorsFor({}, 'send')).toEqual([]);
  });

  test('a method that throws is contained', () => {
    const adapter = { _getSendSelectors: () => { throw new Error('boom'); } };
    expect(diagnose.selectorsFor(adapter, 'send')).toEqual([]);
  });

  test('an unknown group yields an empty list', () => {
    expect(diagnose.selectorsFor({ _getSendSelectors: () => ['a'] }, 'nonsense')).toEqual([]);
  });
});

describe('probeSelectors', () => {
  function fakePage(matches) {
    return {
      locator(selector) {
        const count = matches[selector] || 0;
        return {
          count: async () => count,
          last() {
            return {
              isVisible: async () => count > 0,
              isEnabled: async () => true,
            };
          },
        };
      },
    };
  }

  test('records a match count per candidate', async () => {
    const adapter = { _getSendSelectors: () => ['#send', '#nope'] };
    const report = await diagnose.probeSelectors(fakePage({ '#send': 2 }), adapter);

    expect(report.send).toHaveLength(2);
    expect(report.send[0]).toMatchObject({ selector: '#send', count: 2, visible: true, enabled: true });
    expect(report.send[1]).toMatchObject({ selector: '#nope', count: 0, visible: false });
  });

  test('a selector that throws is reported, not fatal', async () => {
    const page = { locator() { throw new Error('invalid selector'); } };
    const adapter = { _getSendSelectors: () => ['>>>bad'] };
    const report = await diagnose.probeSelectors(page, adapter);

    expect(report.send[0].error).toContain('invalid selector');
  });

  test('every group is present even when the adapter declares none', async () => {
    const report = await diagnose.probeSelectors(fakePage({}), {});
    for (const group of diagnose.GROUPS) {
      expect(Array.isArray(report[group])).toBe(true);
    }
  });
});

describe('formatDiagnostics', () => {
  const report = {
    model: 'Sarvam AI (Indus)',
    url: 'https://indus.sarvam.ai/indus',
    selectors: {
      input: [
        { selector: '.tiptap.ProseMirror', count: 1, visible: true, enabled: true, error: null },
      ],
      send: [
        { selector: '.indus-send-slot button:not([disabled])', count: 1, visible: true, enabled: true, error: null },
        { selector: 'button[aria-label*="Send" i]', count: 0, visible: false, enabled: false, error: null },
        { selector: '>>>bad', count: 0, visible: false, enabled: false, error: 'invalid selector' },
      ],
    },
    dom: {
      url: 'https://indus.sarvam.ai/indus',
      editables: [{ tag: 'div', cls: 'tiptap ProseMirror', ariaLabel: null, id: null, role: 'textbox', text: null }],
      buttons: [{ tag: 'button', cls: 'indus-send-slot', ariaLabel: 'Send message', id: null, text: null, disabled: false }],
    },
  };

  test('summarises how many candidates matched per group', () => {
    const out = diagnose.formatDiagnostics(report);
    expect(out).toContain('input');
    expect(out).toContain('1 of 1 matched');
    expect(out).toContain('send');
    expect(out).toContain('1 of 3 matched');
  });

  test('marks each candidate: matched, no match, or error', () => {
    const out = diagnose.formatDiagnostics(report);
    expect(out).toMatch(/✓.*\.indus-send-slot/);
    expect(out).toMatch(/·.*aria-label/);
    expect(out).toMatch(/ERR.*>>>bad/);
    expect(out).toContain('invalid selector');
  });

  test('lists the real elements, with the attributes that make a selector', () => {
    const out = diagnose.formatDiagnostics(report);
    expect(out).toContain('Editable elements');
    expect(out).toContain('.tiptap.ProseMirror');
    expect(out).toContain('Visible buttons');
    expect(out).toContain('aria-label="Send message"');
  });

  test('reports a group where nothing matched as NONE, loudly', () => {
    const out = diagnose.formatDiagnostics({
      selectors: { newChat: [{ selector: 'x', count: 0, visible: false, enabled: false, error: null }] },
    });
    expect(out).toContain('NONE of 1 matched');
  });

  test('includes the round trip when one ran', () => {
    const out = diagnose.formatDiagnostics({
      selectors: {},
      roundTrip: { sent: true, detected: true, elapsedMs: 4210, reply: 'OK' },
    });
    expect(out).toContain('Round trip');
    expect(out).toContain('detected:  yes');
    expect(out).toContain('4210 ms');
    expect(out).toContain('"OK"');
  });

  test('never throws on an empty or malformed report', () => {
    expect(() => diagnose.formatDiagnostics(null)).not.toThrow();
    expect(() => diagnose.formatDiagnostics({})).not.toThrow();
    expect(() => diagnose.formatDiagnostics({ selectors: { send: 'not-an-array' } })).not.toThrow();
  });
});

describe('describeElement', () => {
  test('builds a selector-shaped description', () => {
    const out = diagnose.describeElement({
      tag: 'button', id: 'go', cls: 'btn primary', ariaLabel: 'Send', testId: 'send-button', role: null, type: null, placeholder: null, text: 'Send',
    });
    expect(out).toContain('#go');
    expect(out).toContain('.btn.primary');
    expect(out).toContain('aria-label="Send"');
    expect(out).toContain('data-testid="send-button"');
  });

  test('says so when an element has nothing identifying', () => {
    expect(diagnose.describeElement({ tag: 'div' })).toBe('(no identifying attributes)');
  });
});

// ─────────────────────────────────────────────
//  The two false negatives a live run produced
// ─────────────────────────────────────────────

describe('send with text, and where the reply lives', () => {
  test('reports that nothing was typed when the composer is missing', async () => {
    const adapter = {
      discoverComposer: async () => null,
      _getSendSelectors: () => ['#send'],
    };
    const out = await diagnose.probeSendWithText({ keyboard: {} }, adapter);

    expect(out.typed).toBe(false);
    expect(out.error).toContain('composer not found');
  });

  test('types into the composer and probes send afterwards', async () => {
    const typed = [];
    const page = {
      keyboard: {
        type: async (t) => typed.push(t),
        press: async (k) => typed.push(k),
      },
      waitForTimeout: async () => {},
      locator: () => ({
        count: async () => 1,
        last: () => ({ isVisible: async () => true, isEnabled: async () => true }),
      }),
    };
    const composer = {
      click: async () => {},
      locator: () => ({ locator: () => ({ count: async () => 2 }) }),
    };
    const adapter = {
      discoverComposer: async () => composer,
      _getSendSelectors: () => ['#send'],
    };

    const out = await diagnose.probeSendWithText(page, adapter);

    expect(out.typed).toBe(true);
    expect(out.rows[0]).toMatchObject({ selector: '#send', count: 1, visible: true });
    expect(out.cleared).toBe(true);
    expect(typed).toContain('x');
  });

  test('the report says the structural fallback would have found it', () => {
    const out = diagnose.formatDiagnostics({
      selectors: {},
      sendWithText: {
        typed: true,
        rows: [{ selector: '.nope', count: 0, visible: false, enabled: false, error: null }],
        structuralButtons: 3,
      },
    });

    expect(out).toContain('with text in the composer');
    expect(out).toContain('0 of 1 matched');
    expect(out).toContain('structural fallback would find it');
  });

  test('text containers after a reply are listed largest first', () => {
    const out = diagnose.formatDiagnostics({
      selectors: {},
      messages: [
        { tag: 'div', cls: 'indus-response', len: 220, text: 'The test script is…' },
        { tag: 'p', cls: null, len: 60, text: 'smaller' },
      ],
    });

    expect(out).toContain('Text containers after the reply');
    expect(out).toContain('.indus-response');
    expect(out).toContain('[220 chars]');
    // The biggest block must come first: it is the one holding the answer.
    expect(out.indexOf('[220 chars]')).toBeLessThan(out.indexOf('[60 chars]'));
  });
});
