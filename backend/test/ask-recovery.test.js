'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('Ask has bounded retry, preserves the question, and offers deterministic recovery', () => {
    const source = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
    assert.match(source, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
    assert.match(source, /data-ask-retry/);
    assert.match(source, /Your question is preserved above/);
    assert.match(source, /free-tools\/\$\{tool\}\?symbol=/);
    assert.match(source, /AI synthesis is temporarily unavailable/);
    assert.match(source, /source !== 'error'/);
    assert.match(source, /dilut\|share count/);
    assert.match(source, /filing\|10-k\|10-q/);
});

test('Ask runtime cache-busts all pages after recovery changes', () => {
    const files = [];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const file = path.join(dir, name);
            const stat = fs.statSync(file);
            if (stat.isDirectory()) walk(file);
            else if (/\.(html|js)$/.test(name)) files.push(file);
        }
    };
    walk(path.join(root, 'frontend-v2'));
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes('app.js?v=20260822-receipt1')) {
            assert.fail(`${file} still references the stale Ask runtime`);
        }
    }
    const askPage = fs.readFileSync(path.join(root, 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(askPage, /app\.js\?v=20260831-ladder1/);
});

test('AppSumo FAQ explains recurring website Pro versus lifetime tiers and fund coverage', () => {
    const html = fs.readFileSync(path.join(root, 'frontend-v2', 'appsumo.html'), 'utf8');
    assert.match(html, /Is AppSumo Pro the same as the website Pro plan/);
    assert.match(html, /one-time lifetime-deal entitlements/);
    assert.match(html, /Does the deal include ETFs and mutual funds/);
    assert.match(html, /What happens when new features launch/);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length >= 2, 'AppSumo structured data exists');
    const faq = blocks.map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'FAQPage');
    assert.ok(faq && Array.isArray(faq.mainEntity), 'FAQ JSON-LD parses');
    assert.ok(faq.mainEntity.some((x) => /website Pro/.test(x.name)));
});
