'use strict';
// The company page shows a segment breakdown only when a reader can use it:
// plain names, at least two rows, and rows that account for revenue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../sec-segment-observations');

const BUSINESS = 'us-gaap:StatementBusinessSegmentsAxis', PRODUCT = 'srt:ProductOrServiceAxis', REGION = 'srt:StatementGeographicalAxis';
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
    // Owner decision 2026-11-06: a sliver is shown too, as partial with the rest named, when nothing better exists.
    const sliver = group(PRODUCT, '2025-12-31', [5, 3, 1]);
    assert.equal(store.preferred([sliver]).partial, sliver);
    assert.equal(store.preferred([part, sliver]).partial, part, 'a fuller partial table still comes first');
});

test('a single-segment company is offered its one segment; leftovers and over-counts are not (2026-11-06)', () => {
    const named = (axis, label, value, member = 'x:RetailMember') => ({ axis, periodEnd: '2025-12-31', totalRevenue: 100, entries: [{ member, filedLabel: label, value }] });
    const generic = named(BUSINESS, 'Reportable Segment', 100, 'nflx:ReportableSegmentMember'), streaming = named(PRODUCT, 'Streaming', 100);
    assert.equal(store.preferred([generic]).partial, generic, 'a generic member holding all of revenue is the one segment');
    assert.deepEqual(store.shown(generic).rows.map(r => r.member), ['nflx:ReportableSegmentMember']);
    assert.equal(store.displayName(generic.entries[0]), 'Single reportable segment');
    assert.equal(store.preferred([generic, streaming]).partial, streaming, 'the segment named for its business comes first');
    const line = named(PRODUCT, 'Commercial printing', 3);
    assert.equal(store.preferred([generic, line]).partial, generic, 'the whole company before a 3% line');
    assert.equal(store.preferred([line]).partial, line);
    // Chevron: a roll-up of its segments and "All Other", 0.05% of revenue.
    const cvx = { axis: BUSINESS, periodEnd: '2025-12-31', totalRevenue: 1000, entries: [
        { member: 'us-gaap:ReportableSegmentAggregationBeforeOtherOperatingSegmentMember', filedLabel: 'Reportable Segment, Aggregation before Other Operating Segment', value: 975 },
        { member: 'us-gaap:AllOtherSegmentsMember', filedLabel: 'All Other', value: 1 }] };
    assert.equal(store.preferred([cvx]).partial, null, 'a table of nothing but "All Other" is not shown');
    assert.equal(store.preferred([group(BUSINESS, '2025-12-31', [90, 95])]).partial, null, 'rows over 110% of revenue over-count');
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

test('a one-segment company leads with its segment, never with its regions (AppLovin, FY2025)', () => {
    const segment = (member, filedLabel) => ({ axis: BUSINESS, periodEnd: '2025-12-31', totalRevenue: 100, entries: [{ member, label: null, filedLabel, value: 100 }] });
    const places = group(REGION, '2025-12-31', [52, 48]);
    const app = segment('app:ReportableSegmentMember', 'Reportable Segment');
    assert.equal(store.preferred([app, places]).usable, app, 'one Advertising segment says what the company sells; the US/non-US split says less');
    assert.equal(store.kind(store.preferred([app, places]).usable), 'operating segments');
    // A row that names no business leaves the regions on the page.
    for (const [member, filedLabel] of [['x:OtherMember', 'Other'], ['x:CorporateMember', 'Corporate and other'],
        ['x:SegmentsMember', 'Segments net of consolidation'], ['x:TotalMember', 'Total reportable segments']])
        assert.equal(store.preferred([segment(member, filedLabel), places]).usable, places, filedLabel);
    // Same year only: an older one-segment table never displaces this year's regions.
    assert.equal(store.preferred([{ ...app, periodEnd: '2024-12-31' }, places]).usable, places);
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


test('a tagged revenue split marks the profile as broken out by what it sells', () => {
    const { taggedSplitProfile } = require('../segments');
    const profile = { segments: [{ name: 'Apparel Retail', products: [] }], productRevenueBrokenOut: false };
    assert.equal(taggedSplitProfile(profile, 'tagged revenue split').productRevenueBrokenOut, true);
    assert.equal(taggedSplitProfile(profile, 'regions').productRevenueBrokenOut, true);
    assert.equal(taggedSplitProfile(profile, 'operating segments').productRevenueBrokenOut, false);
});

test('a one-segment company shows one row at its consolidated revenue; a multi-segment one does not', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const income = (totalRevenue) => ({ annualReports: [{ ...DATA.income.annualReports[0], totalRevenue }] });
        const one = store.extract([fact('Revenues', 'ReportableSegment', 45183000000)], { ...DATA, income: income(45183000000) }, FILING);
        const card = require('../segments').singleSegmentRow({ ...DATA, income: income(45183000000), segmentObservations: one }, 'NFLX');
        assert.ok(card && card.singleSegment, 'one tagged segment that is all of revenue is the one-segment card');
        assert.equal(card.segments.length, 1);
        assert.equal(card.segments[0].value, 45183000000, 'the figure is the income statement total, as filed');
        assert.equal(card.segments[0].revenuePct, 100);
        // A multi-segment company whose table failed must not be given a one-segment card.
        const many = store.extract([fact('Revenues', 'A', 600), fact('Revenues', 'B', 400)], { ...DATA, income: income(1000) }, FILING);
        assert.equal(require('../segments').singleSegmentRow({ ...DATA, income: income(1000), segmentObservations: many }, 'X'), null);
        // One row that leaves revenue out is a partial table, not a one-segment company.
        const thin = store.extract([fact('Revenues', 'Only', 340)], { ...DATA, income: income(1000) }, FILING);
        assert.equal(require('../segments').singleSegmentRow({ ...DATA, income: income(1000), segmentObservations: thin }, 'X'), null);
    } finally { p.verifiedField = original; }
});

test('a foreign filer’s own revenue line is read as revenue and still has to add up (KT, DHT 20-F)', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        // KT files RevenueAndOperatingIncome by segment in won; DHT files ShippingRevenue by charterer.
        const line = (concept, member, value, taxonomy, unit) => ({ ...fact('Revenues', member, value, { axis: 'ifrs-full:SegmentsAxis' }), taxonomy, concept, unit });
        const data = { ...DATA, income: { annualReports: [{ ...DATA.income.annualReports[0], reportedCurrency: 'KRW', totalRevenue: 10000 }] } };
        const groups = store.extract([line('RevenueAndOperatingIncome', 'Wireless', 8000, 'kt', 'KRW'), line('RevenueAndOperatingIncome', 'Media', 2000, 'kt', 'KRW')], data, FILING);
        assert.equal(groups.length, 1);
        assert.equal(groups[0].reconciliationStatus, 'reconciled');
        assert.equal(groups[0].measure, undefined, 'the filer’s own revenue line is revenue, not a stand-in measure');
        // A line that names a cost of revenue is not revenue.
        assert.equal(store.segmentMeasure('us-gaap', 'CostOfRevenue'), false);
        assert.equal(store.segmentMeasure('dht', 'ShippingRevenue'), true);
    } finally { p.verifiedField = original; }
});

test('a revenue split on the filer\'s own axis is a usable breakdown, labelled as a tagged split', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        // GAP, FY ended 2026-01-31: Old Navy 8,657 / Gap 3,501 / Banana Republic 1,916 / Athleta 1,219 / Other 73 ($M).
        const brands = [['OldNavy', 8657], ['Gap', 3501], ['BananaRepublic', 1916], ['Athleta', 1219], ['Otherentities', 73]]
            .map(([m, v]) => fact('Revenues', m, v * 1e6, { axis: 'dei:LegalEntityAxis' }));
        const groups = store.extract(brands, { ...DATA, income: { annualReports: [{ ...DATA.income.annualReports[0], totalRevenue: 15366000000 }] }, sources: DATA.sources }, FILING);
        assert.equal(groups.length, 1);
        assert.equal(store.kind(groups[0]), 'tagged revenue split');
        assert.equal(groups[0].reconciliationStatus, 'reconciled');
        const pick = store.preferred(groups);
        assert.equal(pick.usable, groups[0], 'the tagged split is shown when it adds to revenue');
        assert.ok(store.shown(groups[0]).usable);
        // A split that leaves revenue out is not usable.
        const short = brands.slice(0, 2);
        const partial = store.extract(short, { ...DATA, income: { annualReports: [{ ...DATA.income.annualReports[0], totalRevenue: 15366000000 }] }, sources: DATA.sources }, FILING);
        assert.equal(store.preferred(partial).usable, null);
    } finally { p.verifiedField = original; }
});

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

test('revenue cited to an amendment of the same annual report still anchors the breakdown; another filing does not', () => {
    const p = require('../sec-coverage'), original = p.verifiedField;
    p.verifiedField = () => true;
    try {
        const facts = [fact('Revenues', 'SendTech', 664), fact('Revenues', 'Presort', 336)];
        const amended = { ...DATA, sources: { rev: { accessionNumber: '0000000001-26-000009', form: '10-K/A' } } };
        assert.equal(store.extract(facts, amended, FILING).length, 1);
        const later = { ...DATA, sources: { rev: { accessionNumber: '0000000001-27-000001', form: '10-K' } } };
        assert.equal(store.extract(facts, later, FILING).length, 0);
    } finally { p.verifiedField = original; }
});

test('a bank’s own net-revenue concept is accepted and named; an arbitrary custom concept is not', () => {
    assert.ok(store.segmentMeasure('bac', 'RevenuesNetOfInterestExpenseFullTaxEquivalentBasis'));
    assert.ok(!store.segmentMeasure('bac', 'TotalSegmentIncome'));
    assert.ok(!store.segmentMeasure('us-gaap', 'RevenuesNetOfInterestExpenseSomethingElse'), 'the standard taxonomy is matched by its exact list only');
});

test('a roll-up member is never a row; segments before eliminations are shown as shares of their own total', () => {
    const withTotal = { axis: BUSINESS, periodEnd: '2025-12-31', totalRevenue: 1000, entries: [{ member: 'x:HealthBenefitsMember', value: 800 }, { member: 'x:ServicesMember', value: 60 }, { member: 'x:ReportableSegmentAggregationBeforeOtherOperatingSegmentMember', value: 990 }, { member: 'x:OtherMember', value: 30, filedLabel: 'Total' }] };
    assert.deepEqual(store.shown(withTotal).rows.map(r => r.member), ['x:HealthBenefitsMember', 'x:ServicesMember']);
    const gross = group(BUSINESS, '2025-12-31', [48, 36, 34]);
    assert.ok(store.shown(gross).gross && store.shown(gross).usable, '118% of revenue is a real set of segments that sell to each other');
    assert.ok(!store.shown(group(PRODUCT, '2025-12-31', [48, 36, 34])).usable, 'product lines that over-count are not');
    assert.ok(!store.shown(group(BUSINESS, '2025-12-31', [90, 80])).usable, 'nor is anything past 160%');
});

// Travelers and AIG, FY2025: net premiums earned by segment covers 89.9% and 88.4% of revenue (the rest is investment
// income); revenue by region accounts for all of it. The segments are what the insurer sells, and they lead.
test('an insurer\'s premium segments lead its regions, shown as partial; a plain revenue segment table does not jump the regions', () => {
  const REGION = 'srt:StatementGeographicalAxis';
  const premiums = { ...group(BUSINESS, '2025-12-31', [45, 30, 13]), measure: 'net premiums earned' };
  const regions = group(REGION, '2025-12-31', [95, 5]);
  const p = store.preferred([regions, premiums]);
  assert.equal(p.usable, null);assert.equal(p.partial, premiums);
  assert.equal(store.preferred([regions, group(BUSINESS, '2025-12-31', [45, 30, 13])]).usable, regions, 'no stand-in measure: regions stay');
  assert.equal(store.preferred([regions, { ...group(BUSINESS, '2025-12-31', [40, 30]), measure: 'net premiums earned' }]).usable, regions, 'under three quarters: regions stay');
});
