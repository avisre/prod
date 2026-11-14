'use strict';
// What each company sells, in its annual report's words (backend/segment-profiles.js, built by
// scripts/build-segment-profiles.js): the builder keeps only what the filing text says, and the page
// puts those words beside the filing's tagged figures without changing a figure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-profiles-'));
process.env.SEGMENT_PROFILES_DIR = DIR;
const profiles = require('../segment-profiles');
const breakdown = require('../revenue-breakdown');
const { validate } = require('../../scripts/build-segment-profiles');

const APP = '0001751008';
const FILING = { form: '10-K', accessionNumber: '0001751008-26-000010', periodEnd: '2025-12-31', filingDate: '2026-02-19',
    url: 'https://www.sec.gov/Archives/edgar/data/1751008/000175100826000010/app-20251231.htm' };
const TEXT = 'We have one reportable segment, Advertising. Our advertising solutions include AppLovin Ads, MAX, Adjust and Wurl. '
    + 'We generate revenue primarily from advertisers that pay us to place their ads in third-party mobile apps. '
    + 'In June 2025 we completed the sale of our Apps business to Tripledot, which is presented as discontinued operations.';

test('only what the filing text says survives the check', () => {
    const v = validate({
        segments: [
            { name: 'Advertising', products: ['AppLovin Ads', 'MAX', 'Adjust', 'Wurl', 'Unity Ads'], description: 'Software that helps advertisers reach mobile app users.',
                evidence: 'Our advertising solutions include AppLovin Ads, MAX, Adjust and Wurl.' },
            { name: 'Gaming', products: [], description: 'Mobile games.', evidence: 'We make games.' }
        ],
        productRevenueBrokenOut: false,
        revenueModel: { text: 'Advertisers pay it to place ads in third-party mobile apps.', evidence: 'We generate revenue primarily from advertisers that pay us to place their ads in third-party mobile apps.' },
        changes: [
            { text: 'Sold its Apps business to Tripledot in 2025; it is now discontinued operations.', evidence: 'In June 2025 we completed the sale of our Apps business to Tripledot, which is presented as discontinued operations.' },
            { text: 'Revenue grew 70% after the sale.', evidence: 'In June 2025 we completed the sale of our Apps business to Tripledot, which is presented as discontinued operations.' }
        ]
    }, TEXT);
    assert.deepEqual(v.segments.map(s => s.name), ['Advertising'], 'a segment the filing never names is dropped');
    assert.deepEqual(v.segments[0].products, ['AppLovin Ads', 'MAX', 'Adjust', 'Wurl'], 'a product the filing never names is dropped');
    assert.ok(v.segments[0].description);
    assert.equal(v.productRevenueBrokenOut, false);
    assert.ok(v.revenueModel);
    assert.equal(v.changes.length, 1, 'a change carrying a figure other than a year is dropped');
    assert.ok(v.dropped.some(d => /Unity Ads/.test(d)) && v.dropped.some(d => /Gaming/.test(d)));
    // A paraphrased quote cannot carry a description or a revenue model.
    const loose = validate({ segments: [{ name: 'Advertising', products: [], description: 'Ads.', evidence: 'We sell advertising to app developers worldwide.' }],
        revenueModel: { text: 'Advertisers pay.', evidence: 'Advertisers pay us for advertising.' }, changes: [] }, TEXT);
    assert.equal(loose.segments[0].description, null);
    assert.equal(loose.revenueModel, null);
});

test('a one-segment company is shown under the name its annual report gives it, with its products (AppLovin, FY2025)', () => {
    profiles.write(APP, { version: profiles.VERSION, cik: APP, status: 'ok', filing: FILING, productRevenueBrokenOut: false,
        segments: [{ name: 'Advertising', products: ['AppLovin Ads', 'MAX', 'Adjust', 'Wurl'], description: 'Software that helps advertisers reach mobile app users.', evidence: 'x' }],
        revenueModel: { text: 'Advertisers pay it to place ads in third-party mobile apps.', evidence: 'x' },
        changes: [{ text: 'Sold its Apps business to Tripledot in 2025; it is now discontinued operations.', evidence: 'x' }] });
    const BUSINESS = 'us-gaap:StatementBusinessSegmentsAxis', REGION = 'srt:StatementGeographicalAxis';
    const filed = (member, name, value) => ({ member, label: null, filedLabel: name, value });
    const segment = { axis: BUSINESS, periodEnd: '2025-12-31', totalRevenue: 5480717000, currency: 'USD', sourceVersion: FILING.accessionNumber, publicationDate: '2026-02-19', sourceUrl: FILING.url,
        entries: [filed('app:ReportableSegmentMember', 'Reportable Segment', 5480717000)] };
    const places = { ...segment, axis: REGION, entries: [filed('country:US', 'United States', 2827248000), filed('us-gaap:NonUsMember', 'All other countries', 2653469000)] };

    const c = breakdown.fromGroups([segment, places], 'APP', { cik: APP });
    assert.deepEqual(c.rows, [{ name: 'Advertising', value: 5480717000, share: 100 }], 'the figure is the filing\'s; only the name comes from the report');
    assert.deepEqual(breakdown.violations(c), []);
    assert.equal(breakdown.fromGroups([segment, places], 'APP').rows[0].name, 'Single reportable segment', 'no profile, no name invented');

    const { profile } = profiles.enrich(APP, c.rows, { kind: c.kind });
    const page = breakdown.forPage({ ...c, profile });
    assert.deepEqual(page.items[0].products, ['AppLovin Ads', 'MAX', 'Adjust', 'Wurl']);
    assert.equal(page.profile.productRevenueBrokenOut, false);
    assert.match(page.profile.revenueModel, /advertisers|Advertisers/);
    assert.equal(page.profile.changes.length, 1);
    assert.equal(page.profile.filing.url, FILING.url);
});

test('rows keep their filed names and figures; the profile only adds words to the ones it names', () => {
    const cik = '0000000042';
    profiles.write(cik, { version: profiles.VERSION, cik, status: 'ok', filing: FILING, productRevenueBrokenOut: true, revenueModel: null, changes: [],
        segments: [{ name: 'Pottery Barn', products: ['Pottery Barn Kids'], description: 'Home furnishings.' }, { name: 'West Elm', products: [], description: null }] });
    const rows = [{ name: 'Pottery Barn segment', value: 400, share: 40 }, { name: 'Williams Sonoma', value: 600, share: 60 }];
    const out = profiles.enrich(cik, rows, { kind: 'operating segments' });
    assert.deepEqual(out.rows[0], { name: 'Pottery Barn segment', value: 400, share: 40, products: ['Pottery Barn Kids'], description: 'Home furnishings.' });
    assert.deepEqual(out.rows[1], rows[1], 'a row the profile does not name is untouched');
    assert.deepEqual(out.profile.segments.map(s => s.shown), [true, false], 'a reported segment with no figure is still listed');
    // A generic row is not renamed when the report names several segments: which one it is cannot be told.
    assert.equal(profiles.enrich(cik, [{ name: 'Single reportable segment', value: 1, share: 100 }]).rows[0].name, 'Single reportable segment');
    // No profile, or one the check left empty, changes nothing.
    assert.deepEqual(profiles.enrich('0000000043', rows), { rows, profile: null });
    profiles.write('0000000044', { version: profiles.VERSION, cik: '0000000044', status: 'no-segments', segments: [] });
    assert.equal(profiles.enrich('0000000044', rows).profile, null);
});

test('segment names match across the filing\'s spellings, never on a fragment', () => {
    assert.ok(profiles.sameSegment('Primary', 'Primary Segment'));
    assert.ok(profiles.sameSegment('Health Care & Benefits', 'Health Care and Benefits segment'));
    assert.ok(profiles.sameSegment('AWS', 'AWS segment'));
    assert.ok(!profiles.sameSegment('Pottery Barn', 'Pottery Barn Kids'), 'two brands, not one');
    assert.ok(!profiles.sameSegment('Services', 'Financial Services'));
    assert.ok(!profiles.sameSegment('Advertising', 'Apps'));
});

test('one segment under two members over the years is one row once named (AppLovin history)', () => {
    const rows = profiles.enrich(APP, [
        { name: 'Single reportable segment', sales: [null, 1841, 3224], profit: [null, null, null], assets: [null, null, null] },
        { name: 'Advertising', sales: [1049, null, null], profit: [null, null, null], assets: [null, null, null] },
        { name: 'Apps', sales: [1768, null, null], profit: [null, null, null], assets: [null, null, null] }]).rows;
    const merged = profiles.mergeNamed(rows);
    assert.deepEqual(merged.map(r => r.name), ['Advertising', 'Apps']);
    assert.deepEqual(merged[0].sales, [1049, 1841, 3224]);
    assert.deepEqual(merged[0].products, ['AppLovin Ads', 'MAX', 'Adjust', 'Wurl']);
    // Two rows of one name filed for the same year are not one segment.
    assert.equal(profiles.mergeNamed([{ name: 'A', sales: [1, 2] }, { name: 'A', sales: [3, null] }]).length, 2);
});
