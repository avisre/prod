'use strict';

// Bing's URL Inspection reports "Title too long" above 70 characters and "Meta
// Description too long or too short" outside 25-160, and its Recommendations
// panel named six live URLs on 2026-09-28: the homepage, three /compare pairs and
// two /screens pages. Nothing in this suite guarded any of them, and measuring
// that day showed why it mattered — 1,469 of the 1,502 /stocks pages (worst 204
// characters) and 1,165 of the 12,338 metric pages (worst 193) were out of range
// on the description alone, every one of them because a template appended a long
// boilerplate tail to an unstripped legal name. The renderers now hold themselves
// to 65/158, inside Bing's limits with margin; this file is what stops a future
// template edit from silently putting thousands of pages back over.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const seo = require('../seo-pages');
const extra = require('../seo-extra');
const comparePages = require('../comparison-pages');
const docsPages = require('../docs-pages');
const freeTools = require('../free-tools');

const TITLE_MAX = 65;
const DESC_MAX = 158;
const DESC_MIN = 25;

const decode = (s) => String(s)
    .replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

// The rendered text is what Bing counts, so entities are decoded before
// measuring — "&amp;" is five characters in the source and one in the SERP.
function metaOf(html) {
    const src = typeof html === 'string' ? html : (html && html.html) || '';
    if (!src) return null;
    const title = decode((src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].replace(/\s+/g, ' ').trim());
    let desc = '';
    for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
        if (/name\s*=\s*["']description["']/i.test(m[0])) {
            desc = decode(((m[0].match(/content\s*=\s*["']([^"']*)["']/i) || [, ''])[1]).replace(/\s+/g, ' ').trim());
            break;
        }
    }
    return { title, desc };
}

function assertInBudget(label, html) {
    const meta = metaOf(html);
    assert.ok(meta, `${label}: expected a rendered page, got an empty or object return`);
    assert.ok(meta.title.length <= TITLE_MAX,
        `${label}: title is ${meta.title.length} characters (max ${TITLE_MAX}) — ${meta.title}`);
    assert.ok(meta.desc.length <= DESC_MAX,
        `${label}: description is ${meta.desc.length} characters (max ${DESC_MAX}) — ${meta.desc}`);
    assert.ok(meta.desc.length >= DESC_MIN,
        `${label}: description is only ${meta.desc.length} characters (min ${DESC_MIN}) — ${meta.desc}`);
}

test('every indexable frontend-v2 page keeps its title and description inside the SERP budgets', () => {
    const dir = path.join(__dirname, '../../frontend-v2');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length >= 9, 'expected the served pages to be present');
    let checked = 0;
    for (const file of pages) {
        const html = fs.readFileSync(path.join(dir, file), 'utf8');
        // noindex pages (admin, inbox, checkout shells) never enter a SERP, so
        // their length is not a defect; the budget applies to what can rank.
        if (/<meta\b[^>]*name=["']robots["'][^>]*noindex/i.test(html.slice(0, 4000))) continue;
        assertInBudget(`frontend-v2/${file}`, html);
        checked++;
    }
    assert.ok(checked >= 8, `expected at least 8 indexable pages, checked ${checked}`);
});

// The worst case for a page whose head embeds a company name is the longest name
// in the universe, so the test derives that list from the data rather than
// naming symbols a future refresh could drop from the index. The explicit list
// holds the symbols that were over on 9/28, so a regression on any of them is
// caught even if they leave the company file.
const KNOWN_LONG = ['SBCF', 'ZION', 'AIG', 'CRL', 'WAB', 'AAT', 'USLM', 'AAOI', 'ONTO', 'AAMI'];

function longNameSymbols() {
    const companies = seo.loadCompanies();
    const byLength = companies.slice().sort((a, b) => String(b.name || '').length - String(a.name || '').length);
    const symbols = [...byLength.slice(0, 10).map((c) => c.symbol), ...KNOWN_LONG];
    return [...new Set(symbols)].filter((s) => s && seo.hasStockPage(s));
}

test('/stocks pages hold the budgets for the longest company names in the data', () => {
    const symbols = longNameSymbols();
    assert.ok(symbols.length >= 10, `expected a worst-case sample, got ${symbols.length}`);
    for (const sym of symbols) assertInBudget(`/stocks/${sym}`, seo.renderStockPage(sym, {}));
});

test('every metric page holds the budgets for the longest company names in the data', () => {
    const symbols = longNameSymbols();
    const slugs = extra.METRIC_SLUGS || [];
    assert.ok(slugs.length >= 10, `expected the metric slugs, got ${slugs.length}`);
    let rendered = 0;
    for (const sym of symbols) {
        for (const slug of slugs) {
            const html = extra.renderMetricPage(sym, slug, {});
            if (!html) continue; // no data / fewer than two usable rows is a real state, not a defect
            assertInBudget(`/stocks/${sym}/${slug}`, html);
            rendered++;
        }
    }
    assert.ok(rendered >= 30, `expected to render most metric pages, rendered ${rendered}`);
});

test('compare pairs hold the budgets, including the long fund names', () => {
    // Pairs the module itself knows about, plus pairs built from the longest
    // company names — the fund names are the ones that ran to 156 characters.
    const symbols = longNameSymbols().slice(0, 8);
    const constructed = [];
    for (let i = 0; i < symbols.length; i += 2) {
        const pair = [symbols[i], symbols[i + 1]].filter(Boolean).sort();
        if (pair.length === 2) constructed.push(`${pair[0]}-vs-${pair[1]}`);
    }
    const known = (extra.comparePairs() || []).slice(0, 20);
    let rendered = 0;
    for (const slug of [...new Set([...constructed, ...known])]) {
        const html = extra.renderComparePage(slug);
        if (!html || !html.html) continue; // unknown pair or a redirect entry
        assertInBudget(`/compare/${slug}`, html);
        rendered++;
    }
    assert.ok(rendered >= 15, `expected to render most pairs, rendered ${rendered}`);
});

test('the /screens titles stay inside the budget', () => {
    // renderScreenPage needs the live screen index, which a test process does not
    // build, so the title is checked at its source: every screen title is
    // `${h1} (${year})`, and it was the trailing "— Ranked by Filed Fundamentals"
    // that pushed all 17 past the limit (69-88 characters, measured 9/28).
    const source = fs.readFileSync(path.join(__dirname, '../seo-extra.js'), 'utf8');
    const start = source.indexOf('const SCREENS = {');
    assert.ok(start !== -1, 'the SCREENS table must exist');
    const block = source.slice(start, source.indexOf('\n};', start));
    const year = new Date().getFullYear();
    const h1s = [...block.matchAll(/h1:\s*'([^']*)'/g)].map((m) => m[1]);
    assert.ok(h1s.length >= 17, `expected every screen to carry an h1, found ${h1s.length}`);
    for (const h1 of h1s) {
        const title = `${h1} (${year})`;
        assert.ok(title.length <= TITLE_MAX, `screen title is ${title.length} characters — ${title}`);
    }
});

test('the /vs/ alternative pages, docs pages and free-tool pages hold the budgets', () => {
    let rendered = 0;
    for (const slug of comparePages.competitors || []) {
        const html = comparePages.renderComparison(slug);
        if (!html) continue;
        assertInBudget(`/vs/${slug}`, html);
        rendered++;
    }
    assert.ok(rendered >= 14, `expected all competitor pages to render, rendered ${rendered}`);

    for (const key of Object.keys(docsPages.DOC_PAGES || {})) {
        assertInBudget(`docs/${key}`, docsPages.renderDocPage(key));
    }
    for (const key of Object.keys(freeTools.TOOL_DEFINITIONS || {})) {
        assertInBudget(`/tools/${key}`, freeTools.renderToolPage(key));
    }
    assertInBudget('/tools', freeTools.renderToolIndex());
    assertInBudget('/compare', extra.renderCompareIndex({}));
});
