#!/usr/bin/env node
'use strict';

// Deterministic, public-site product demo recorder.
//
// Run in an isolated X display so no private browser tabs or customer data can
// enter the recording:
//   xvfb-run -a --server-args='-screen 0 1280x720x24' \
//     node scripts/generate-appsumo-videos.js --video both
//
// The recorder uses only public StockPortfolio.pro pages and never signs in,
// reads cookies, or clicks a purchase action.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'marketing', 'campaign-2026-08-appsumo-sprint', 'assets');
const DISPLAY = process.env.DISPLAY || ':99';
const WIDTH = 1280;
const HEIGHT = 720;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeBinary() {
  const candidates = [
    process.env.SOCIAL_CHROME_BINARY,
    '/home/hardoker77/.cache/selenium/chrome/linux64/151.0.7922.71/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/brave-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function buildDriver() {
  const options = new chrome.Options()
    .addArguments(
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ozone-platform=x11',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,720',
      '--window-position=0,0',
    );
  const binary = chromeBinary();
  if (binary) options.setChromeBinaryPath(binary);
  return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

function recorder(output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = [
    '-y', '-loglevel', 'error',
    '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '30',
    '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${DISPLAY}.0`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function waitForPage(driver) {
  await driver.wait(async () => driver.executeScript('return document.readyState === "complete"'), 30000);
  // Keep the recording focused on the product. This only dismisses the public
  // consent banner; it does not grant analytics consent or touch credentials.
  try {
    const buttons = await driver.findElements(By.css('button, [role="button"]'));
    for (const button of buttons) {
      const label = String(await button.getText()).trim().toLowerCase();
      if (/^(decline|reject|only necessary|necessary only)$/.test(label)) {
        await button.click();
        break;
      }
    }
  } catch (_) {}
  await sleep(1500);
}

async function overlay(driver, title, subtitle = '') {
  await driver.executeScript(({ title: t, subtitle: s }) => {
    let node = document.getElementById('sp-demo-caption');
    if (!node) {
      node = document.createElement('div');
      node.id = 'sp-demo-caption';
      node.innerHTML = '<div class="sp-demo-title"></div><div class="sp-demo-subtitle"></div>';
      document.body.appendChild(node);
      const style = document.createElement('style');
      style.textContent = `#sp-demo-caption{position:fixed;z-index:2147483647;left:34px;right:34px;bottom:26px;padding:16px 22px;border-radius:12px;background:rgba(15,23,42,.92);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 5px 22px rgba(0,0,0,.28);pointer-events:none}.sp-demo-title{font-size:28px;font-weight:750;line-height:1.15}.sp-demo-subtitle{font-size:17px;line-height:1.35;margin-top:5px;color:#dbeafe}`;
      document.head.appendChild(style);
    }
    node.querySelector('.sp-demo-title').textContent = t || '';
    node.querySelector('.sp-demo-subtitle').textContent = s || '';
    node.style.display = t || s ? 'block' : 'none';
  }, { title, subtitle });
}

async function scrollTo(driver, selector) {
  try {
    const element = await driver.findElement(By.css(selector));
    await driver.executeScript('arguments[0].scrollIntoView({behavior:"smooth",block:"center"})', element);
    await sleep(2200);
  } catch (_) {
    await driver.executeScript('window.scrollTo({top: Math.min(document.body.scrollHeight - window.innerHeight, 620), behavior:"smooth"})');
    await sleep(2200);
  }
}

async function runTool(driver, tool) {
  const input = await driver.findElement(By.id('symbols'));
  await input.clear();
  await input.sendKeys('NVDA');
  await driver.findElement(By.css('#form button[type="submit"]')).click();
  await driver.wait(async () => {
    const text = await driver.findElement(By.id('result')).getText();
    return text && !/^Ready/i.test(text) && !/Loading filed data/i.test(text);
  }, 30000);
  await sleep(1200);
}

async function visit(driver, url, title, subtitle, durationMs = 7000) {
  await driver.get(url);
  await waitForPage(driver);
  await overlay(driver, title, subtitle);
  await sleep(durationMs);
}

async function runSales(driver, output) {
  const rec = recorder(output);
  try {
    await visit(driver, 'https://www.stockportfolio.pro/', 'Stock research with the evidence attached.', 'AI answers are useful. Verifiable AI answers are better.', 8000);
    await driver.get('https://www.stockportfolio.pro/tools/earnings-quality');
    await waitForPage(driver);
    await overlay(driver, "Is NVIDIA's free cash flow keeping pace with investment spending?", 'Enter a ticker and compare reported earnings with cash flow.');
    await runTool(driver, 'earnings-quality');
    await scrollTo(driver, '[data-tool-result], .tool-result, main');
    await overlay(driver, 'The result stays tied to the filed period.', 'Revenue, net income, operating cash flow and free cash flow remain visible together.');
    await sleep(12000);
    await driver.get('https://www.stockportfolio.pro/tools/filing-timeline');
    await waitForPage(driver);
    await overlay(driver, 'Check the filing before comparing the number.', 'Annual, quarterly, 8-K and Form 4 records link back to SEC evidence.');
    await runTool(driver, 'filing-timeline');
    await scrollTo(driver, 'a[href*="sec.gov"], [data-source], main');
    await overlay(driver, 'Verify the underlying evidence yourself.', 'Open the source trail instead of trusting an unsupported conclusion.');
    await sleep(10000);
    await visit(driver, 'https://www.stockportfolio.pro/stocks/NVDA', 'One workflow, several research questions.', 'Earnings quality, dilution, filing history and company context use the same evidence-first approach.', 9000);
    await visit(driver, 'https://www.stockportfolio.pro/appsumo', 'StockPortfolio.pro', 'Stock research with the evidence attached.\nLifetime deal available now on AppSumo.\nNot investment advice.', 9000);
  } finally {
    rec.kill('SIGINT');
    await new Promise((resolve) => rec.once('close', resolve));
  }
}

async function runOnboarding(driver, output) {
  const rec = recorder(output);
  try {
    await visit(driver, 'https://www.stockportfolio.pro/', 'Start with one company you already care about.', 'This walkthrough uses public pages and no account or private data.', 12000);
    await driver.get('https://www.stockportfolio.pro/tools/earnings-quality');
    await waitForPage(driver);
    await overlay(driver, '1. Start with a ticker.', 'The free earnings-quality checker is deterministic and needs no login.');
    await runTool(driver, 'earnings-quality');
    await sleep(5000);
    await scrollTo(driver, '[data-tool-result], .tool-result, main');
    await overlay(driver, '2. Read the filed-period result.', 'Compare net income, operating cash flow and free cash flow for the same period.');
    await sleep(25000);
    await driver.get('https://www.stockportfolio.pro/tools/filing-timeline');
    await waitForPage(driver);
    await overlay(driver, '3. Open the filing timeline.', 'Use the dates and forms to avoid mixing annual, quarterly and event disclosures.');
    await runTool(driver, 'filing-timeline');
    await sleep(5000);
    await scrollTo(driver, 'a[href*="sec.gov"], [data-source], main');
    await overlay(driver, '4. Open the source link.', 'The underlying SEC filing is one click away.');
    await sleep(15000);
    await visit(driver, 'https://www.stockportfolio.pro/stocks/NVDA', '5. Continue the research.', 'Use the company page for longer-period fundamentals and related evidence.', 12000);
    await scrollTo(driver, 'main');
    await overlay(driver, '6. Ask a narrower question next.', 'Keep the ticker, period and source in view as you investigate.');
    await sleep(18000);
    await driver.get('https://www.stockportfolio.pro/tools/dilution');
    await waitForPage(driver);
    await overlay(driver, '7. Try one additional workflow.', 'The dilution checker compares filed share counts and flags comparability limits.');
    await runTool(driver, 'dilution');
    await sleep(5000);
    await scrollTo(driver, '[data-tool-result], .tool-result, main');
    await overlay(driver, 'Start with one company you already care about.', 'Then follow the evidence trail one question at a time.');
    await sleep(25000);
  } finally {
    rec.kill('SIGINT');
    await new Promise((resolve) => rec.once('close', resolve));
  }
}

async function main() {
  const selected = process.argv.includes('--video') ? process.argv[process.argv.indexOf('--video') + 1] : 'both';
  if (!['sales', 'onboarding', 'both'].includes(selected)) throw new Error('--video must be sales, onboarding or both');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = await buildDriver();
  try {
    if (selected === 'sales' || selected === 'both') {
      await runSales(driver, path.join(OUT_DIR, 'appsumo-sales-demo.mp4'));
    }
    if (selected === 'onboarding' || selected === 'both') {
      await runOnboarding(driver, path.join(OUT_DIR, 'appsumo-onboarding.mp4'));
    }
  } finally {
    await driver.quit();
  }
  console.log(JSON.stringify({ ok: true, outputDir: OUT_DIR, files: fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.mp4')) }, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
