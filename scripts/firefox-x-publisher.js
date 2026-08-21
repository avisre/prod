#!/usr/bin/env node
'use strict';

// Explicitly-authorized, owner-operated X publisher. It uses a separate
// Firefox profile, waits for the owner to complete X login/MFA, publishes only
// the approved August queue, stops on a platform error/rate limit, and writes
// aggregate status without cookies or account credentials.
const fs = require('node:fs');
const path = require('node:path');
const { Builder, By, Key } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

const ROOT = path.resolve(__dirname, '..');
const CSV = path.join(ROOT, 'marketing/campaign-2026-08-appsumo-sprint/x-opportunities-2026-08-09.csv');
const EVIDENCE = path.join(ROOT, 'marketing/campaign-2026-08-appsumo-sprint/evidence/nvda-earnings-quality.png');
const PROFILE = process.env.X_FIREFOX_PROFILE || '/tmp/stockportfolio-firefox-x-publisher';
const LOG = process.env.X_FIREFOX_PUBLISH_LOG || '/tmp/stockportfolio-x-publish-status.json';
const DELAY_MS = Math.max(10000, Number(process.env.X_POST_DELAY_MS || 15000));
const MAX_WAIT_MS = 10 * 60 * 1000;

function csvLine(line) {
  const out = []; let field = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field); return out;
}
function readQueue() {
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = csvLine(lines.shift());
  return lines.map((line) => Object.fromEntries(csvLine(line).map((value, i) => [headers[i], value])));
}
function originalPosts() {
  return [
    {
      id: 'x-20260809-post-a',
      text: 'NVIDIA’s FY2026 filing reported $120.07B net income and $102.72B operating cash flow. After $6.04B capex, free cash flow was $96.68B. OCF/net income = 0.86×. Not a verdict—read the period and source beside the headline.',
      cta: 'https://www.stockportfolio.pro/tools/earnings-quality?source=x&content_id=tool-earnings-quality&click_id=x-20260809-post-a',
      image: EVIDENCE
    },
    {
      id: 'x-20260809-post-b',
      text: 'StockPortfolio.pro puts filing dates, source links, fundamentals, ETF/fund coverage and deterministic research tools in one place. The lifetime deal is currently available on AppSumo; no invented deadline—check the listing for current terms.',
      cta: 'https://www.stockportfolio.pro/appsumo?source=x&content_id=tool-earnings-quality&click_id=x-20260809-post-b',
      image: null
    }
  ];
}
function readLog() { try { return JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch (_) { return { published: {}, errors: [] }; } }
function saveLog(log) { fs.writeFileSync(LOG, JSON.stringify(log, null, 2) + '\n', { mode: 0o600 }); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function visible(driver, selectors) {
  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) if (await element.isDisplayed().catch(() => false)) return element;
  }
  return null;
}
async function waitForComposer(driver, timeout = MAX_WAIT_MS) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const editor = await visible(driver, ['[data-testid="tweetTextarea_0"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="Post"]']);
    if (editor) return editor;
    await sleep(1500);
  }
  throw new Error('X composer did not become available; complete login/MFA in Firefox first.');
}
async function clickPost(driver) {
  const button = await visible(driver, ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]', 'button[data-testid="tweetButtonInline"]']);
  if (!button) throw new Error('X Post button was not found.');
  if (await button.getAttribute('aria-disabled').catch(() => null) === 'true') throw new Error('X Post button is disabled.');
  await button.click();
  await sleep(2500);
  const toast = await visible(driver, ['[data-testid="toast"]']);
  const toastText = toast ? await toast.getText().catch(() => '') : '';
  if (/rate|limit|suspend|error|try again/i.test(toastText)) throw new Error(`X reported: ${toastText}`);
  return toastText || 'post action completed';
}
async function fillAndPost(driver, text, image) {
  const editor = await waitForComposer(driver, 30000);
  await editor.click();
  await editor.sendKeys(Key.CONTROL, 'a');
  await editor.sendKeys(text);
  if (image) {
    const input = await visible(driver, ['input[type="file"]']);
    if (!input) throw new Error('Image upload input was not found.');
    await input.sendKeys(image);
    await sleep(1500);
  }
  return clickPost(driver);
}
async function postReply(driver, row) {
  await driver.get(row.source_url);
  await sleep(2500);
  const reply = await visible(driver, ['[data-testid="reply"]', 'button[aria-label^="Reply"]'], 15000);
  if (!reply) throw new Error(`Reply control unavailable for ${row.id}`);
  await reply.click();
  const text = `${row.reply} ${row.destination_url}`;
  return fillAndPost(driver, text, null);
}
async function postOriginal(driver, post) {
  await driver.get('https://x.com/compose/post');
  const result = await fillAndPost(driver, post.text, post.image);
  return { result, cta: post.cta };
}
async function main() {
  fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  const options = new firefox.Options().setBinary('/snap/firefox/current/usr/lib/firefox/firefox').setProfile(PROFILE);
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  const log = readLog();
  const posts = originalPosts();
  const rows = readQueue();
  try {
    await driver.get('https://x.com/compose/post');
    await waitForComposer(driver);
    for (const post of posts) {
      if (log.published[post.id]) continue;
      try { const result = await postOriginal(driver, post); log.published[post.id] = { type: 'original', at: new Date().toISOString(), result, cta: post.cta }; saveLog(log); } catch (error) { log.errors.push({ id: post.id, error: error.message }); saveLog(log); throw error; }
      await sleep(DELAY_MS);
    }
    for (const row of rows) {
      if (log.published[row.id]) continue;
      try { const result = await postReply(driver, row); log.published[row.id] = { type: 'reply', at: new Date().toISOString(), result, source: row.source_url }; saveLog(log); } catch (error) { log.errors.push({ id: row.id, error: error.message }); saveLog(log); throw error; }
      await sleep(DELAY_MS);
    }
    console.log(JSON.stringify({ ok: true, published: Object.keys(log.published).length, errors: log.errors.length, log: LOG }, null, 2));
  } finally { await driver.quit(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

