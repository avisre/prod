#!/usr/bin/env node
'use strict';

// Browser-assisted social composer.
//
// This tool intentionally stops before the platform's Publish/Post button:
// the owner reviews and clicks that button manually. It stores the browser
// profile outside the repository, never prints cookies/tokens, and only accepts
// approved drafts from social-queue.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { ACQUISITION_CONTENT_IDS } = require('../backend/share-copy');

const ROOT = path.resolve(__dirname, '..');
const QUEUE = path.join(__dirname, 'social-queue.json');
const DEFAULT_PROFILE = path.join(os.homedir(), '.local', 'share', 'stockportfolio-social-profile');
const DEFAULT_TRACKER = path.join(ROOT, 'marketing', 'campaign-2026-07-28', 'tracker.csv');
const PLATFORMS = new Set(['x', 'linkedin']);
const CONTENT_ID_RE = /^(?:research-(?:shares-outstanding|pe-ratio-history|dilution-scorecard)|tool-[a-z0-9-]{3,48})$/;
const CLICK_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const MAX_CHARS = { x: 280, linkedin: 3000 };

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }
function fail(message) { throw new Error(message); }

function loadDraft(id) {
    const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
    const draft = queue.find((item) => item.id === id);
    if (!draft) fail(`Unknown draft: ${id}`);
    return draft;
}

async function checkSource(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !/^www\.stockportfolio\.pro$/.test(target.hostname)) fail(`Source must be stockportfolio.pro HTTPS: ${url}`);
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (!response.ok) fail(`Current source check failed (${response.status}): ${url}`);
    const html = await response.text();
    if (!html.includes('canonical') || !/SEC|filing|research/i.test(html)) fail(`Source lacks expected research evidence: ${url}`);
    return { status: response.status, bytes: Buffer.byteLength(html) };
}

async function validateDraft(draft) {
    if (!PLATFORMS.has(draft.platform)) fail('platform must be x or linkedin');
    if (draft.source !== draft.platform) fail('source must match platform');
    if (draft.approved !== true) fail('draft is not marked approved');
    if (!CONTENT_ID_RE.test(String(draft.contentId || '')) || !ACQUISITION_CONTENT_IDS.has(String(draft.contentId || ''))) fail('contentId is not an allowlisted research ID');
    if (!String(draft.text || '').trim()) fail('draft text is empty');
    if (draft.text.length > MAX_CHARS[draft.platform]) fail(`${draft.platform} draft exceeds ${MAX_CHARS[draft.platform]} characters`);
    const format = String(draft.format || 'post').toLowerCase();
    if (!['post', 'reply'].includes(format)) fail('format must be post or reply');
    if (format === 'reply') {
        if (draft.platform !== 'x') fail('reply composer currently supports X only');
        const target = new URL(draft.targetUrl);
        if (target.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(target.hostname)
            || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(target.pathname)) fail('reply target must be an X status URL');
    }
    if (!CLICK_ID_RE.test(String(draft.clickId || ''))) fail('clickId must be 8-32 URL-safe characters');
    const cta = new URL(draft.ctaUrl);
    if (cta.protocol !== 'https:' || cta.hostname !== 'www.stockportfolio.pro') fail('CTA must use www.stockportfolio.pro HTTPS');
    if (!/^\/(?:tools|research|appsumo)(?:\/|$)/.test(cta.pathname)) fail('CTA must point to an approved tool, research page, or AppSumo bridge');
    if (cta.searchParams.get('source') !== draft.source) fail('CTA source does not match platform');
    if (cta.searchParams.get('content_id') !== draft.contentId) fail('CTA content_id does not match draft');
    if (cta.searchParams.get('click_id') !== draft.clickId) fail('CTA click_id does not match draft');
    if (draft.ctaInText === true && !draft.text.includes(draft.ctaUrl)) fail('CTA is marked in-text but missing from the draft');
    if (!Array.isArray(draft.sourceUrls) || draft.sourceUrls.length === 0) fail('sourceUrls is required');
    for (const url of draft.sourceUrls) await checkSource(url);
    if (draft.imagePath) {
        const image = path.resolve(ROOT, draft.imagePath);
        if (!image.startsWith(`${ROOT}${path.sep}`)) fail('imagePath must stay inside the repository');
        if (!fs.existsSync(image)) fail(`imagePath does not exist: ${draft.imagePath}`);
    }
    return draft;
}

function chromeBinary() {
    const candidates = [
        process.env.SOCIAL_CHROME_BINARY,
        '/home/hardoker77/.cache/selenium/chrome/linux64/150.0.7871.24/chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildDriver(profileDir) {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(profileDir, 0o700); } catch (_) {}
    const options = new chrome.Options()
        .addArguments(`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-notifications');
    if (hasFlag('headless')) options.addArguments('--headless=new', '--window-size=1440,1100');
    const binary = chromeBinary();
    if (binary) options.setChromeBinaryPath(binary);
    return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

async function firstElement(driver, selectors, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const selector of selectors) {
            try {
                const element = await driver.findElement(By.css(selector));
                if (await element.isDisplayed()) return element;
            } catch (_) {}
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
}

async function compose(draft, profileDir) {
    const driver = await buildDriver(profileDir);
    const format = String(draft.format || 'post').toLowerCase();
    const url = format === 'reply'
        ? draft.targetUrl
        : (draft.platform === 'x' ? 'https://x.com/compose/post' : 'https://www.linkedin.com/feed/?shareActive=true');
    await driver.get(url);
    if (format === 'reply') {
        const replyButton = await firstElement(driver, ['[data-testid="reply"]', 'button[aria-label^="Reply"]'], 30000);
        if (!replyButton) fail('Reply control was not found on the target post');
        await replyButton.sendKeys(Key.ENTER);
    }
    const selectors = draft.platform === 'x'
        ? ['[data-testid="tweetTextarea_0"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="Post"]']
        : ['div[contenteditable="true"][role="textbox"]', '.ql-editor[contenteditable="true"]', 'textarea[placeholder*="What do you want to talk about"]'];
    const editor = await firstElement(driver, selectors);
    if (!editor) {
        console.error(`Could not find the ${draft.platform} composer. Log in manually if needed, then rerun this command.`);
        await driver.quit();
        return { publishedUrl: null };
    }
    await editor.sendKeys(draft.text);
    if (draft.imagePath) {
        const input = await firstElement(driver, ['input[type="file"]'], 10000);
        if (!input) fail('Image upload control was not found');
        await input.sendKeys(path.resolve(ROOT, draft.imagePath));
    }
    console.log(`Composer ready for ${draft.platform}: ${draft.id}`);
    console.log('Review the text, source, image and tracked link in the browser. Click Publish/Post yourself; this tool never clicks it.');
    if (!process.stdin.isTTY || hasFlag('no-wait')) return { publishedUrl: null };
    await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Press Enter after you publish (or leave it as a draft): ', () => { rl.close(); resolve(); });
    });
    const current = await driver.getCurrentUrl();
    return { publishedUrl: /x\.com\/[^/]+\/status\/\d+|linkedin\.com\/(posts|feed\/update)\//i.test(current) ? current : null };
}

function csvCell(value) { return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`; }
function recordTracker(draft, publishedUrl, trackerPath) {
    if (!publishedUrl || !fs.existsSync(trackerPath)) return false;
    const lines = fs.readFileSync(trackerPath, 'utf8').split(/\r?\n/);
    const index = lines.findIndex((line) => line.split(',')[0].replace(/^"|"$/g, '') === draft.id);
    if (index < 0) return false;
    const cells = lines[index].match(/(?:"(?:[^"]|"")*"|[^,])*/g).filter((cell, i, arr) => !(i === arr.length - 1 && cell === ''));
    if (cells.length >= 8) cells[7] = csvCell(publishedUrl);
    lines[index] = cells.join(',');
    fs.writeFileSync(trackerPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
    return true;
}

async function main() {
    const id = arg('draft');
    if (!id) fail('Usage: node scripts/social-compose.js --platform x|linkedin --draft DRAFT_ID [--dry-run]');
    const draft = loadDraft(id);
    const platform = arg('platform');
    if (platform && platform !== draft.platform) fail(`Draft ${id} belongs to ${draft.platform}, not ${platform}`);
    await validateDraft(draft);
    if (hasFlag('dry-run')) {
        console.log(JSON.stringify({ id: draft.id, platform: draft.platform, characters: draft.text.length, sourceUrls: draft.sourceUrls.length, ctaUrl: draft.ctaUrl }, null, 2));
        return;
    }
    const profileDir = arg('profile-dir', process.env.STOCKSOCIAL_PROFILE_DIR || DEFAULT_PROFILE);
    const result = await compose(draft, profileDir);
    if (result.publishedUrl) {
        const tracker = arg('tracker', DEFAULT_TRACKER);
        console.log(`Published URL detected: ${result.publishedUrl}`);
        console.log(recordTracker(draft, result.publishedUrl, tracker) ? `Tracker updated: ${tracker}` : 'Tracker row not updated; record the URL manually.');
    }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { loadDraft, validateDraft, MAX_CHARS, CONTENT_ID_RE, CLICK_ID_RE, DEFAULT_PROFILE };
