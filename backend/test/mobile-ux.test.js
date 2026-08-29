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