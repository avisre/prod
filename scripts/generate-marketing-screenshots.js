#!/usr/bin/env node
'use strict';

// Capture evidence-first screenshots from public StockPortfolio.pro tools.
// This script never signs in, reads cookies, or uses private customer data.
const fs = require('node:fs');
const path = require('node:path');
const { Builder, By, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'marketing/campaign-2026-08-appsumo-sprint/assets');
const BASE = 'https://www.stockportfolio.pro';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function binary() {
  const candidates = [
    process.env.SOCIAL_CHROME_BINARY,
    '/home/hardoker77/.cache/selenium/chrome/linux64/151.0.7922.71/chrome',
    '/usr/bin/google-chrome', '/usr/bin/brave-browser', '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file));
}

function driver() {
  const options = new chrome.Options().addArguments(
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--ozone-platform=x11', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', '--hide-scrollbars',
    // Marks this real Chrome instance as internal tooling so
    // backend/bot-blocker.js never treats it as a scraper — belt-and-
    // suspenders on top of it already sending real sec-ch-ua/sec-fetch-*
    // headers, which alone would clear the header-consistency check.
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 stockportfolio-internal',
  );
  const bin = binary();
  if (bin) options.setChromeBinaryPath(bin);
  return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

async function ready(d) {
  await d.wait(async () => d.executeScript('return document.readyState === "complete"'), 30000);
  try {
    const buttons = await d.findElements(By.css('button,[role="button"]'));
    for (const b of buttons) {
      const label = String(await b.getText()).trim().toLowerCase();
      if (/^(decline|reject|only necessary|necessary only)$/.test(label)) { await b.click(); break; }
    }
  } catch (_) {}
  await sleep(1000);
}

async function capture(d, item) {
  await d.get(BASE + item.path);
  await ready(d);
  const input = await d.findElement(By.id('symbols'));
  await input.clear();
  await input.sendKeys(item.symbol);
  // Ticker symbols are valid inputs without resolving a suggestion. Close the
  // suggestion popover so it cannot intercept the submit button.
  await input.sendKeys(Key.ESCAPE);
  await sleep(350);
  const submit = await (await d.findElement(By.id('form'))).findElement(By.css('button[type="submit"]'));
  await d.executeScript('arguments[0].click()', submit);
  await d.wait(async () => {
    const text = await d.findElement(By.id('result')).getText();
    return text && !/^Ready/i.test(text) && !/Loading filed data/i.test(text);
  }, 40000);
  await sleep(1600);
  await d.executeScript('window.scrollTo(0, Math.min(document.body.scrollHeight - window.innerHeight, 260));');
  await sleep(700);
  const out = path.join(OUT, item.file);
  fs.writeFileSync(out, await d.takeScreenshot(true), 'base64');
  return { file: item.file, symbol: item.symbol, path: item.path, bytes: fs.statSync(out).size };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const items = [
    { file: 'nvda-filing-quality.png', path: '/tools/earnings-quality', symbol: 'NVDA' },
    { file: 'aapl-earnings-quality.png', path: '/tools/earnings-quality', symbol: 'AAPL' },
    { file: 'tsla-dilution.png', path: '/tools/dilution', symbol: 'TSLA' },
    { file: 'ionq-dilution.png', path: '/tools/dilution', symbol: 'IONQ' },
    { file: 'nvda-amd-comparison.png', path: '/tools/company-comparison', symbol: 'NVDA, AMD' },
  ];
  const d = await driver();
  try {
    const results = [];
    for (const item of items) {
      try { results.push({ status: 'captured', ...(await capture(d, item)) }); }
      catch (error) { results.push({ status: 'failed', file: item.file, error: error.message }); }
    }
    console.log(JSON.stringify(results, null, 2));
    if (results.some(r => r.status === 'failed')) process.exitCode = 1;
  } finally { await d.quit(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
