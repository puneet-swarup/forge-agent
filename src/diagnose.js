// src/diagnose.js — find out WHY a model's selectors stopped working.
//
// `--test-model` answers one question: ready or not. When the answer is "not
// ready", it does not say which candidate selectors matched, what the DOM
// actually contains, or what the composer's neighbourhood looks like — so fixing
// an adapter means guessing, and guessing against someone else's UI is how you
// spend an evening.
//
// This module collects the evidence instead:
//   1. every candidate selector, with count / visible / enabled;
//   2. the real buttons and editables near the composer, with their attributes;
//   3. optionally, a live round trip: send a trivial message and report whether
//      the response was detected and what came back.
//
// Everything that decides what to print is a pure function, so it is testable
// without a browser.
'use strict';

/** The selector groups every adapter exposes. */
const GROUPS = ['input', 'send', 'stop', 'newChat', 'response'];

const GROUP_METHODS = {
  input: '_getInputSelectors',
  send: '_getSendSelectors',
  stop: '_getStopSelectors',
  newChat: '_getNewChatSelectors',
  response: '_getResponseSelectors',
};

/**
 * Read the selector list an adapter declares for a group.
 * @param {object} adapter
 * @param {string} group
 * @returns {string[]}
 */
function selectorsFor(adapter, group) {
  const method = GROUP_METHODS[group];
  if (!method || typeof adapter[method] !== 'function') return [];
  try {
    const list = adapter[method]();
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/**
 * Probe every candidate selector against the live page.
 *
 * A selector that matches nothing is as informative as one that matches three
 * elements, so nothing here is filtered out.
 *
 * @param {object} page    Playwright page
 * @param {object} adapter
 * @returns {Promise<object>} { group: [{ selector, count, visible, enabled, error }] }
 */
async function probeSelectors(page, adapter) {
  const report = {};

  for (const group of GROUPS) {
    const selectors = selectorsFor(adapter, group);
    report[group] = [];

    for (const selector of selectors) {
      const row = { selector, count: 0, visible: false, enabled: false, error: null };
      try {
        const locator = page.locator(selector);
        row.count = await locator.count();

        if (row.count > 0) {
          const last = locator.last();
          row.visible = await last.isVisible().catch(() => false);
          row.enabled = await last.isEnabled().catch(() => false);
        }
      } catch (err) {
        // An invalid selector is a finding, not a crash.
        row.error = (err && err.message) || String(err);
      }
      report[group].push(row);
    }
  }

  return report;
}

/**
 * Collect the elements an adapter author would want to look at: every button and
 * every editable near the composer, with the attributes that make a usable
 * selector.
 *
 * @param {object} page
 * @returns {Promise<object>} { buttons: [...], editables: [...] }
 */
async function probeDom(page) {
  try {
    return await page.evaluate(() => {
      const clip = (value, max = 60) => {
        if (value === null || value === undefined) return null;
        const text = String(value).replace(/\s+/g, ' ').trim();
        return text.length > max ? text.slice(0, max - 1) + '…' : text;
      };

      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          style.opacity !== '0' && el.getClientRects().length > 0;
      };

      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: clip(el.id) || null,
        cls: clip(el.className && el.className.toString()) || null,
        ariaLabel: clip(el.getAttribute('aria-label')) || null,
        testId: clip(el.getAttribute('data-testid') || el.getAttribute('data-test-id')) || null,
        role: clip(el.getAttribute('role')) || null,
        type: clip(el.getAttribute('type')) || null,
        placeholder: clip(el.getAttribute('placeholder')) || null,
        text: clip(el.innerText, 40) || null,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      });

      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .slice(0, 40)
        .map(describe);

      const editables = [...document.querySelectorAll(
        'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
      )]
        .filter(visible)
        .slice(0, 20)
        .map(describe);

      return { buttons, editables, url: location.href, title: document.title };
    });
  } catch (err) {
    return { buttons: [], editables: [], url: null, title: null, error: (err && err.message) || String(err) };
  }
}

/**
 * Turn a probe result into a report a human can act on.
 *
 * Pure: no page, no clock, no I/O.
 *
 * @param {object} report
 * @returns {string}
 */
function formatDiagnostics(report) {
  const lines = [];
  const safe = report || {};
  const { model, url, selectors, dom, roundTrip, sendWithText, messages } = safe;

  lines.push('');
  lines.push(`Selector diagnostics${model ? ' — ' + model : ''}`);
  if (url) lines.push(`  page: ${url}`);

  // ── Per-group selector results ─────────────────────────────────────────
  for (const group of GROUPS) {
    const declared = selectors && selectors[group];
    // A malformed report (a string where an array belongs) must not throw:
    // diagnostics is exactly the tool you run when something is already wrong.
    const rows = Array.isArray(declared) ? declared : [];
    if (rows.length === 0) continue;

    const matched = rows.filter((r) => r.count > 0 && r.visible && !r.error);
    const status = matched.length > 0
      ? `${matched.length} of ${rows.length} matched`
      : `NONE of ${rows.length} matched`;

    lines.push('');
    lines.push(`  ${group.padEnd(9)} ${status}`);
    for (const row of rows) {
      const mark = row.error ? 'ERR' : row.count === 0 ? ' · ' : row.visible ? ' ✓ ' : ' ~ ';
      const detail = row.error
        ? row.error
        : row.count === 0
          ? 'no match'
          : `${row.count} match${row.count === 1 ? '' : 'es'}${row.visible ? ', visible' : ', hidden'}${row.enabled ? '' : ', disabled'}`;
      lines.push(`    ${mark} ${row.selector}`);
      lines.push(`        ${detail}`);
    }
  }

  // ── Send, re-checked with text in the composer ─────────────────────────
  if (sendWithText) {
    const st = sendWithText;
    lines.push('');
    lines.push('  send (with text in the composer)');

    if (st.error) {
      lines.push(`    could not probe: ${st.error}`);
    } else {
      const matched = (st.rows || []).filter((r) => r.count > 0 && r.visible && !r.error);
      lines.push(`    ${matched.length} of ${(st.rows || []).length} matched` +
        (st.typed ? '' : '  (nothing was typed)'));

      for (const row of st.rows || []) {
        const mark = row.error ? 'ERR' : row.count === 0 ? ' · ' : row.visible ? ' ✓ ' : ' ~ ';
        lines.push(`    ${mark} ${row.selector}`);
      }

      if (st.structuralButtons !== null && st.structuralButtons !== undefined) {
        lines.push(`    structural: ${st.structuralButtons} enabled button(s) share the composer's container`);
      }
      if (matched.length === 0 && st.structuralButtons > 0) {
        lines.push('    → the structural fallback would find it; add the real selector from the DOM dump below');
      }
    }
  }

  // ── What is actually on the page ───────────────────────────────────────
  if (dom) {
    if (dom.error) {
      lines.push('');
      lines.push(`  DOM probe failed: ${dom.error}`);
    }

    if (dom.editables && dom.editables.length) {
      lines.push('');
      lines.push('  Editable elements on the page (candidates for the composer):');
      for (const el of dom.editables.slice(0, 8)) {
        lines.push(`    <${el.tag}> ${describeElement(el)}`);
      }
    }

    if (dom.buttons && dom.buttons.length) {
      lines.push('');
      lines.push('  Visible buttons (candidates for send / new chat):');
      for (const el of dom.buttons.slice(0, 14)) {
        lines.push(`    <${el.tag}> ${describeElement(el)}${el.disabled ? '  [disabled]' : ''}`);
      }
      if (dom.buttons.length > 14) {
        lines.push(`    … and ${dom.buttons.length - 14} more`);
      }
    }
  }

  // ── Optional live round trip ───────────────────────────────────────────
  if (roundTrip) {
    lines.push('');
    lines.push('  Round trip');
    lines.push(`    sent:      ${roundTrip.sent ? 'yes' : 'no'}`);
    lines.push(`    detected:  ${roundTrip.detected ? 'yes' : 'no'}`);
    if (roundTrip.elapsedMs !== null && roundTrip.elapsedMs !== undefined) {
      lines.push(`    elapsed:   ${roundTrip.elapsedMs} ms`);
    }
    if (roundTrip.reply) {
      lines.push(`    reply:     ${JSON.stringify(roundTrip.reply.slice(0, 120))}`);
    }
    if (roundTrip.error) lines.push(`    error:     ${roundTrip.error}`);
  }

  // ── Where the reply actually lives ─────────────────────────────────────
  if (Array.isArray(messages) && messages.length) {
    lines.push('');
    lines.push('  Text containers after the reply (largest first — the answer is at the top):');
    for (const el of messages) {
      const bits = [`<${el.tag}>`];
      if (el.cls) bits.push(`.${String(el.cls).split(' ').slice(0, 3).join('.')}`);
      if (el.testId) bits.push(`data-testid="${el.testId}"`);
      if (el.role) bits.push(`role="${el.role}"`);
      bits.push(`[${el.len} chars]`);
      lines.push(`    ${bits.join(' ')}`);
      if (el.text) lines.push(`        "${el.text}"`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** One-line summary of an element for the report. */
function describeElement(el) {
  const parts = [];
  if (el.id) parts.push(`#${el.id}`);
  if (el.cls) parts.push(`.${el.cls.split(' ').slice(0, 3).join('.')}`);
  if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
  if (el.testId) parts.push(`data-testid="${el.testId}"`);
  if (el.role) parts.push(`role="${el.role}"`);
  if (el.type) parts.push(`type="${el.type}"`);
  if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
  if (el.text) parts.push(`text="${el.text}"`);
  return parts.length ? parts.join(' ') : '(no identifying attributes)';
}


/**
 * Re-probe the send group with text in the composer.
 *
 * Chat UIs render the send control only once there is something to send, so a
 * probe against an empty composer reports "not found" for a button that exists.
 * On a live Sarvam run that false negative is exactly what we saw.
 *
 * @param {object} page
 * @param {object} adapter
 * @returns {Promise<object>} { typed, rows, cleared, error }
 */
async function probeSendWithText(page, adapter) {
  const out = { typed: false, rows: [], cleared: false, error: null };

  try {
    const composer = await adapter.discoverComposer({ timeout: 5000 });
    if (!composer) {
      out.error = 'composer not found';
      return out;
    }

    await composer.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.type('x', { delay: 0 });
    out.typed = true;
    await page.waitForTimeout(700);

    const selectors = selectorsFor(adapter, 'send');
    for (const selector of selectors) {
      const row = { selector, count: 0, visible: false, enabled: false, error: null };
      try {
        const locator = page.locator(selector);
        row.count = await locator.count();
        if (row.count > 0) {
          const last = locator.last();
          row.visible = await last.isVisible().catch(() => false);
          row.enabled = await last.isEnabled().catch(() => false);
        }
      } catch (err) {
        row.error = (err && err.message) || String(err);
      }
      out.rows.push(row);
    }

    // Structural answer: the last enabled button sharing a container with the
    // composer. If a selector list has drifted, this is what would be used.
    try {
      const container = composer.locator('xpath=ancestor::*[.//button][1]');
      const buttons = container.locator('button:not([disabled])');
      const count = await buttons.count();
      out.structuralButtons = count;
    } catch (_) {
      out.structuralButtons = null;
    }
  } catch (err) {
    out.error = (err && err.message) || String(err);
  } finally {
    try {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      out.cleared = true;
    } catch (_) { /* best effort */ }
  }

  return out;
}

/**
 * Dump the elements that could hold a reply.
 *
 * After a message is sent, this is what tells us which container the answer
 * actually lives in — the one thing an empty page cannot reveal.
 *
 * @param {object} page
 * @returns {Promise<Array>} candidates, largest text first
 */
async function probeMessages(page) {
  try {
    return await page.evaluate(() => {
      const clip = (v, max = 80) => {
        if (v === null || v === undefined) return null;
        const t = String(v).replace(/\s+/g, ' ').trim();
        return t.length > max ? t.slice(0, max - 1) + '…' : t;
      };

      const visible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          el.getClientRects().length > 0;
      };

      // Elements holding a paragraph or more of text, excluding the composer and
      // the page chrome. Sorted by text length so the answer is at the top.
      const candidates = [...document.querySelectorAll('div, article, section, li, p, span')]
        .filter((el) => {
          if (!visible(el)) return false;
          if (el.closest('[contenteditable="true"]')) return false;
          const text = (el.innerText || '').trim();
          if (text.length < 40) return false;
          // Prefer leaf-ish nodes: a container whose child holds the same text
          // is the parent, and tells us less.
          const childSame = [...el.children].some(
            (c) => (c.innerText || '').trim().length === text.length
          );
          return !childSame;
        })
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: clip(el.className && el.className.toString(), 70) || null,
          testId: clip(el.getAttribute('data-testid') || el.getAttribute('data-test-id')) || null,
          role: clip(el.getAttribute('role')) || null,
          len: (el.innerText || '').trim().length,
          text: clip(el.innerText, 80),
        }))
        .sort((a, b) => b.len - a.len)
        .slice(0, 12);

      return candidates;
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  GROUPS,
  GROUP_METHODS,
  selectorsFor,
  probeSelectors,
  probeDom,
  formatDiagnostics,
  describeElement,
  probeSendWithText,
  probeMessages,
};
