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
const { validate, pickDocument, businessExhibit, widestExhibit, oneSegmentMismatch, statedSegments, THIN, SYSTEM, promptFor, recordFromReply, readable } = require('../../scripts/build-segment-profiles');

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

test('a filing cached as taxonomy context rather than prose is unreadable, not segment-less', () => {
    // 40-F annual reports sometimes extract as XBRL context lists ("...Member 2025-10-31 0000947263
    // td:..."), which name no segments because they contain no sentences, not because the company
    // has none. Ordinary annual report text stays readable under the same rule.
    const context = 'us-gaap:NonTradingDerivativesMember 2025-10-31 0000947263 td:OptionsWrittenAssetsMember '
        + '2024-10-31 0000947263 td:InterestRateContractsMember 2025-10-31 Member 2024-10-31 0000947263';
    assert.equal(readable(context.repeat(20)), false);
    assert.equal(readable(TEXT), true);
});

test('a filing that states its own segment count is not a single-segment split', () => {
    const one = 'We operate and are managed as one operating segment, and derive revenue from ...';
    const split = [{}, {}, {}];
    assert.equal(oneSegmentMismatch({ segments: split }, one), true, 'three segments against a one-segment filing');
    assert.equal(oneSegmentMismatch({ segments: split.slice(0, 2) }, one), true);
    assert.equal(oneSegmentMismatch({ segments: [{}, {}] }, one + ' We test goodwill at one level below the operating segment.'), true, 'the boilerplate does not make it a split');
    const wimi = 'The Company determined that it operates as a single operating segment. The Company has determined that it has three operating segments: (1) AR advertising, (2) AR entertainment and (3) semiconductors.';
    assert.equal(oneSegmentMismatch({ segments: split }, wimi), false, 'the filing also states three segments');
    assert.deepEqual([...statedSegments(wimi)], [3]);
    assert.deepEqual([...statedSegments('We have five reportable segments.')], [5]);
});

test('a wrapper filing is read from its exhibit 13 or 99, and from no other exhibit', () => {
    // Only exhibit 13 and 99 may stand in for the report.
    for (const name of ['aem-20251231xex99d3.htm', 'mays4683021-ex13.htm', 'exhibit991-results.htm', 'ex-99.htm'])
        assert.ok(businessExhibit({ name }), name + ' is an exhibit 13/99');
    for (const name of ['cxt-ex101_20251231.htm', 'mays4683021-ex311.htm', 'mux-20251231xex96.htm', 'pool-20251231.htm', 'aem-20251231x40f.htm'])
        assert.ok(!businessExhibit({ name }), name + ' is not');
    assert.equal(widestExhibit([{ name: 'a-9.htm', size: 9 }, { name: 'mays4683021-ex13.htm', size: 800 }, { name: 'x-xex99d1.htm', size: 300 }, { name: 'mays4683021-ex311.htm', size: 900 }]).name, 'mays4683021-ex13.htm');
    // Measured 2026-11-15: a real 10-K/20-F page is at least 131,000 characters of text (median 423,000);
    // Agnico Eagle's 40-F cover is 65,757 and J.W. Mays' 10-K wrapper 50,623.
    assert.ok(THIN > 66000 && THIN < 131000);
});

test('the annual report is the filing\'s primary document, never the largest exhibit beside it', () => {
    const items = [{ name: 'R2.htm', size: 900 }, { name: 'cxt-20251231.htm', size: 5000 },
        { name: 'cxt-ex101_20251231.htm', size: 9000 }, { name: 'mux-20251231xex96.htm', size: 8000 }, { name: 'exhibit991-results.htm', size: 7000 }];
    assert.equal(pickDocument(items, 'cxt-20251231.htm').name, 'cxt-20251231.htm', 'the SEC index names it');
    assert.equal(pickDocument(items, null).name, 'cxt-20251231.htm', 'without the index, the largest non-exhibit page');
    assert.equal(pickDocument([{ name: 'only-ex10.htm', size: 1 }, { name: 'only-xex96.htm', size: 9 }], null).name, 'only-xex96.htm', 'last resort: the largest page');
});

test('the two-stage read applies the same checks: a quoted reply is written, an invented product is not (AppLovin, FY2025)', () => {
    const data = { issuerName: 'AppLovin Corporation' };
    const src = { form: '10-K', accessionNumber: FILING.accessionNumber, periodEnd: FILING.periodEnd, filingDate: FILING.filingDate };
    // The prompt is the rules, a blank line, then the company and its windows - no model call.
    const prompt = promptFor(data, src, TEXT);
    assert.ok(prompt.startsWith(SYSTEM + '\n\nCompany: AppLovin Corporation. 10-K for the period ended 2025-12-31.\n\n[BUSINESS SECTION]'));

    const reply = (products, segments) => ({ segments: segments || [{ name: 'Advertising', products, description: 'Software that helps advertisers reach mobile app users.',
        evidence: 'Our advertising solutions include AppLovin Ads, MAX, Adjust and Wurl.' }],
    productRevenueBrokenOut: false, revenueModel: null, changes: [] });
    const head = { version: profiles.VERSION, cik: APP, issuerName: data.issuerName, builtAt: '2026-01-01T00:00:00.000Z' };
    const doc = { ...FILING, text: TEXT };

    const quoted = recordFromReply(head, src, doc, reply(['AppLovin Ads', 'MAX']));
    assert.equal(quoted.status, 'ok');
    assert.equal(quoted.reader, 'agent');
    assert.equal(quoted.filing.accessionNumber, FILING.accessionNumber);
    assert.deepEqual(quoted.segments[0].products, ['AppLovin Ads', 'MAX']);
    assert.ok(quoted.segments[0].description, 'a description carried by a verbatim quote survives');

    const invented = recordFromReply(head, src, doc, reply(['AppLovin Ads', 'Unity Ads']));
    assert.equal(invented.status, 'ok');
    assert.deepEqual(invented.segments[0].products, ['AppLovin Ads'], 'a product the filing never names is dropped');
    assert.ok(invented.dropped.some(d => /Unity Ads/.test(d)));

    // The filing says one reportable segment; a reply that splits it is not shown as the segments.
    const split = recordFromReply(head, src, doc, reply([], [
        { name: 'Advertising', products: [], description: 'Ads.', evidence: 'Our advertising solutions include AppLovin Ads, MAX, Adjust and Wurl.' },
        { name: 'Apps', products: [], description: 'Games.', evidence: 'In June 2025 we completed the sale of our Apps business to Tripledot, which is presented as discontinued operations.' }]));
    assert.equal(split.status, 'one-segment-mismatch');
    assert.equal(split.reader, 'agent');
    assert.equal(split.segments.length, 2, 'the read is kept in the record for review, not shown');
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
    // A profile joined its segment to the brand it owns with a pipe; the tagged row is the segment alone.
    assert.ok(profiles.sameSegment('Luxury Mytheresa', 'Luxury | Mytheresa'));
    assert.ok(profiles.sameSegment('Off Price', 'Off-Price | YOOX'));
    // "Platform" is a filler: Kaspi's tagged row is Payments, its report calls it the Payments Platform.
    assert.ok(profiles.sameSegment('Payments', 'Payments Platform'));
    assert.ok(!profiles.sameSegment('Payments', 'Marketplace Platform'), 'a different platform is a different segment');
    assert.ok(!profiles.sameSegment('Services', 'Financial Services'));
    assert.ok(!profiles.sameSegment('Advertising', 'Apps'));
    // The annual report's spelling against the tagged member's, as filed. A third element is the
    // issuer's own name, the one thing a filing may add to a shorter name besides its filler words.
    for (const [a, b, issuer] of [['U.S. Consumer Services (USCS)', 'US Consumer Services'], ['Consumer & Community Banking ("CCB")', 'Consumer & Community Banking'],
        ['Workforce Solutions', 'Total Workforce Solutions'], ['Domestic Operations', 'Domestic'], ['Conventional Shell Eggs', 'Conventional Shell Egg'],
        ['Specialty Shell Eggs', 'Specialty shell egg sales'], ['Established Pharmaceutical Products', 'Established Pharmaceuticals'],
        ['Commercial lines insurance', 'Commercial Insurance'], ['Wealth Management', 'Wealth Manage- ment'], ['PaperPie', 'Paper Pie'],
        ['Flowserve Pumps Division', 'FPD'], ['EMEA', 'Europe Middle East Africa'], ['BD Medical', 'Medical'], ['Business', 'Business'],
        // the filing's own initialism after the name, no brackets
        ['Natural Gas Distribution NJNG', 'Natural Gas Distribution'], ['Aftermarket Products and Services APS', 'Aftermarket Products and Services'],
        ['Laboratory Products Group LPG', 'Lab Products Group'], ['Integrated Technology Solutions ITS', 'Integrated Technology Solutions ("ITS")'],
        // a shorter name plus only the filing's filler words, or plus the issuer's own name
        ["Chili's Restaurants", "Chili's"], ['Merchant', 'Merchant Solutions'], ['Financial', 'Financial Solutions'],
        ['Camping & Watercraft', 'Camping & Watercraft Recreation'], ['North American Towable', 'North American Towable Recreational Vehicles'],
        ['Construction Materials', 'Carlisle Construction Materials', 'Carlisle Companies Incorporated'],
        ['Consumer', 'Verizon Consumer Group', 'Verizon Communications Inc.'], ['Business', 'Verizon Business Group', 'Verizon Communications Inc.'],
        // short forms spelled out once, never by distance
        ['APAC', 'Asia Pacific'], ['PSE&G', 'Public Service Electric and Gas Company'], ['SPD', 'Specialty Products'],
        ['AEP Transmission Holdco', 'AEPTHCo'], ['Transmission and Distribution Utilities', 'Transmission and Distribution Companies'],
        // the corporate and business words a tagged row keeps or the note drops
        ['Utilities', 'Utilities SBU'], ['Renewables', 'Renewables SBU'], ['Commercial', 'Commercial Banking'],
        ['Consumer', 'Consumer Banking'], ['P&C Business Insurance', 'Business Insurance'], ['P&C Personal Insurance', 'Personal Insurance'],
        ['ZERUST', 'ZERUST® products and services'], ['Natur Tec', 'Natur-Tec® products']])
        assert.ok(profiles.sameSegment(a, b, issuer || null), `${a} = ${b}`);
    assert.ok(!profiles.sameSegment('Light Vehicle Drive Systems', 'Light Vehicle'), 'a longer name is not the same segment');
    assert.ok(!profiles.sameSegment('Pottery Barn', 'Pottery Barn Kids'), 'a brand and its sub-brand stay apart');
    assert.ok(!profiles.sameSegment('Services', 'Financial Services'), 'a business and a word in it stay apart');
    assert.ok(!profiles.sameSegment('Business', 'Consumer'));
    assert.ok(!profiles.sameSegment('Finance', 'Financial Solutions'), 'the filler list is closed');
    assert.ok(!profiles.sameSegment('P&C Business Insurance', 'Personal Insurance'), 'the P&C prefix does not flatten a line of business');
    assert.ok(!profiles.sameSegment('Lending', 'Originations'), 'two different words for two different segments');
    assert.ok(!profiles.sameSegment('Specialty Property & Casualty Program', 'Specialty Property & Casualty Insurance'), 'program and insurance are two names');
    assert.ok(profiles.sameSegment('CNA Financial Corporation', 'CNA Financial'));
    assert.ok(profiles.sameSegment('Light Vehicle Drive Systems (Light Vehicle)', 'Light Vehicle'));
});

test('rows that are not the reported segments are never passed off as them (ADI end markets, one segment)', () => {
    const cik = '0000000045';
    profiles.write(cik, { version: profiles.VERSION, cik, status: 'ok', filing: FILING, productRevenueBrokenOut: false, revenueModel: null, changes: [],
        segments: [{ name: 'Semiconductors', products: [], description: 'Analog and mixed-signal chips.' }] });
    const markets = [{ name: 'Industrial', value: 5, share: 50 }, { name: 'Automotive', value: 5, share: 50 }];
    const out = profiles.enrich(cik, markets, { kind: 'operating segments' });
    assert.deepEqual(out.rows, markets, 'no row gets the segment\'s words');
    assert.equal(out.profile.rowsAreSegments, false);
    assert.equal(out.profile.segments[0].shown, false);
    // One row and one reported segment are the same segment, under the filed name.
    const one = profiles.enrich(cik, [{ name: 'Chips', value: 10, share: 100 }], { kind: 'operating segments' });
    assert.equal(one.rows[0].name, 'Chips');
    assert.equal(one.rows[0].description, 'Analog and mixed-signal chips.');
    assert.equal(one.profile.rowsAreSegments, true);
    // Rows that share nothing with the report's names are a different cut: Norfolk Southern's
    // traffic lines, Williams-Sonoma's brands.
    profiles.write('0000000046', { version: profiles.VERSION, cik: '0000000046', status: 'ok', filing: FILING, productRevenueBrokenOut: false, revenueModel: null, changes: [],
        segments: [{ name: 'Railway operations', products: [], description: 'Rail freight.' }] });
    assert.equal(profiles.enrich('0000000046', [{ name: 'Merchandise' }, { name: 'Intermodal' }, { name: 'Coal' }], { kind: 'operating segments' }).profile.rowsAreSegments, false);
    profiles.write('0000000047', { version: profiles.VERSION, cik: '0000000047', status: 'ok', filing: FILING, productRevenueBrokenOut: false, revenueModel: null, changes: [],
        segments: [{ name: 'Home retail', products: [], description: 'Home furnishings.' }] });
    assert.equal(profiles.enrich('0000000047', [{ name: 'Pottery Barn' }, { name: 'West Elm' }, { name: 'Other' }], { kind: 'operating segments' }).profile.rowsAreSegments, false);
});

test('a near-miss spelling keeps its rows as segments; only a different cut is named as tagged', () => {
    // A row that shares a word with the report's segment name is that segment under a spelling the
    // matcher has not learned yet, so the card must not move it to the "as tagged in the filing" cut.
    profiles.write('0000000048', { version: profiles.VERSION, cik: '0000000048', status: 'ok', filing: FILING, productRevenueBrokenOut: false, revenueModel: null, changes: [],
        segments: [{ name: 'Industrial Gases', products: ['Nitrogen'], description: 'Industrial gases.' }] });
    const near = profiles.enrich('0000000048', [{ name: 'Industrial', value: 6, share: 60 }, { name: 'Medical', value: 4, share: 40 }], { kind: 'operating segments' });
    assert.equal(near.rows.filter(r => 'products' in r).length, 0, 'nothing is named that the report does not name');
    assert.equal(near.profile.rowsAreSegments, true, 'but the rows are not a different cut');
    // The issuer's own name is what lets "Consumer" be Verizon Consumer Group, and only then.
    profiles.write('0000000049', { version: profiles.VERSION, cik: '0000000049', status: 'ok', issuerName: 'Verizon Communications Inc.', filing: FILING, productRevenueBrokenOut: false, revenueModel: null, changes: [],
        segments: [{ name: 'Verizon Consumer Group', products: [], description: 'Wireless and wireline consumer.' }, { name: 'Verizon Business Group', products: [], description: 'Enterprise.' }] });
    const vz = profiles.enrich('0000000049', [{ name: 'Consumer', value: 7, share: 70 }, { name: 'Business', value: 3, share: 30 }], { kind: 'operating segments' });
    assert.deepEqual(vz.rows.map(r => r.description), ['Wireless and wireline consumer.', 'Enterprise.']);
    assert.equal(vz.profile.rowsAreSegments, true);
    const other = profiles.enrich('0000000049', [{ name: 'Medical', value: 1, share: 100 }, { name: 'Industrial', value: 1, share: 100 }], { kind: 'operating segments' });
    assert.equal(other.profile.rowsAreSegments, false, 'another company\'s words are not Verizon\'s');
});

test('a row matched through the company\'s own name keeps its words on the page (Verizon)', () => {
    const cik = require('../stock-universe').lookup('VZ')?.cik;
    assert.ok(cik, 'VZ is in the stock universe');
    profiles.write(cik, { version: profiles.VERSION, cik, status: 'ok', filing: FILING, productRevenueBrokenOut: false, revenueModel: null, changes: [],
        segments: [{ name: 'Verizon Consumer Group', products: ['Fios'], description: 'Wireless and home internet for consumers.' },
            { name: 'Verizon Business Group', products: [], description: 'Network services for businesses.' }] });
    const c = { symbol: 'VZ', grade: 'complete', kind: 'operating segments', currency: 'USD', totalRevenue: 100, remainder: null,
        rows: [{ name: 'Consumer', value: 80, share: 80 }, { name: 'Business', value: 20, share: 20 }] };
    const { profile } = profiles.enrich(cik, c.rows, { kind: c.kind, issuer: 'Verizon Communications Inc.' });
    const page = breakdown.forPage({ ...c, profile });
    assert.deepEqual(page.items.map(i => i.description), ['Wireless and home internet for consumers.', 'Network services for businesses.']);
    assert.deepEqual(page.items[0].products, ['Fios']);
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
