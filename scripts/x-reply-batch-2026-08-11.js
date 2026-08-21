#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Builder, By, Key } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = '/home/hardoker77/snap/firefox/common/x_reply_bot_profile_v2';
const QUEUE = path.join(ROOT, 'marketing/campaign-2026-08-appsumo-sprint/x-reply-queue-2026-08-11.json');
const LOG = path.join(ROOT, 'marketing/campaign-2026-08-appsumo-sprint/x-reply-results-2026-08-11.json');
const LIMIT = Math.max(1, Number(process.env.X_REPLY_LIMIT || 40));
const MIN_DELAY = Math.max(20000, Number(process.env.X_REPLY_MIN_DELAY_MS || 38000));
const MAX_DELAY = Math.max(MIN_DELAY, Number(process.env.X_REPLY_MAX_DELAY_MS || 62000));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG, 'utf8')); }
  catch (_) { return { account: 'avisre', published: {}, skipped: {}, errors: [] }; }
}

function saveLog(log) {
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2) + '\n');
}

async function visible(driver, selectors) {
  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      if (await element.isDisplayed().catch(() => false)) return element;
    }
  }
  return null;
}

async function waitFor(driver, fn, timeout = 20000, interval = 500) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await sleep(interval);
  }
  return null;
}

function statusId(url) {
  return String(url || '').match(/\/status\/(\d+)/)?.[1] || '';
}

async function sourceArticle(driver, sourceUrl) {
  const expected = statusId(sourceUrl);
  return waitFor(driver, async () => {
    const articles = await driver.findElements(By.css('article[data-testid="tweet"]'));
    for (const article of articles) {
      const links = await article.findElements(By.css(`a[href*="/status/${expected}"]`));
      if (links.length) return article;
    }
    return articles[0] || null;
  }, 25000);
}

async function ownReplyUrl(driver, replyText) {
  const prefix = replyText.slice(0, 60);
  const articles = await driver.findElements(By.css('article[data-testid="tweet"]'));
  for (const article of articles) {
    const text = await article.getText().catch(() => '');
    if (!text.includes(prefix)) continue;
    const links = await article.findElements(By.css('a[href*="/avisre/status/"]'));
    for (const link of links) {
      const href = await link.getAttribute('href');
      if (/\/avisre\/status\/\d+/.test(href || '')) return href.match(/https:\/\/x\.com\/avisre\/status\/\d+/)?.[0] || href;
    }
  }
  return '';
}

async function postOne(driver, item) {
  await driver.get(item.sourceUrl);
  const body = await waitFor(driver, async () => {
    const text = await driver.findElement(By.css('body')).getText();
    return text.length > 50 ? text : '';
  }, 30000);
  if (!body) throw new Error('X page did not render');
  if (/page doesn.?t exist|nothing to see here|account suspended/i.test(body)) throw new Error('source unavailable');
  if (/rate limit|unusual activity|verify (?:that )?you|temporarily limited|automated behavior/i.test(body)) throw new Error(`X safety stop: ${body.slice(0, 180)}`);

  const existing = await ownReplyUrl(driver, item.reply);
  if (existing) return { status: 'existing', replyUrl: existing };

  const article = await sourceArticle(driver, item.sourceUrl);
  if (!article) throw new Error('source tweet not found');
  const replyButtons = await article.findElements(By.css('[data-testid="reply"], button[aria-label^="Reply"]'));
  const replyButton = replyButtons[0] || null;
  if (!replyButton) throw new Error('reply button not found');
  await driver.executeScript('arguments[0].click()', replyButton);

  const dialog = await waitFor(driver, async () => {
    const dialogs = await driver.findElements(By.css('[role="dialog"]'));
    for (const candidate of dialogs) if (await candidate.isDisplayed().catch(() => false)) return candidate;
    return null;
  }, 15000);
  if (!dialog) throw new Error('reply dialog not found');
  const editors = await dialog.findElements(By.css('[data-testid="tweetTextarea_0"], div[contenteditable="true"][role="textbox"]'));
  const editor = editors[0] || null;
  if (!editor) throw new Error('reply editor not found');
  const message = item.reply + (item.destinationUrl ? ` ${item.destinationUrl}` : '');
  await driver.executeScript('arguments[0].focus(); arguments[0].click()', editor);
  await editor.sendKeys(Key.CONTROL, 'a');
  await editor.sendKeys(message);

  if (item.image) {
    const imagePath = path.join(ROOT, item.image);
    if (!fs.existsSync(imagePath)) throw new Error(`evidence image missing: ${item.image}`);
    const inputs = await dialog.findElements(By.css('input[type="file"]'));
    if (!inputs.length) throw new Error('image input not found');
    await inputs[0].sendKeys(imagePath);
    await sleep(2000);
  }

  const submit = await waitFor(driver, async () => {
    const buttons = await dialog.findElements(By.css('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'));
    for (const button of buttons) {
      if (await button.isDisplayed().catch(() => false) && (await button.getAttribute('aria-disabled')) !== 'true') return button;
    }
    return null;
  }, 15000);
  if (!submit) throw new Error('reply submit button unavailable');
  await submit.click();

  const toast = await waitFor(driver, () => visible(driver, ['[data-testid="toast"]']), 12000);
  const toastText = toast ? await toast.getText().catch(() => '') : '';
  if (/rate|limit|suspend|error|try again|automated|verify/i.test(toastText)) throw new Error(`X safety stop: ${toastText}`);
  let replyUrl = '';
  if (toast) {
    const links = await toast.findElements(By.css('a[href*="/avisre/status/"]'));
    if (links.length) replyUrl = await links[0].getAttribute('href');
  }
  if (!replyUrl) replyUrl = await waitFor(driver, () => ownReplyUrl(driver, item.reply), 12000);
  if (!replyUrl) throw new Error(`reply sent but public URL was not captured; toast=${toastText}`);
  replyUrl = replyUrl.match(/https:\/\/x\.com\/avisre\/status\/\d+/)?.[0] || replyUrl;
  return { status: 'published', replyUrl, toast: toastText };
}

async function main() {
  const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
  const log = readLog();
  const options = new firefox.Options()
    .setBinary('/snap/firefox/current/usr/lib/firefox/firefox')
    .addArguments('-no-remote', '-profile', PROFILE);
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  let posted = 0;
  try {
    await driver.get('https://x.com/home');
    const accountReady = await waitFor(driver, async () => {
      const text = await driver.findElement(By.css('body')).getText();
      return /@avisre\b/.test(text) && text.length > 100;
    }, 30000);
    if (!accountReady) throw new Error('authenticated @avisre session not available');

    for (const item of queue) {
      if (posted >= LIMIT) break;
      if (log.published[item.id]) continue;
      try {
        const result = await postOne(driver, item);
        log.published[item.id] = {
          sourceUrl: item.sourceUrl,
          replyUrl: result.replyUrl,
          text: item.reply,
          image: item.image || '',
          destinationUrl: item.destinationUrl || '',
          publishedAt: new Date().toISOString(),
          status: result.status,
        };
        saveLog(log);
        posted += 1;
        console.log(`POSTED ${posted}/${LIMIT}\t${item.id}\t${result.replyUrl}`);
      } catch (error) {
        const message = error.message || String(error);
        log.errors.push({ id: item.id, sourceUrl: item.sourceUrl, at: new Date().toISOString(), error: message });
        saveLog(log);
        console.error(`ERROR\t${item.id}\t${message}`);
        if (/safety stop|authenticated|page did not render|reply sent but public URL/i.test(message)) throw error;
      }
      if (posted < LIMIT) {
        const delay = MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1));
        console.log(`WAIT\t${Math.round(delay / 1000)}s`);
        await sleep(delay);
      }
    }
    console.log(JSON.stringify({ ok: posted === LIMIT, postedThisRun: posted, verifiedTotal: Object.keys(log.published).length, errors: log.errors.length, log: LOG }));
    if (posted < LIMIT) process.exitCode = 2;
  } finally {
    await driver.quit();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
