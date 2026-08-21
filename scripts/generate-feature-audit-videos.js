#!/usr/bin/env node
'use strict';

// Public, read-only feature-audit recorder. It uses an isolated X display,
// never signs in, never reads cookies, and never mutates a portfolio or order.
// Run:
//   xvfb-run -a --server-args='-screen 0 1280x720x24' \
//     node scripts/generate-feature-audit-videos.js

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'marketing', 'campaign-2026-08-feature-audit-2026-08-13', 'assets');
const DISPLAY = process.env.DISPLAY || ':99';
const WIDTH = 1280;
const HEIGHT = 720;
const BASE = 'https://www.stockportfolio.pro';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeBinary() {
  const candidates = [
    process.env.SOCIAL_CHROME_BINARY,
    '/home/hardoker77/.cache/selenium/chrome/linux64/151.0.7922.71/chrome',
    '/usr/bin/google-chrome', '/usr/bin/brave-browser', '/usr/bin/chromium'
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function buildDriver() {
  const options = new chrome.Options().addArguments(
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ozone-platform=x11',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,720', '--window-position=0,0'
  );
  const binary = chromeBinary();
  if (binary) options.setChromeBinaryPath(binary);
  return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

function recorder(output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '30',
    '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${DISPLAY}.0`, '-c:v', 'libx264',
    '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function dismissConsent(driver) {
  try {
    for (const button of await driver.findElements(By.css('button, [role="button"]'))) {
      const label = String(await button.getText()).trim().toLowerCase();
      if (/^(decline|reject|only necessary|necessary only)$/.test(label)) { await button.click(); break; }
    }
  } catch (_) {}
}

async function ready(driver) {
  await driver.wait(async () => driver.executeScript('return document.readyState === "complete"'), 30000);
  await dismissConsent(driver);
  await sleep(1200);
}

async function caption(driver, title, subtitle = '') {
  await driver.executeScript(({ title: t, subtitle: s }) => {
    let node = document.getElementById('sp-feature-caption');
    if (!node) {
      node = document.createElement('div');
      node.id = 'sp-feature-caption';
      node.innerHTML = '<div class="sp-feature-title"></div><div class="sp-feature-subtitle"></div>';
      document.body.appendChild(node);
      const style = document.createElement('style');
      style.textContent = '#sp-feature-caption{position:fixed;z-index:2147483647;left:30px;right:30px;bottom:24px;padding:15px 20px;border-radius:12px;background:rgba(15,23,42,.94);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:none}.sp-feature-title{font-size:26px;font-weight:750;line-height:1.15}.sp-feature-subtitle{font-size:16px;line-height:1.35;margin-top:5px;color:#dbeafe}';
      document.head.appendChild(style);
    }
    node.querySelector('.sp-feature-title').textContent = t || '';
    node.querySelector('.sp-feature-subtitle').textContent = s || '';
    node.style.display = t || s ? 'block' : 'none';
  }, { title, subtitle });
}

async function scroll(driver, selector) {
  try {
    const el = await driver.findElement(By.css(selector));
    await driver.executeScript('arguments[0].scrollIntoView({behavior:"smooth",block:"center"})', el);
  } catch (_) {
    await driver.executeScript('window.scrollTo({top:Math.min(document.body.scrollHeight-window.innerHeight,620),behavior:"smooth"})');
  }
  await sleep(1800);
}

async function visit(driver, url, title, subtitle, ms = 6500) {
  await driver.get(url); await ready(driver); await caption(driver, title, subtitle); await sleep(ms);
}

async function runAsk(driver) {
  await driver.get(`${BASE}/ask`); await ready(driver);
  await caption(driver, 'Ask a focused question. Get the source trail with it.', 'This is the public, logged-out Ask flow; no customer account or private data is used.');
  const input = await driver.findElement(By.id('q'));
  await input.sendKeys("For NVIDIA, how did revenue and operating cash flow change across the latest five annual periods? Show the reported periods and sources.");
  await driver.findElement(By.css('.composer .go')).click();
  await driver.wait(async () => {
    const text = await driver.findElement(By.id('exchange')).getText().catch(() => '');
    return text.length > 180 || /unavailable|error|try again/i.test(text);
  }, 120000);
  await caption(driver, 'AI Ask: answer first, citations underneath.', 'The answer is only considered successful when the production response and source links render.');
  await scroll(driver, '#exchange');
  await sleep(11000);
}

async function runCompany(driver) {
  await visit(driver, `${BASE}/stocks/NVDA`, 'Company research: follow the filed numbers over time.', 'Fundamentals, periods, source links and the next research question in one place.', 6000);
  await scroll(driver, 'main');
  await caption(driver, 'Start with the company record.', 'Use the financial history to decide what to ask next—not a black-box score.');
  await sleep(8000);
}

async function runScreener(driver) {
  await driver.get(`${BASE}/screener`); await ready(driver);
  await caption(driver, 'Screen the universe by what companies filed.', 'Try a quality screen, then open a company and ask a narrower question.');
  await driver.findElement(By.css('[data-preset="compounders"]')).click();
  await driver.findElement(By.id('run-btn')).click();
  await driver.wait(async () => (await driver.findElement(By.id('result-count')).getText()).length > 0, 30000);
  await scroll(driver, '#results');
  await caption(driver, 'The screen is deterministic; Ask handles the follow-up.', 'Rows link to the underlying company research page.');
  await sleep(9000);
}

async function runCompare(driver) {
  await driver.get(`${BASE}/compare/NVDA-vs-AMD`); await ready(driver);
  await caption(driver, 'Compare two companies on the same evidence frame.', 'Revenue, margins, returns and filings stay side by side before the AI verdict.');
  await scroll(driver, 'main');
  await caption(driver, 'Comparison first. Interpretation second.', 'Ask a filing question when the difference needs more context.');
  await sleep(9500);
}

async function runMonitor(driver) {
  await driver.get(`${BASE}/monitor`); await ready(driver);
  await caption(driver, 'Monitor what changed in the latest filing.', 'A cited read of the new filing, comparable periods and the next three checks.');
  const input = await driver.findElement(By.id('mon-input')).catch(() => null);
  if (input) { await input.sendKeys('NVDA'); await driver.findElement(By.css('#mon-form button[type="submit"]')).click(); }
  await driver.wait(async () => (await driver.findElement(By.id('mon-report')).getText().catch(() => '')).length > 120, 60000).catch(() => {});
  await scroll(driver, '#mon-report');
  await caption(driver, 'The monitor keeps the filing and the next question together.', 'Open the SEC source, then continue in Ask with the context attached.');
  await sleep(10000);
}

async function runPortfolio(driver) {
  await driver.get(`${BASE}/dashboard.html?demo=1`); await ready(driver);
  await caption(driver, 'Portfolio context: a read-only sample, no customer data.', 'See holdings, allocation, performance and the weekly briefing before connecting your own account.');
  await scroll(driver, 'main');
  await caption(driver, 'A customer can see the workflow before subscribing.', 'The sample is clearly labelled; the real portfolio and portfolio Ask remain behind sign-in.');
  await sleep(10500);
}

const jobs = [
  ['ask-ai', 'AI Ask', runAsk],
  ['company-research', 'Company research', runCompany],
  ['sec-screener', 'SEC screener', runScreener],
  ['company-compare', 'Company comparison', runCompare],
  ['filing-monitor', 'Filing monitor', runMonitor],
  ['portfolio-demo', 'Portfolio context', runPortfolio],
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = await buildDriver();
  const results = [];
  try {
    for (const [slug, label, fn] of jobs) {
      const output = path.join(OUT_DIR, `${slug}.mp4`);
      const rec = recorder(output);
      let ok = true; let error = '';
      try { await fn(driver); } catch (e) { ok = false; error = e && e.message ? e.message : String(e); }
      rec.kill('SIGINT');
      await new Promise((resolve) => rec.once('close', resolve));
      results.push({ slug, label, ok, error, file: path.relative(ROOT, output), bytes: fs.existsSync(output) ? fs.statSync(output).size : 0 });
      if (!ok) console.error(`${label}: ${error}`);
    }
  } finally { await driver.quit(); }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), outputDir: path.relative(ROOT, OUT_DIR), results }, null, 2));
  if (results.some((r) => !r.ok || r.bytes < 10000)) process.exitCode = 1;
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
