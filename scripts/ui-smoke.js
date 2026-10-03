// scripts/ui-smoke.js — render the control dashboard and screenshot it
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:7423';
  const out = process.argv[3] || 'ui-smoke.png';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const checks = {
    title: await page.title(),
    hasInstanceList: await page.locator('#instanceList').count(),
    hasTranscript: await page.locator('#transcript').count(),
    hasLogPane: await page.locator('#logPane').count(),
    hasNewBtn: await page.locator('#newBtn').count(),
    newBtnVisible: await page.locator('#newBtn').isVisible(),
    connClass: await page.locator('#conn').getAttribute('class'),
  };

  // Try to select an instance if one is listed.
  const firstInstance = page.locator('.instance-item').first();
  if (await firstInstance.count() > 0) {
    await firstInstance.click();
    await page.waitForTimeout(1500);
    checks.selectedTranscriptMsgs = await page.locator('.transcript .msg').count();
    checks.logLines = await page.locator('.log-pane .log-line').count();
  }

  await page.screenshot({ path: out, fullPage: false });
  console.log('CHECKS ' + JSON.stringify(checks));
  console.log('CONSOLE_ERRORS ' + JSON.stringify(errors));
  console.log('SCREENSHOT ' + path.resolve(out));
  await browser.close();
})().catch(err => { console.error('SMOKE_FAIL', err.message); process.exit(1); });
