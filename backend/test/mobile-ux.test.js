'use strict';

// Mobile/tablet UX fixes (2026-08-30 audit): everything here was a measured
// failure in headless Chrome at 390px/768px. Pins content, not stamps — plain
// assets never carry the stamp string (the profile.js deploy lesson).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const screenerHtml = read('frontend-v2', 'screener.html');
const lifetimeHtml = read('frontend-v2', 'lifetime.html');
const appsumoHtml = read('frontend-v2', 'appsumo.html');
const css = read('frontend-v2', 'assets', 'system.css');
const appJs = read('frontend-v2', 'assets', 'app.js');
const freeTools = read('backend', 'free-tools.js');
const seoPages = read('backend', 'seo-pages.js');
const gurusHtml = read('frontend-v2', 'gurus.html');
const indexHtml = read('frontend-v2', 'index.html');

test('screener CTA buttons wrap instead of overflowing the phone viewport', () => {
    // measured 82px of document-level overflow at 390px before this
    assert.match(
        screenerHtml,
        /display:flex; gap:12px; align-items:center; flex-wrap:wrap;[^>]*>\s*<a class="btn btn-primary" href="\/register\.html"/
    );
});

test('/lifetime is no longer an orphan page — it mounts the shared nav and footer', () => {
    assert.match(lifetimeHtml, /<script src="\/assets\/app\.js\?v=/);
    assert.match(lifetimeHtml, /V2\.nav\('lifetime'\); V2\.footer\(\);/);
});

test('the AppSumo topbar links back to the main site', () => {
    assert.match(appsumoHtml, /<a class="as-wordmark" href="\/"/);
});

test('the mobile drawer close button has a real hit area', () => {
    const block = css.match(/\.nav-mobile-close \{[^}]*\}/);
    assert.ok(block, 'drawer close rule present');
    assert.match(block[0], /padding: 12px;/);
});

test('the crushed header search moves into the drawer on phones', () => {
    // header input hides below 640px...
    assert.match(css, /@media \(max-width: 640px\) \{\s*\.nav-inner \.nav-search \{ display: none; \}\s*\}/);
    // ...and the drawer carries its own wired instance
    assert.match(appJs, /id="v2-mobile-search"/);
    assert.match(appJs, /wireSearch\(mob\.querySelector\('#v2-mobile-search'\), mob\.querySelector\('#v2-mobile-search-results'\)\)/);
    assert.match(css, /\.nav-mobile-panel \.nav-search \{/);
});

test('phone touch floors: checkboxes, dense tables, chips past 760px too', () => {
    assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?input\[type='checkbox'\] \{ width: 20px; height: 20px;[\s\S]*?\.table-data \{ font-size: 12\.5px; \}/);
    // tablets measured 26px chips — the 40px floor now holds to 900px
    assert.match(css, /@media \(max-width: 900px\) \{\s*\.chip \{ min-height: 40px; display: inline-flex; align-items: center; \}\s*\}/);
});

test('tools-index "Open tool →" links are a tap target, not a 21px sliver', () => {
    assert.match(freeTools, /\.tool-link\{[^}]*display:inline-block;padding:8px 0\}/);
});

// ── Pass 2: gurus 13F table reflow + the server-rendered pages (measured on
// the live site after pass 1 — gurus tinyText 73, /research/dilution-scorecard
// 78 tiny taps, /tools 33, appsumo 15/19, land 19) ──

test('gurus: the 13F table becomes labelled cards instead of scrolling sideways on phones', () => {
    const block = gurusHtml.match(/@media \(max-width: 640px\) \{[\s\S]*?\.scroll-top \{ display: none; \}[\s\S]*?\n    \}/);
    assert.ok(block, 'card-reflow block present');
    assert.match(block[0], /\.guru-table tr \{ display: block;/);
    assert.match(block[0], /\.guru-table td::before \{ content: attr\(data-label\)/);
    assert.match(block[0], /\.guru-table tr\[hidden\] \{ display: none; \}/);
    // rows carry the labels the cards render
    assert.match(gurusHtml, /data-label="% Portfolio"/);
    assert.match(gurusHtml, /data-label="Activity"/);
    assert.match(gurusHtml, /data-label="Company · #\$\{i \+ 1\}"/);
});

test('gurus: no sub-11.5px text left — cusips, badges, perf labels, pill initials', () => {
    assert.match(gurusHtml, /\.co-cusip \{ font-size: 11\.5px;/);
    assert.match(gurusHtml, /\.activity-badge \{[\s\S]*?font-size: 11\.5px;/);
    assert.match(gurusHtml, /\.perf-cell-period \{\s*font-size: 11\.5px;/);
    assert.match(gurusHtml, /\.guru-stat-k \{ font-size: 11\.5px;/);
    assert.match(gurusHtml, /\.guru-pill \.guru-avatar \{ width: 24px; height: 24px; font-size: 11\.5px; \}/);
    assert.match(gurusHtml, /\.co-link \{[^}]*display: inline-block; padding: 6px 0;/);
});

test('server-rendered data-table links and nav links are real tap targets', () => {
    assert.match(seoPages, /\.seo-table td a\{display:inline-block;padding:6px 0/);
    assert.match(seoPages, /\.seo-nav-links a\{display:inline-block;padding:11px 2px\}/);
    // chip links keep a taller touch surface
    assert.match(seoPages, /\.seo-links a\{font-size:12px;padding:10px 12px;/);
});

test('tools pages: card headlines and the all-tools link list are tap-sized', () => {
    assert.match(freeTools, /\.tool-grid h2 a\{display:inline-block;padding:5px 0\}/);
    assert.match(freeTools, /\.tools a\{display:block;padding:8px 0;/);
});

test('appsumo: evidence, footer, demo and FAQ taps all clear the floor', () => {
    assert.match(appsumoHtml, /\.as-evidence-links a \{ display: inline-block; padding: 6px 0; \}/);
    assert.match(appsumoHtml, /\.as-footer-links a \{ display: inline-block; padding: 10px 0; \}/);
    assert.match(appsumoHtml, /\.as-demo-note a \{ display: inline-block; padding: 6px 0; \}/);
    assert.match(appsumoHtml, /\.as-faq summary \{ cursor: pointer; font-weight: 600; display: block; padding: 10px 0;/);
});

test('landing page: prose-level links are padded tap targets', () => {
    assert.match(indexHtml, /\.hero-note a, \.provenance a, p\.small a, span\.small a \{ display: inline-block; padding: 6px 0; \}/);
});