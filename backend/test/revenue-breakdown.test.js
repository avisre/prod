'use strict';
// One contract decides what a company sells for every surface. These tests pin
// the contract's rules, the behaviour for well-known companies, and that the
// page renders the contract rather than recomputing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const breakdown = require('../revenue-breakdown');

const BUSINESS = 'us-gaap:StatementBusinessSegmentsAxis', PRODUCT = 'srt:ProductOrServiceAxis';
const group = (axis, periodEnd, parts, totalRevenue = 1000) => ({ axis, periodEnd, totalRevenue, currency: 'USD', sourceVersion: '0000000001-26-000001', publicationDate: '2026-02-01', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/x.htm',
    entries: Object.entries(parts).map(([member, value]) => ({ member: 'x:' + member + 'Member', label: null, value })) });
const DATASET = path.join(require('../sec-coverage').DATA_DIR, 'sec-financials');

test('a complete breakdown carries plain names, shares of its own year and no remainder', () => {
    const c = breakdown.fromGroups([group(BUSINESS, '2025-12-31', { FamilyOfApps: 989, RealityLabs: 11 })], 'T');
    assert.equal(c.grade, 'complete');
    assert.deepEqual(c.rows, [{ name: 'Family of Apps', value: 989, share: 98.9 }, { name: 'Reality Labs', value: 11, share: 1.1 }]);
    assert.equal(c.remainder, null);
    assert.equal(c.fiscalYear, 'FY2025');
    assert.deepEqual(breakdown.violations(c), []);
});

test('a partial table always names what it leaves out', () => {
    const c = breakdown.fromGroups([group(PRODUCT, '2024-12-31', { Retail: 400, Railroad: 250, Energy: 160 })], 'T');
    assert.equal(c.grade, 'partial');
    assert.equal(c.remainder.value, 190);
    assert.equal(c.remainder.share, 19);
    assert.match(c.note, /cover 81% of revenue/);
    assert.deepEqual(breakdown.violations(c), []);
    assert.ok(breakdown.violations({ ...c, remainder: null }).length, 'dropping the remainder is a violation');
});

test('nothing is shown without saying why', () => {
    const single = breakdown.fromGroups([group(BUSINESS, '2025-12-31', { Reportable: 1000 })], 'T');
    assert.equal(single.grade, 'none');
    assert.equal(single.reason, breakdown.REASONS.single);
    assert.deepEqual(single.rows, []);
    const sliver = breakdown.fromGroups([group(PRODUCT, '2025-12-31', { A: 50, B: 30 })], 'T');
    assert.equal(sliver.reason, breakdown.REASONS.untagged);
    assert.equal(breakdown.fromGroups([], 'T').reason, breakdown.REASONS.unread, 'no data is not the same claim as an untagged filing');
    assert.ok(breakdown.violations({ ...single, reason: null }).length);
});

test('revenue sources lead geography; a tag-like or duplicate name is a violation', () => {
    const c = breakdown.fromGroups([group(BUSINESS, '2025-12-31', { NorthAmerica: 600, International: 220, Europe: 180 }),
        group(PRODUCT, '2025-12-31', { OnlineStores: 380, SellerServices: 240, WebServices: 180, Advertising: 200 })], 'T');
    assert.equal(c.kind, 'product and service lines');
    assert.deepEqual(c.rows.map(r => r.name), ['Online Stores', 'Seller Services', 'Advertising', 'Web Services']);
    assert.ok(breakdown.violations({ ...c, rows: [{ ...c.rows[0], name: 'x:OnlineStoresMember' }, ...c.rows.slice(1)] }).length);
    assert.ok(breakdown.violations({ ...c, rows: [c.rows[0], { ...c.rows[1], name: c.rows[0].name }, ...c.rows.slice(2)] }).length);
});

test('a text-extracted breakdown is graded by the same rule', () => {
    const payload = { fiscalYear: 'FY2025', segments: [{ name: 'Cloud', revenueUsd: 600 }, { name: 'Devices', revenueUsd: 395 }] };
    assert.equal(breakdown.fromText(payload, 'T', 1000).grade, 'complete');
    const part = breakdown.fromText({ segments: [{ name: 'Cloud', revenueUsd: 500 }, { name: 'Devices', revenueUsd: 200 }] }, 'T', 1000);
    assert.equal(part.grade, 'partial');
    assert.equal(part.remainder.share, 30);
    assert.equal(breakdown.fromText({ segments: [] }, 'T', 1000).grade, 'none');
    assert.equal(breakdown.fromText({ segments: [{ name: 'Only', revenueUsd: 1000 }] }, 'T', 1000).grade, 'none');
});

test('the page shape carries the contract and loses nothing', () => {
    const c = breakdown.fromGroups([group(PRODUCT, '2024-12-31', { Retail: 400, Railroad: 250, Energy: 160 })], 'T'), page = breakdown.forPage(c);
    assert.equal(page.grade, 'partial');
    assert.equal(page.breakdown, 'product and service lines');
    assert.equal(page.totalRevenue, 1000);
    assert.deepEqual(page.items.map(i => [i.name, i.revenueUsd, i.revenuePct]), [['Retail', 400, 40], ['Railroad', 250, 25], ['Energy', 160, 16]]);
    assert.equal(page.remainder.share, 19);
});

// The shipped renderer, lifted out of the page bundle and run against stubs.
function pageFunction(name, nextMarker) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dossier.js'), 'utf8');
    const start = src.indexOf(`  function ${name}(`), end = src.indexOf(nextMarker, start);
    assert.ok(start > 0 && end > start, `${name} source markers moved — update this test`);
    const ctx = { esc: v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), bn: v => '$' + v };
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end) + `\n;globalThis.__fn = ${name};`, ctx);
    return ctx.__fn;
}

test('the page renders the contract as given, in the year it belongs to', () => {
    const table = pageFunction('breakdownTable', '  // Commitments outside the balance sheet.');
    const page = breakdown.forPage(breakdown.fromGroups([group(PRODUCT, '2024-12-31', { Retail: 400, Railroad: 250, Energy: 160 })], 'T'));
    const html = table(page, { revenue: 5000, periodEnd: '2025-12-31' });
    assert.match(html, /Revenue source · FY2024/, 'an earlier-year table is headed with its year');
    assert.match(html, />40\.0%</, 'the share is of the table’s own year, not of this year’s revenue');
    assert.match(html, /Not broken out in the filing[\s\S]*19\.0%/);
    assert.doesNotMatch(html, /8\.0%/, 'never 400 over this year’s 5000');
    assert.match(table({ grade: 'none', reason: 'Single business.', items: [] }, { revenue: 1 }), /Single business\./);
    assert.equal(table(null, { revenue: 1 }), '');
});

test('both page views render the same sections', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dossier.js'), 'utf8');
    const body = name => { const start = src.indexOf(`  function ${name}(`); return src.slice(start, src.indexOf('\n  function ', start + 10)); };
    for (const shared of ['offBalanceHtml(', 'sankey(']) for (const view of ['renderAnalyst', 'renderNormal'])
        assert.ok(body(view).includes(shared), `${view} does not render ${shared}`);
});

test('well-known companies keep the breakdown a reader expects', { skip: !fs.existsSync(DATASET) }, () => {
    const audit = require('../../scripts/audit-segment-display');
    const expected = JSON.parse(fs.readFileSync(audit.GOLDEN, 'utf8'));
    assert.deepEqual(audit.golden(), expected, 'a company’s shown breakdown changed — if intended, run: node scripts/audit-segment-display.js --golden');
    assert.deepEqual(expected.AMZN.rows.slice(0, 3), ['Online stores', 'Third-party seller services', 'Amazon Web Services'], 'names as Amazon prints them');
    assert.deepEqual(expected.GOOGL.rows, ['Google Services', 'Google Cloud', 'Other Bets']);
    assert.deepEqual(expected.META.rows, ['Family of Apps', 'Reality Labs']);
    assert.equal(expected.AAPL.rows[0], 'iPhone');
});

test('every issuer in the dataset passes the contract', { skip: !fs.existsSync(DATASET) }, () => {
    const result = require('../../scripts/audit-segment-display').audit();
    assert.deepEqual(result.failures.slice(0, 10), []);
    assert.ok(result.complete > 2000);
});

test('a stand-in measure is named in the note, and a company with no revenue says so', () => {
    const g = { ...group(BUSINESS, '2025-12-31', { Benefits: 364, Wealth: 172, Investment: 121 }), measure: 'premium revenue' };
    const c = breakdown.fromGroups([g], 'T');
    assert.equal(c.grade, 'partial');
    assert.equal(c.measure, 'premium revenue');
    assert.match(c.note, /^Shown by premium revenue, the figure this company reports by segment; it comes to 66% of total revenue\.$/);
    assert.equal(breakdown.forPage(c).measure, 'premium revenue');
    assert.equal(breakdown.fromGroups([], 'T', { read: true, revenue: 0 }).reason, breakdown.REASONS.noRevenue);
    assert.equal(breakdown.fromGroups([], 'T', { read: true, revenue: 5 }).reason, breakdown.REASONS.untagged);
    assert.equal(breakdown.fromGroups([], 'T', { read: true, revenue: 'missing' }).reason, breakdown.REASONS.revenueMissing, 'a figure we do not hold is never reported as zero revenue');
    const regions = breakdown.fromGroups([group('srt:StatementGeographicalAxis', '2025-12-31', { UnitedStates: 790, International: 210 })], 'T');
    assert.equal(regions.kind, 'regions');
});

test('operating expenses split into filed components that add back to the total', () => {
    const parts = pageFunction('opexParts', '  function sankey(');
    const height = v => v / 10; // 10 units of value per pixel
    assert.deepEqual(JSON.parse(JSON.stringify(parts({ researchAndDevelopment: 574, sellingGeneralAndAdministrative: null }, 815, height))),
        [{ label: 'Research & development', v: 574 }, { label: 'Other operating costs', v: 241 }]);
    const both = parts({ researchAndDevelopment: 300, sellingGeneralAndAdministrative: 500 }, 800, height);
    assert.deepEqual(Array.from(both, p => p.label), ['Selling, general & admin', 'Research & development']);
    assert.equal(both.reduce((n, p) => n + p.v, 0), 800);
    assert.equal(parts({}, 800, height), null, 'nothing filed, nothing split');
    assert.equal(parts({ researchAndDevelopment: 900 }, 800, height), null, 'a component larger than the total is not drawn');
    assert.equal(parts({ researchAndDevelopment: 790 }, 800, height), null, 'one part and a sliver is still one band');
    const thin = parts({ researchAndDevelopment: 400, sellingGeneralAndAdministrative: 300 }, 800, height);
    assert.equal(thin.length, 2, 'the remainder (10px) is too thin for its own label');
    assert.equal(thin.reduce((n, p) => n + p.v, 0), 800, 'a remainder too thin to label is folded in, not dropped');
});

test('the filer’s own expense lines are drawn, choosing the set that adds up to the filed total', () => {
    const parts = pageFunction('opexParts', '  function sankey(');
    const height = v => v / 2;
    const amazon = { opexLines: [{ label: 'Fulfillment', value: 1091 }, { label: 'Technology and infrastructure', value: 1085 }, { label: 'Sales and marketing', value: 471 }, { label: 'General and administrative', value: 112 }] };
    const drawn = parts(amazon, 2805, height);
    assert.deepEqual(Array.from(drawn, p => p.label), ['Fulfillment', 'Technology and infrastructure', 'Sales and marketing', 'General and administrative', 'Other operating costs']);
    assert.equal(drawn.reduce((n, p) => n + p.v, 0), 2805, 'the parts always add back to the filed total');
    // A combined line beside its own halves is never counted twice.
    const overlap = { opexLines: [{ label: 'Selling, general and administrative', value: 500 }, { label: 'Sales and marketing', value: 300 }, { label: 'General and administrative', value: 200 }, { label: 'Research and development', value: 400 }] };
    assert.deepEqual(Array.from(parts(overlap, 900, height), p => p.label).sort(), ['General and administrative', 'Research and development', 'Sales and marketing']);
    assert.equal(parts({ opexLines: [{ label: 'Research and development', value: 2000 }] }, 900, height), null, 'a line larger than the total is not drawn');
});

test('segments filed before eliminations take their shares from the segment total and say so', () => {
    const c = breakdown.fromGroups([group(BUSINESS, '2025-12-31', { HealthServices: 480, Benefits: 360, Pharmacy: 340 })], 'T');
    assert.equal(c.grade, 'complete');
    assert.equal(c.basis, 'before eliminations');
    assert.deepEqual(c.rows.map(r => r.share), [40.7, 30.5, 28.8]);
    assert.match(c.note, /before sales between them are eliminated/);
    assert.equal(c.remainder, null);
    assert.equal(breakdown.forPage(c).totalRevenue, 1180, 'the page measures rows against the same base');
    assert.deepEqual(breakdown.violations(c), []);
});
