'use strict';
// The company page shows a segment breakdown only when a reader can use it:
// plain names, at least two rows, and rows that account for revenue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../sec-segment-observations');

const BUSINESS = 'us-gaap:StatementBusinessSegmentsAxis', PRODUCT = 'srt:ProductOrServiceAxis';
const group = (axis, periodEnd, values, totalRevenue = 100) => ({ axis, periodEnd, totalRevenue, entries: values.map((value, i) => ({ member: `x:Part${i}Member`, value })) });

test('a breakdown covering a sliver of revenue is not usable', () => {
    assert.equal(store.preferred([group(PRODUCT, '2025-12-31', [5, 3])]).usable, null);
    assert.equal(store.preferred([group(BUSINESS, '2025-12-31', [100])]).usable, null, 'one row says nothing');
    assert.equal(store.preferred([]).usable, null);
});

test('a partial table is offered only when nothing usable exists', () => {
    const part = group(PRODUCT, '2024-12-31', [40, 25, 15]);
    assert.equal(store.preferred([part]).usable, null);
    assert.equal(store.preferred([part]).partial, part);
    assert.equal(store.preferred([part, group(BUSINESS, '2024-12-31', [60, 40])]).partial, null);
    assert.equal(store.preferred([group(PRODUCT, '2025-12-31', [5, 3, 1])]).partial, null, 'a sliver is still withheld');
});

test('product lines lead when they say more than the operating segments of the same year', () => {
    const geography = group(BUSINESS, '2025-12-31', [60, 22, 18]), sources = group(PRODUCT, '2025-12-31', [38, 24, 18, 10, 7, 3]);
    assert.equal(store.preferred([geography, sources]).usable, sources, 'what is sold beats where it is sold');
    assert.equal(store.kind(sources), 'product and service lines');
    const two = group(PRODUCT, '2025-12-31', [70, 30]);
    assert.equal(store.preferred([group(BUSINESS, '2025-12-31', [58, 42]), two]).usable.axis, BUSINESS, 'a bare products/services split does not');
    const older = group(PRODUCT, '2024-12-31', [40, 30, 20, 10]);
    assert.equal(store.preferred([geography, older]).usable, geography, 'lines from another year never displace this year');
});

test('product lines are used when the segment axis holds a single member', () => {
    const lone = group(BUSINESS, '2025-12-31', [100]), lines = group(PRODUCT, '2025-12-31', [70, 30]);
    assert.equal(store.preferred([lone, lines]).usable, lines);
});

test('an older usable period is preferred to a newer unusable one', () => {
    const thin = group(PRODUCT, '2025-12-31', [8, 4]), older = group(BUSINESS, '2024-12-31', [55, 45]);
    assert.equal(store.preferred([thin, older]).usable, older);
});

test('filed subtotals are pruned before coverage is judged, and eliminations are tolerated', () => {
    const withSubtotal = group(PRODUCT, '2025-12-31', [70, 30, 40, 30]);
    const view = store.shown(withSubtotal);
    assert.ok(view.usable && view.coverage <= 1.02, 'a product table with its own subtotal still reads as 100%');
    assert.ok(store.shown(group(BUSINESS, '2025-12-31', [60, 45])).usable, 'segments before eliminations may exceed revenue slightly');
    assert.ok(!store.shown(group(BUSINESS, '2025-12-31', [90, 80])).usable);
    assert.ok(store.shown(group(BUSINESS, '2025-12-31', [70, 32, -2])).usable, 'a signed elimination is not a slice of revenue');
});

// The extractor: what is kept from a filing's tagged segment facts.
const DATA = { cik: '0000000001', fetchedAt: '2026-02-02T00:00:00Z', sources: { rev: { accessionNumber: '0000000001-26-000001', form: '10-K' } },
    income: { annualReports: [{ fiscalDateEnding: '2025-12-31', periodStart: '2025-01-01', periodType: 'annual', reportedCurrency: 'USD', totalRevenue: 1000,
        _sources: { totalRevenue: ['rev'] }, _derivations: {}, _scopes: { totalRevenue: 'consolidated' } }] } };
const FILING = { url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/x.htm' };
const fact = (concept, member, val, { axis = BUSINESS, operating = false } = {}) => ({ concept, taxonomy: 'us-gaap', unit: 'USD', val, start: '2025-01-01', end: '2025-12-31',
    accn: '0000000001-26-000001', form: '10-K', filed: '2026-02-01',
    _original: { documentUrl: FILING.url, contextRef: 'c-' + concept + member + operating, decimals: '-6', dimensions: [{ axis, member: 'x:' + member + 'Member' }],
        allDimensions: operating ? [{ axis, member: 'x:' + member + 'Member' }, { axis: 'srt:ConsolidationItemsAxis', member: 'us-gaap:OperatingSegmentsMember' }] : [{ axis, member: 'x:' + member + 'Member' }],
        numericReceipt: { rawText: String(val), scale: 0 } } });

test('a member tagged under two revenue concepts no longer discards the breakdown', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const groups = store.extract([
            fact('Revenues', 'Media', 740), fact('Revenues', 'Experience', 250), fact('Revenues', 'Publishing', 10),
            fact('RevenueFromContractWithCustomerExcludingAssessedTax', 'Media', 700), fact('RevenueFromContractWithCustomerExcludingAssessedTax', 'Experience', 240),
            fact('CostOfRevenue', 'Media', 90), fact('CostOfRevenue', 'Experience', 60)
        ], DATA, FILING);
        assert.equal(groups.length, 1, 'one table per axis and year: the one that accounts for revenue');
        assert.deepEqual(groups[0].entries.map(e => [e.member, e.value]), [['x:MediaMember', 740], ['x:ExperienceMember', 250], ['x:PublishingMember', 10]]);
        assert.equal(groups[0].reconciliationStatus, 'reconciled');
        assert.ok(groups[0].entries.every(e => e.sourceFact.concept === 'Revenues'), 'cost of revenue is never a revenue row');
    } finally { p.verifiedField = original; }
});

test('segment revenue before and after eliminations is read as two views, and the reconciling one kept', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const groups = store.extract([
            fact('Revenues', 'North', 640, { operating: true }), fact('Revenues', 'South', 420, { operating: true }),
            fact('Revenues', 'North', 600), fact('Revenues', 'South', 400)
        ], DATA, FILING);
        assert.equal(groups.length, 1);
        assert.deepEqual(groups[0].entries.map(e => e.value), [600, 400]);
    } finally { p.verifiedField = original; }
});

test('a company’s own printed label is read from the filing’s label file', () => {
    const { parseLabels } = require('../sec-original');
    const xml = `<link:labelLink>
      <link:loc xlink:type="locator" xlink:href="x-20251231.xsd#x_DdsMember" xlink:label="loc_x_DdsMember"/>
      <link:labelArc xlink:arcrole="http://www.xbrl.org/2003/arcrole/concept-label" xlink:from="loc_x_DdsMember" xlink:to="lab_x_DdsMember" xlink:type="arc"/>
      <link:label xlink:label="lab_x_DdsMember" xlink:role="http://www.xbrl.org/2003/role/label" xlink:type="resource" xml:lang="en-US">Digital Data Solutions [Member]</link:label>
      <link:label xlink:label="lab_x_DdsMember" xlink:role="http://www.xbrl.org/2003/role/documentation" xlink:type="resource" xml:lang="en-US">A long description of the segment.</link:label>
      <link:loc xlink:type="locator" xlink:href="https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd#us-gaap_ServiceMember" xlink:label="loc_us-gaap_ServiceMember"/>
      <link:labelArc xlink:from="loc_us-gaap_ServiceMember" xlink:to="lab_us-gaap_ServiceMember" xlink:type="arc"/>
      <link:label xlink:label="lab_us-gaap_ServiceMember" xlink:role="http://www.xbrl.org/2003/role/label" xml:lang="en-US">Service [Member]</link:label>
      <link:label xlink:label="lab_us-gaap_ServiceMember" xlink:role="http://www.xbrl.org/2003/role/terseLabel" xml:lang="en-US">Services &amp; Support</link:label>
    </link:labelLink>`;
    const labels = parseLabels(xml);
    assert.equal(labels.get('x:DdsMember'), 'Digital Data Solutions', 'the [Member] suffix is not part of the name, and documentation is not a label');
    assert.equal(labels.get('us-gaap:ServiceMember'), 'Services & Support', 'the terse label is what the filing prints');
});

test('the printed label names a row unless it does not read as a name', () => {
    const name = (member, filedLabel, label = null) => store.displayName({ member, filedLabel, label });
    assert.equal(name('aapl:WearablesHomeandAccessoriesMember', 'Wearables, Home and Accessories'), 'Wearables, Home and Accessories');
    assert.equal(name('goog:AllOtherSegmentsMember', 'Other Bets'), 'Other Bets');
    assert.equal(name('cme:MarketDataMember', 'MarketData'), 'Market Data', 'a label that only repeats the tag is split like the tag');
    assert.equal(name('aapl:IPhoneMember', 'iPhone'), 'iPhone');
    assert.equal(name('msft:LinkedInCorporationMember', 'LinkedIn'), 'LinkedIn', 'a one-word brand is kept as printed');
    assert.equal(name('brka:McLaneMember', 'McLane'), 'McLane');
    assert.equal(name('intc:ClientComputingGroupMember', 'CCG'), 'Client Computing Group', 'an abbreviation yields to the spelled-out name');
    assert.equal(name('qcom:QctMember', 'QCT'), 'QCT', 'unless the tag is the same abbreviation');
    assert.equal(name('pep:EuropeMiddleEastAfricaMember', 'Europe, Middle East & Africa (Segment)'), 'Europe, Middle East & Africa');
    assert.equal(name('mrk:PharmaceuticalSegmentMember', 'Pharmaceutical segment'), 'Pharmaceutical');
    assert.equal(name('x:FamilyOfAppsMember', 'x:FamilyOfAppsMember'), 'Family of Apps', 'a label that is only the tag falls back');
    assert.equal(name('x:FamilyOfAppsMember', 'Revenue from the family of applications segment including all advertising sold on them'), 'Family of Apps', 'a sentence is not a name');
    assert.equal(name('avgo:SemiconductorSolutionsMember', 'Semis', 'Semiconductor Solutions'), 'Semiconductor Solutions', 'a reviewed override still wins');
});

test('a bank’s segments are its net interest income and noninterest income added, each part kept with its receipt', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const groups = store.extract([
            fact('InterestIncomeExpenseNet', 'Banking', 600), fact('NoninterestIncome', 'Banking', 150),
            fact('InterestIncomeExpenseNet', 'Mortgage', 100), fact('NoninterestIncome', 'Mortgage', 150)
        ], DATA, FILING);
        assert.equal(groups.length, 1);
        const [g] = groups;
        assert.equal(g.measure, 'net interest income plus noninterest income');
        assert.deepEqual(g.entries.map(e => [e.member, e.value]), [['x:BankingMember', 750], ['x:MortgageMember', 250]]);
        assert.deepEqual(g.entries[0].components.map(c => [c.concept, c.value]), [['InterestIncomeExpenseNet', 600], ['NoninterestIncome', 150]]);
        assert.equal(g.reconciliationStatus, 'reconciled');
        assert.equal(g.entries[0].sourceIds.length, 2, 'both filed figures are cited');
        // Neither half is ever a table on its own.
        assert.equal(store.extract([fact('InterestIncomeExpenseNet', 'Banking', 600), fact('InterestIncomeExpenseNet', 'Mortgage', 400)], DATA, FILING).length, 0);
    } finally { p.verifiedField = original; }
});

test('revenue by region is read, and used only when nothing says what the company sells', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const regions = store.extract([fact('Revenues', 'UnitedStates', 790, { axis: 'srt:StatementGeographicalAxis' }), fact('Revenues', 'International', 210, { axis: 'srt:StatementGeographicalAxis' })], DATA, FILING);
        assert.equal(regions.length, 1);
        assert.equal(store.kind(regions[0]), 'regions');
        assert.equal(store.preferred(regions).usable, regions[0]);
        const segments = group(BUSINESS, '2025-12-31', [60, 40]);
        assert.equal(store.preferred([{ ...regions[0], periodEnd: '2025-12-31' }, segments]).usable, segments, 'segments of the same year come first');
    } finally { p.verifiedField = original; }
});

test('an insurer’s premiums stand in for revenue and are named as such; revenue itself wins a tie', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const premiums = store.extract([fact('PremiumsEarnedNet', 'Personal', 500), fact('PremiumsEarnedNet', 'Commercial', 300)], DATA, FILING);
        assert.equal(premiums[0].measure, 'net premiums earned');
        const both = store.extract([fact('PremiumsEarnedNet', 'Personal', 600), fact('PremiumsEarnedNet', 'Commercial', 400), fact('Revenues', 'Personal', 600), fact('Revenues', 'Commercial', 400)], DATA, FILING);
        assert.equal(both.length, 1);
        assert.equal(both[0].measure, undefined);
        assert.ok(store.segmentMeasure('us-gaap', 'Revenues') && store.segmentMeasure('us-gaap', 'NoninterestIncome') && !store.segmentMeasure('us-gaap', 'CostOfRevenue'));
    } finally { p.verifiedField = original; }
});
