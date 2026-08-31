'use strict';

// Structural checks for the Dossier Compare surface (same convention as
// test/profile-consolidation.test.js — app.js is an ~11000-line monolith that
// isn't worth booting a real server for).
//
// The contract these pin:
//   - /api/dossier/compare is registered BEFORE /api/dossier/:symbol, or the
//     path is captured as a ticker and the route can never run.
//   - The compare route never builds: it reads with peekDossier only, and a
//     missing report returns { missing } WITHOUT spending. Builds are only
//     ever triggered by the paid single-symbol route.
//   - Credits are checked before they are spent, at the dossier_compare rate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../credits');

const root = path.join(__dirname, '..', '..');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');

function sources() {
    const compareIdx = appSource.indexOf("app.get('/api/dossier/compare'");
    const symbolIdx = appSource.indexOf("app.get('/api/dossier/:symbol'");
    return { compareIdx, symbolIdx, compare: appSource.slice(compareIdx, appSource.indexOf("app.get('/api/dossier/:symbol'")) };
}

test('the compare route exists and is registered before the :symbol route', () => {
    const { compareIdx, symbolIdx } = sources();
    assert.notEqual(compareIdx, -1, 'the compare route must exist');
    assert.notEqual(symbolIdx, -1);
    assert.ok(compareIdx < symbolIdx, 'compare must precede :symbol or the ticker param captures this path');
});

test('the compare route reads cached dossiers and NEVER triggers a build', () => {
    const { compare } = sources();
    assert.match(compare, /dossier\.peekDossier\(/, 'reads must go through the build-free peek');
    assert.doesNotMatch(compare, /buildDossier\(/, 'compare must never build — a missing report is reported back');
    assert.match(compare, /missing/, 'missing reports come back to the client as data');
});

test('compare charges only after every requested dossier is present', () => {
    const { compare } = sources();
    const missingIdx = compare.indexOf('if (missing.length)');
    const spendIdx = compare.indexOf('credits.spend(');
    assert.notEqual(missingIdx, -1, 'the missing branch must exist');
    assert.notEqual(spendIdx, -1);
    assert.ok(missingIdx < spendIdx, 'the missing-report return must precede any credit spend');
});

test('compare checks affordability before spending, at the dossier_compare rate', () => {
    const { compare } = sources();
    const check = compare.indexOf('credits.check(');
    const spend = compare.indexOf('credits.spend(');
    assert.notEqual(check, -1, 'affordability is checked first');
    assert.ok(check < spend, 'check must precede spend');
    assert.equal(credits.COST.dossier_compare, 5);
    assert.ok(credits.COST.dossier_compare < credits.COST.dossier_standard, 'comparing cached reports must visibly undercut building one');
});

test('compare accepts exactly 2 or 3 distinct symbols and validated tickers', () => {
    const { compare } = sources();
    assert.match(compare, /Compare 2 or 3 companies\./);
    assert.match(compare, /Compare up to 3 companies at a time\./);
    assert.match(compare, /\[\.\.\.new Set\(/, 'duplicate tickers collapse before the count check');
    assert.match(compare, /\^\[A-Z0-9\.\\\-\]\{1,10\}\$/);
});

test('the compare page carries FULL dossier depth, not a summary', () => {
    // Owner requirement (2026-09-01): compare is not a summary surface. It
    // shows dossiers users paid 10 credits each for, so it must render the
    // same sections Simple-mode dossier.html shows, per company, plus
    // comparison-native visuals. A regression that strips it back down to a
    // 9-row table + 4 bullet lists shipped here once — pin the depth.
    const js = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'compare-dossiers.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'frontend-v2', 'compare-dossiers.html'), 'utf8');
    // Simple-mode dossier sections, per company (field names from dossier.js):
    for (const field of ['financials', 'segments', 'unitEconomics', 'healthChecks', 'valuation', 'competitive'])
        assert.match(js, new RegExp(`d\\.${field}`), `uses the dossier's ${field} payload`);
    assert.match(js, /caseListHtml/, 'bull case renders plain-language points (shape-aware)');
    assert.match(js, /\+ 'Plain'/, 'bull/bear lists prefer the plain-language payload variants');
    assert.match(js, /recentChanges/, 'latest-filing section present');
    assert.match(js, /materialityBreakdown/, 'latest-filing carries the materiality breakdown, not one line');
    assert.match(js, /edgePlain/, 'forensic edge detail present in deep research');
    assert.match(js, /forwardDcf/, 'forward DCF present in deep research');
    assert.match(js, /governance/, 'governance present in deep research');
    // Comparison-native visuals:
    assert.match(js, /verdictScore/, 'verdict strip uses the dossier score arithmetic');
    // The verdict banner is UNIFORM (owner: "make the design uniform") —
    // same three plain-language stat rows for every company, no prose blobs:
    assert.match(js, /cmp-banner-cols/, 'verdict is a banner with uniform company columns');
    assert.match(js, /cmp-vs-label/, 'banner stat rows are shared and labelled');
    assert.match(js, /Price ÷ earnings/, 'price row uses plain words, not P/E jargon');
    assert.match(js, /\.toFixed\(1\)/, 'banner numbers render rounded, no raw floats');
    assert.match(js, /growthIndexChart/, 'shared-axis growth index chart');
    assert.match(js, /healthCompare/, 'health checks compared row per test');
    assert.match(js, /scenarioCompare/, 'scenario bands compared on one scale');
    assert.match(js, /cmp-win/, 'metric rows bold the winning value');
    // The visuals come from the shared primitives, same as the dossier page:
    assert.match(js, /window\.PV\b|window\['PV'\]|const PV = window\.PV/, 'uses PV visual helpers');
    assert.match(html, /assets\/plainviz\.js\?v=/, 'page loads plainviz.js so PV exists');
    assert.match(js, /window\.print/, 'print / save PDF stays available');
});

test('the compare page renders list items as OBJECTS, not strings', () => {
    // The payload shapes (backend/dossier.js): bull/bear items are
    // {point, basis}, risk items are {risk, trigger, impact, mitigant,
    // severity} — and the plain translation keeps those keys, so the *Plain
    // arrays the page prefers hold objects too. A renderer that does String(x)
    // shipped as '[object Object]' in every bull/bear/risk list (2026-09-01).
    const js = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'compare-dossiers.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'frontend-v2', 'compare-dossiers.html'), 'utf8');
    assert.match(js, /x\.point/, 'bull/bear items render through their point field');
    assert.match(js, /x\.basis/, 'the basis sub-line is kept');
    assert.match(js, /x\.risk/, 'risk items render through their risk field');
    assert.match(js, /typeof x === 'string'/, 'pre-schema cached dossiers held bare strings — keep handling those');
    assert.doesNotMatch(js, /`\$\{esc\(String\(x\)[^`]*\)/, 'no raw String(x) rendering — that is the [object Object] bug');
    assert.match(html, /assets\/compare-dossiers\.js\?v=/, 'the page stamps its asset so the fix actually reaches browsers');
});

test('Compare is labeled Beta everywhere the owner sees it (2026-09-01)', () => {
    const js = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'dossier.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'frontend-v2', 'compare-dossiers.html'), 'utf8');
    const dossierPage = fs.readFileSync(path.join(root, 'frontend-v2', 'dossier.html'), 'utf8');
    const matches = js.match(/>Compare ↔ <span class="beta-badge">Beta<\/span><\/a>/g) || [];
    assert.ok(matches.length >= 2, 'both dossier.js header render sites carry the Beta chip');
    assert.match(html, /<span class="beta-badge">Beta<\/span>/, 'the compare page carries the Beta chip');
    assert.doesNotMatch(dossierPage, /20260901-dosfix1/, 'dossier.html stamps the dossier.js change so it reaches browsers');
});