#!/usr/bin/env node
'use strict';

// Read-only discovery for recent, explicit research-tool problems on X.
// Uses the private persistent browser profile and prints public post text/URLs
// only. It never reads or prints cookies and performs no engagement action.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function chromeBinary() {
    const candidates = [
        process.env.SOCIAL_CHROME_BINARY,
        '/home/hardoker77/.cache/selenium/chrome/linux64/150.0.7871.24/chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function driver(profileDir) {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const options = new chrome.Options().addArguments(
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-notifications',
        '--window-size=1440,1200'
    );
    if (!hasFlag('show')) options.addArguments('--headless=new');
    const binary = chromeBinary();
    if (binary) options.setChromeBinaryPath(binary);
    return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

async function main() {
    const query = arg('query');
    if (!query) throw new Error('Usage: node scripts/x-intent-search.js --query "search terms" [--max 10]');
    const max = Math.min(30, Math.max(1, Number(arg('max', '10')) || 10));
    const profile = arg('profile-dir', process.env.STOCKSOCIAL_PROFILE_DIR || path.join(os.homedir(), '.local', 'share', 'stockportfolio-social-profile'));
    const browser = driver(profile);
    try {
        const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
        await browser.get(url);
        const deadline = Date.now() + 30000;
        let articles = [];
        while (Date.now() < deadline) {
            articles = await browser.findElements(By.css('article[data-testid="tweet"]'));
            if (articles.length) break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const results = [];
        for (const article of articles.slice(0, max)) {
            const text = String(await article.getText()).replace(/\s+/g, ' ').trim().slice(0, 700);
            const links = await article.findElements(By.css('a[href*="/status/"]'));
            let targetUrl = null;
            for (const link of links) {
                const href = await link.getAttribute('href');
                if (/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(String(href || ''))) {
                    targetUrl = href;
                    break;
                }
            }
            if (text && targetUrl && !results.some((row) => row.targetUrl === targetUrl)) results.push({ targetUrl, text });
        }
        const currentUrl = String(await browser.getCurrentUrl());
        let diagnostic = null;
        if (!results.length) {
            const body = await browser.findElement(By.css('body')).getText().catch(() => '');
            diagnostic = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 240) || 'No visible search text';
        }
        const loginRequired = /\/login(?:[/?#]|$)|\/i\/jf\/onboarding\/web|[?&]mode=login(?:&|$)/i.test(currentUrl);
        console.log(JSON.stringify({ query, authenticated: !loginRequired, currentUrl, results, diagnostic }, null, 2));
    } finally {
        await browser.quit();
    }
}

if (require.main === module) main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
