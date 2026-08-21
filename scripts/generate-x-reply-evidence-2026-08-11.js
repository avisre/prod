#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Builder, By, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'marketing/campaign-2026-08-appsumo-sprint/evidence/2026-08-11');
const BASE = 'https://www.stockportfolio.pro';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const items = [
  ['intc-dilution.png', '/tools/dilution', 'INTC'],
  ['rkbl-earnings-quality.png', '/tools/earnings-quality', 'RKLB'],
  ['pltr-earnings-quality.png', '/tools/earnings-quality', 'PLTR'],
  ['app-earnings-quality.png', '/tools/earnings-quality', 'APP'],
  ['gme-earnings-quality.png', '/tools/earnings-quality', 'GME'],
  ['hims-earnings-quality.png', '/tools/earnings-quality', 'HIMS'],
  ['ba-earnings-quality.png', '/tools/earnings-quality', 'BA'],
  ['ceva-earnings-quality.png', '/tools/earnings-quality', 'CEVA'],
  ['klac-earnings-quality.png', '/tools/earnings-quality', 'KLAC'],
  ['tln-earnings-quality.png', '/tools/earnings-quality', 'TLN'],
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const options = new chrome.Options()
    .setChromeBinaryPath('/home/hardoker77/.cache/selenium/chrome/linux64/151.0.7922.71/chrome')
    .addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900');
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  try {
    for (const [file, route, symbol] of items) {
      await driver.get(BASE + route);
      await driver.wait(async () => driver.executeScript('return document.readyState === "complete"'), 30000);
      const input = await driver.findElement(By.id('symbols'));
      await input.clear();
      await input.sendKeys(symbol, Key.ESCAPE);
      const submit = await driver.findElement(By.css('#form button[type="submit"]'));
      await driver.executeScript('arguments[0].click()', submit);
      await driver.wait(async () => {
        const text = await driver.findElement(By.id('result')).getText();
        return text && !/^Ready/i.test(text) && !/Loading filed data/i.test(text);
      }, 40000);
      await sleep(800);
      const result = await driver.findElement(By.id('result'));
      await driver.executeScript('arguments[0].scrollIntoView({block:"center"})', result);
      await sleep(350);
      const output = path.join(OUT, file);
      fs.writeFileSync(output, await result.takeScreenshot(true), 'base64');
      console.log(`${symbol}\t${output}\t${fs.statSync(output).size}`);
    }
  } finally {
    await driver.quit();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
