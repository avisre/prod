'use strict';

// /ask?q=… is linked from every company and metric page. Before the fix each
// variant was an indexable 200 carrying the same <title> and <meta
// description>, which is what Bing Webmaster flags as "too many pages with
// identical titles" and "identical meta descriptions" (measured 2026-09-24:
// 3,012 distinct prefilled URLs linked from the crawlable pages).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const askPage = require('../ask-page');

const APP = path.join(__dirname, '..', 'app.js');
const plain = askPage.renderAskPage({});

test('the plain /ask shell is served untouched', () => {
    assert.ok(plain.length > 500, 'ask.html template loads');
    assert.doesNotMatch(plain, /name="robots"/i, 'static /ask keeps no robots meta');
    assert.match(plain, /<link rel="canonical" href="https:\/\/www\.stockportfolio\.pro\/ask" \/>/);
    assert.match(plain, /<title>Ask stocks and funds with source context \| stockportfolio\.pro<\/title>/);
});

test('a prefilled /ask?q=… is noindex,follow and keeps the same content', () => {
    const html = askPage.renderAskPage({ q: 'Give me your full analysis of AAPL' });
    assert.match(html, /<meta name="robots" content="noindex, follow" \/>/);
    assert.equal((html.match(/name="robots"/gi) || []).length, 1, 'exactly one robots meta');
    // Same title, description and canonical as the plain shell: only the
    // crawler directive differs, so the canonical keeps consolidating on /ask.
    assert.match(html, /<title>Ask stocks and funds with source context \| stockportfolio\.pro<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.stockportfolio\.pro\/ask" \/>/);
    const strip = (s) => s.replace(/<meta name="robots"[^>]*>\s*/, '');
    assert.equal(strip(html), plain, 'noindex is the only difference from the plain shell');
});

test('a query string that is not q is still treated as user state', () => {
    assert.match(askPage.renderAskPage({ utm_source: 'x' }), /noindex, follow/);
});

test('hasUserState distinguishes the shell from a prefilled variant', () => {
    assert.equal(askPage.hasUserState(undefined), false);
    assert.equal(askPage.hasUserState({}), false);
    assert.equal(askPage.hasUserState({ q: '' }), true);
    assert.equal(askPage.hasUserState({ q: 'apple' }), true);
});

test('an existing robots meta is replaced, never duplicated', () => {
    const indexable = plain.replace('<link rel="canonical"', '<meta name="robots" content="index, follow" />\n  <link rel="canonical"');
    const patched = askPage.withAskRobots(indexable, { q: 'x' });
    assert.equal((patched.match(/name="robots"/gi) || []).length, 1, 'still exactly one robots meta');
    assert.match(patched, /noindex, follow/);
    assert.doesNotMatch(patched, /content="index, follow"/);
});

test('withAskRobots leaves an empty template alone', () => {
    assert.equal(askPage.withAskRobots('', { q: 'x' }), '');
    assert.equal(askPage.withAskRobots(plain, {}), plain);
});

test('the /ask route is registered ahead of express.static', () => {
    const src = fs.readFileSync(APP, 'utf8');
    const route = src.indexOf("app.get(['/ask', '/ask.html']");
    const staticMount = src.indexOf("express.static(path.join(__dirname, '../frontend-v2')");
    assert.ok(route > -1, 'the /ask route exists in app.js');
    assert.ok(staticMount > -1, 'express.static is mounted in app.js');
    assert.ok(route < staticMount, 'the /ask route must win the path before express.static');
});
