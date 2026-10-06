'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const offBalance = require('../off-balance-sheet');
const { label } = require('../ask-inline-segments');
const store = require('../sec-segment-observations');

const context = (id, body) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier>${body.segment || ''}</xbrli:entity><xbrli:period>${body.period}</xbrli:period></xbrli:context>`;
const instant = d => `<xbrli:instant>${d}</xbrli:instant>`;
const member = (axis, m) => `<xbrli:segment><xbrldi:explicitMember dimension="${axis}">${m}</xbrldi:explicitMember></xbrli:segment>`;
const fact = (name, ctx, printed, scale = 9) => `<ix:nonFraction name="${name}" contextRef="${ctx}" unitRef="usd" scale="${scale}" decimals="-7">${printed}</ix:nonFraction>`;
const FILING = `<html><body>
<ix:header><ix:resources>
${context('dur', { period: '<xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate>' })}
${context('now', { period: instant('2026-06-30') })}
${context('prior', { period: instant('2025-12-31') })}
${context('campus', { period: instant('2025-10-31'), segment: member('us-gaap:OtherCommitmentsAxis', 'abc:DataCenterCampusMember') })}
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
<xbrli:unit id="years"><xbrli:measure>utr:Y</xbrli:measure></xbrli:unit>
</ix:resources></ix:header>
<ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="dur">June 30, 2026</ix:nonNumeric>
<div><span>We have also entered into leases that have not yet commenced. </span><span>These lease obligations were approximately $${fact('us-gaap:UnrecordedUnconditionalPurchaseObligationBalanceSheetAmount', 'now', '278.99')} billion, consisting of data centers, which will commence through 2036.</span></div>
<div><span>In addition, we have provided residual value guarantees with an aggregate threshold of approximately $${fact('abc:UnrecordedUnconditionalPurchaseObligationResidualValueGuaranteeMaximum', 'campus', '28')} billion that decreases over time.</span></div>
<div><span>As of June 30, 2026 and December 31, 2025, our maximum exposure to loss in these VIEs was $${fact('us-gaap:VariableInterestEntityEntityMaximumLossExposureAmount', 'now', '6.41')} billion and $${fact('us-gaap:VariableInterestEntityEntityMaximumLossExposureAmount', 'prior', '5.58')} billion, respectively.</span></div>
<table><tr><td>Total</td><td>${fact('us-gaap:UnrecordedUnconditionalPurchaseObligationBalanceSheetAmount', 'now', '34,150', 6)}</td></tr>
<tr><td>Year two</td><td>${fact('us-gaap:UnrecordedUnconditionalPurchaseObligationBalanceOnSecondAnniversary', 'now', '3,863', 6)}</td></tr>
<tr><td>Operating lease liabilities</td><td>${fact('us-gaap:OperatingLeaseLiability', 'now', '25,200', 6)}</td></tr></table>
<div>During the period we made $${fact('abc:PaymentsRelatedToFinanceLeasesNotYetCommenced', 'dur', '835', 6)} million of lease prepayments for leases not yet commenced.</div>
</body></html>`;

test('off-balance-sheet reader keeps tagged commitments with their filing sentence', () => {
    const { periodEnd, items } = offBalance.read(FILING);
    assert.equal(periodEnd, '2026-06-30');
    const by = Object.fromEntries(items.map(i => [i.category + ':' + i.value, i]));
    const lease = by['leases_not_commenced:278990000000'];
    assert.ok(lease, 'an uncommenced lease filed under the purchase-obligation concept is recognised from its sentence');
    assert.equal(lease.name, 'Leases not yet commenced');
    assert.match(lease.excerpt, /^These lease obligations were approximately \$278\.99 billion/);
    const guarantee = by['guarantees:28000000000'];
    assert.equal(guarantee.name, 'Residual value guarantee');
    assert.deepEqual(guarantee.scope, ['Data Center Campus']);
    assert.equal(guarantee.asOf, '2025-10-31', 'an arrangement dated at signing is kept');
    assert.ok(by['unconsolidated_entities:6410000000']);
});

test('off-balance-sheet reader drops comparatives, schedules, payments and recorded liabilities', () => {
    const { items } = offBalance.read(FILING);
    assert.ok(!items.some(i => i.value === 5.58e9), 'the prior-period comparative is superseded by the current figure');
    assert.ok(!items.some(i => /SecondAnniversary/.test(i.concept)), 'a maturity-schedule row repeats a total');
    assert.ok(!items.some(i => /^abc:Payments/.test(i.concept)), 'a prepayment is cash paid, not a commitment');
    assert.ok(!items.some(i => /OperatingLeaseLiability/.test(i.concept)), 'a recorded lease liability is on the balance sheet');
    assert.ok(items.some(i => i.value === 34.15e9 && i.excerpt === null), 'a table cell has no sentence and is kept by its concept');
    assert.equal(items.length, 4);
});

test('segment members are set in plain words for every issuer', () => {
    const cases = {
        'meta:FamilyOfAppsMember': 'Family of Apps', 'meta:RealityLabsMember': 'Reality Labs', 'inod:DdsMember': 'DDS',
        'jpm:AssetandWealthManagementMember': 'Asset and Wealth Management', 'aapl:WearablesHomeandAccessoriesMember': 'Wearables Home and Accessories',
        'msft:MicrosoftThreeSixFiveCommercialProductsAndCloudServicesMember': 'Microsoft 365 Commercial Products and Cloud Services',
        'x:ProductsandServicesMember': 'Products and Services', 'x:BrandSolutionsMember': 'Brand Solutions', 'x:ThailandMember': 'Thailand',
        'x:OilandGasMember': 'Oil and Gas', 'us-gaap:AmazonWebServicesSegmentMember': 'Amazon Web Services', 'aapl:IPhoneMember': 'iPhone',
        'dlx:MerchantServicesMemberMember': 'Merchant Services', 'x:OEMAndOtherMember': 'OEM and Other'
    };
    for (const [raw, expected] of Object.entries(cases)) assert.equal(label(raw), expected, raw);
    assert.equal(store.displayName({ member: 'meta:FamilyOfAppsMember', label: null }), 'Family of Apps');
    assert.equal(store.displayName({ member: 'avgo:SemiconductorSolutionsMember', label: 'Semiconductor Solutions' }), 'Semiconductor Solutions');
});

test('the newest multi-member segment group leads; a lone segment yields to product lines', () => {
    const g = (axis, periodEnd, n) => ({ axis, periodEnd, entries: Array.from({ length: n }, (_, i) => ({ member: 'x:M' + i })) });
    const old = g('us-gaap:StatementBusinessSegmentsAxis', '2024-12-31', 3), latest = g('us-gaap:StatementBusinessSegmentsAxis', '2025-12-31', 2);
    assert.equal(store.preferred([old, latest]).primary, latest);
    const lone = g('us-gaap:StatementBusinessSegmentsAxis', '2025-12-31', 1), lines = g('srt:ProductOrServiceAxis', '2025-12-31', 4);
    assert.equal(store.preferred([lone, lines]).primary, lines);
    assert.equal(store.preferred([]).primary, undefined);
});
