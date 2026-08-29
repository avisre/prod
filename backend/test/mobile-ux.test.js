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
    assert.match(css, /@media \(max-width: 900px\) \{\s*\.chip \{ min-height: 40px; display: inline-flex; align-items: center; \}\s*input\[type='checkbox'\] \{ width: 20px; height: 20px; flex: none; \}\s*\}/);
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
    assert.match(indexHtml, /\.hero-note a, \.provenance a, p\.small a, span\.small a, a\.small \{ display: inline-block; padding: 6px 4px; \}/);
});
// ── Pass 3+4: the sitewide furniture (measured live after pass 2 — land 6/5,
// register 3/5, research 4/27: wordmark, consent, footer, seo prose links;
// pass 4 clears the last decorative glyphs — nav caret, register step dots) ──

test('sitewide: wordmark and consent links are full-height tap targets', () => {
    assert.match(css, /\.wordmark \{[\s\S]*?padding: 4px 0;/);
    assert.match(css, /\.consent-actions a \{ margin-left: auto; font-size: var\(--text-xs\); display: inline-block; padding: 7px 2px; \}/);
    assert.match(css, /\.footer a \{ color: var\(--ink-2\); display: inline-block; padding: 6px 3px; \}/);
    assert.match(css, /\.footer a \{ padding: 12px 6px; \}/);
});

test('landing page: comparison-table headers and narrow prose links clear the floors', () => {
    assert.match(indexHtml, /font-size:11\.5px; text-transform:uppercase; letter-spacing:0\.05em;/);
    assert.match(indexHtml, /\.hero-note a, \.provenance a, p\.small a, span\.small a, a\.small \{ display: inline-block; padding: 6px 4px; \}/);
});

test('register page: trust-copy links are padded tap targets', () => {
    const regHtml = read('frontend-v2', 'register.html');
    assert.match(regHtml, /p\.small\.faint a, p\.small\.muted a \{ display: inline-block; padding: 7px 2px; \}/);
});

test('seo pages: tile labels hit the 11.5px text floor and prose/footer links are padded', () => {
    assert.match(seoPages, /\.seo-tile \.l\{font-size:11\.5px;/);
    assert.match(seoPages, /\.seo-foot a,\.seo-about a,\.seo-section p a\{display:inline-block;padding:6px 2px\}/);
});

// ── Pass 5: the last borderline taps (measured live after pass 4) ──

test('404 recovery links, screener tool links, comparison foot links and monitor note links are tap-sized', () => {
    const p404 = read('frontend-v2', '404.html');
    assert.match(p404, /font-weight:600; display:inline-block; padding:8px 3px;/);
    assert.match(screenerHtml, /<a style="display:inline-block; padding:8px 3px;" href="\/tools\/dilution">/);
    const cmpPages = read('backend', 'comparison-pages.js');
    assert.match(cmpPages, /\.seo-foot a\{color:var\(--muted\);display:inline-block;padding:8px 3px\}/);
    const monHtml = read('frontend-v2', 'monitor.html');
    assert.match(monHtml, /<a style="display:inline-block; padding:8px 6px;" href="\/ask\.html">Ask<\/a>/);
});

// ── Pass 6: sitewide prose-link tap rule + the last stragglers ──

test('system.css: prose-paragraph links sitewide and mobile footer links are tap-sized', () => {
    assert.match(css, /p\.small a, p\.muted a, p\.small\.muted a, p\.small\.faint a \{ display: inline-block; padding: 6px 3px; \}/);
    assert.match(css, /\.footer a \{ padding: 12px 6px; \}/);
});

test('ask quota line, gurus provenance, appsumo wordmark/badge and tools-index trailing link are tap-sized', () => {
    const askHtml = read('frontend-v2', 'ask.html');
    assert.match(askHtml, /\.composer-foot a \{ display: inline-block; padding: 5px 2px; \}/);
    assert.match(gurusHtml, /\.provenance a \{ display: inline-block; padding: 6px 3px; \}/);
    assert.match(appsumoHtml, /\.as-wordmark \{[^}]*padding: 4px 0;[^}]*\}/);
    assert.match(appsumoHtml, /\.as-plan-badge \{[^}]*font-size: 11\.5px;/);
    assert.match(freeTools, /\.tools-index p a\{display:inline-block;padding:8px 2px\}/);
});

test('seo nav links clear the tablet breakpoint', () => {
    assert.match(seoPages, /@media\(max-width:900px\)\{\.seo-nav\{[\s\S]*?\.seo-nav-links a\{display:inline-block;padding:11px 2px\}\}/);
});

// ── Pass 6b: the final live-measured stragglers (land ▸ glyph, monitor
// 27px-wide Ask link, tablet screener checkbox, lifetime AppSumo link,
// tablet seo breadcrumb, land monitor-feature card prose link) ──

test('screener checkboxes are 20px on tablets too, not just phones', () => {
    const block = css.match(/@media \(max-width: 900px\) \{\s*\.chip \{ min-height: 40px; display: inline-flex; align-items: center; \}\s*input\[type='checkbox'\] \{ width: 20px; height: 20px; flex: none; \}\s*\}/);
    assert.ok(block, 'checkbox floor present in the 900px block');
});

test('monitor free-note links clear 28px wide, not just tall', () => {
    const monHtml = read('frontend-v2', 'monitor.html');
    assert.match(monHtml, /<a style="display:inline-block; padding:8px 6px;" href="\/ask\.html">Ask<\/a>/);
    assert.match(monHtml, /<a style="display:inline-block; padding:8px 6px;" href="\/company\.html\?symbol=SPY">/);
});

test('lifetime AppSumo note link is a tap target', () => {
    assert.match(lifetimeHtml, /\.lt-note p a \{ display: inline-block; padding: 6px 3px; \}/);
});

test('seo crumbs are padded tap targets in the base rule, past 760px too', () => {
    assert.match(seoPages, /\.seo-crumbs a\{color:var\(--ink3\);display:inline-block;padding:9px 2px\}/);
});

test('landing card prose links and the 9px caret glyph clear the floors', () => {
    assert.match(indexHtml, /\.card-pad p a \{ display: inline-block; padding: 6px 4px; \}/);
    assert.ok(!indexHtml.includes('font-size:9px;'), 'no 9px inline font sizes left on the landing page');
});
