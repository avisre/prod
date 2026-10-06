'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const inline = require('../ask-inline-segments'), proof = require('../ask-segment-evidence');
function fixture(taxonomy = 'us-gaap', currency = 'USD') {
    const anchor = { value: 100e6, currency, periodStart: '2024-04-01', periodEnd: '2025-03-31', sourceId: 'revenue', source: { rawValue: 100e6, unit: currency } };
    const context = member => `<xbrli:context id="${member}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">123</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="${taxonomy}:${taxonomy === 'us-gaap' ? 'StatementBusinessSegmentsAxis' : 'SegmentsAxis'}">company:${member}Member</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2024-04-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period></xbrli:context>`;
    const unit = `<xbrli:unit id="native"><xbrli:measure>iso4217:${currency}</xbrli:measure></xbrli:unit>`;
    const fact = (member, value) => `<ix:nonFraction name="${taxonomy}:${taxonomy === 'us-gaap' ? 'Revenues' : 'Revenue'}" contextRef="${member}" unitRef="native" scale="6" format="ixt:num-dot-decimal">${value}</ix:nonFraction>`;
    const html = context('Cloud') + context('Devices') + unit + fact('Cloud', 65) + fact('Devices', 35);
    const parsed = { periodEnd: anchor.periodEnd, basisExcerpt: '(in millions)', periodExcerpt: 'Year ended 2025-03-31', segments: [
        { name: 'Cloud', reportedValue: 65, scale: 1e6, currency, value: 65e6, sourceExcerpt: 'Cloud Devices Revenue 65 35' },
        { name: 'Devices', reportedValue: 35, scale: 1e6, currency, value: 35e6, sourceExcerpt: 'Cloud Devices Revenue 65 35' }
    ] };
    const filing = { form: '20-F', date: '2025-05-01', accession: '0000000123-25-000001', url: 'https://www.sec.gov/Archives/edgar/data/123/000000012325000001/annual.htm' };
    const text = [parsed.basisExcerpt, parsed.periodExcerpt, parsed.segments[0].sourceExcerpt].join(' ');
    return { anchor, html, parsed, filing, text };
}
test('shared column headers require exact inline segment-to-amount binding in US GAAP and IFRS', () => {
    for (const [taxonomy, currency] of [['us-gaap', 'USD'], ['ifrs-full', 'EUR']]) {
        const f = fixture(taxonomy, currency), rows = inline.bindings(f.html, f.anchor, '0000000123');
        assert.equal(rows.length, 2);
        const context = { text: f.text, anchor: f.anchor, inlineBindings: rows };
        const valid = proof.normalizeResult(f.parsed, 'TEST', '0000000123', f.filing, context);
        assert.equal(valid?.segments[0].value, 65e6);
        assert.equal(proof.validCachedPayload(valid, '0000000123', f.filing, f.anchor), true);
        assert.equal(proof.normalizeResult(f.parsed, 'TEST', '0000000123', f.filing, { ...context, inlineBindings: [] }), null);
        const swapped = structuredClone(f.parsed);
        [swapped.segments[0].value, swapped.segments[1].value] = [35e6, 65e6];
        [swapped.segments[0].reportedValue, swapped.segments[1].reportedValue] = [35, 65];
        assert.equal(proof.normalizeResult(swapped, 'TEST', '0000000123', f.filing, context), null);
        valid.segments[0].inlineBinding.fact.excerpt = valid.segments[0].inlineBinding.fact.excerpt.replace('65', '35');
        assert.equal(proof.validCachedPayload(valid, '0000000123', f.filing, f.anchor), false);
    }
});
test('inline bindings reject wrong issuer, quarter, currency, concept and conflicting same-member values', () => {
    const f = fixture();
    for (const html of [f.html.replaceAll('>123<', '>124<'), f.html.replaceAll('2024-04-01', '2025-01-01'),
        f.html.replaceAll('iso4217:USD', 'iso4217:EUR'), f.html.replaceAll('us-gaap:Revenues', 'us-gaap:OperatingIncomeLoss')])
        assert.equal(inline.bindings(html, f.anchor, '0000000123').length, 0);
    const conflict = f.html + '<ix:nonFraction name="us-gaap:Revenues" contextRef="Cloud" unitRef="native" scale="6">66</ix:nonFraction>';
    assert.equal(inline.select(inline.bindings(conflict, f.anchor, '0000000123'), 'Cloud', 65e6, 1e6, f.anchor, '0000000123'), null);
});

// Segment tables used to need an extraction model call per company, and failed
// outright for filers that tag segments with a second "operating segments" axis.
function tagged(rows, { extraAxis = false, axis = 'us-gaap:StatementBusinessSegmentsAxis' } = {}) {
    const context = m => `<xbrli:context id="${m}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">123</xbrli:identifier><xbrli:segment>${extraAxis ? '<xbrldi:explicitMember dimension="srt:ConsolidationItemsAxis">us-gaap:OperatingSegmentsMember</xbrldi:explicitMember>' : ''}<xbrldi:explicitMember dimension="${axis}">x:${m}Member</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
    return rows.map(([m]) => context(m)).join('') + '<xbrli:unit id="u"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>' +
        rows.map(([m, v]) => `<ix:nonFraction name="us-gaap:Revenues" contextRef="${m}" unitRef="u" scale="6" format="ixt:num-dot-decimal">${v}</ix:nonFraction>`).join('');
}
const ANCHOR = { value: 100e6, currency: 'USD', periodStart: '2025-01-01', periodEnd: '2025-12-31' };
test('tagged segment revenue is read without a model, including the operating-segments axis', () => {
    for (const extraAxis of [false, true]) {
        const g = inline.groups(tagged([['GoogleCloud', 40], ['GoogleServicesSegment', 60]], { extraAxis }), ANCHOR, 123).segments;
        assert.deepEqual(g.rows.map(r => [r.name, r.value]), [['Google Cloud', 40e6], ['Google Services', 60e6]]);
        assert.equal(g.reconciled, true);
    }
});
test('a subtotal tagged beside its parts is dropped; another issuer or period is ignored', () => {
    const g = inline.groups(tagged([['Product', 70], ['IPhone', 50], ['Mac', 20], ['Service', 30]], { axis: 'srt:ProductOrServiceAxis' }), ANCHOR, 123).products;
    assert.deepEqual(g.rows.map(r => r.name), ['iPhone', 'Mac', 'Service']);
    assert.deepEqual(inline.groups(tagged([['A', 40], ['B', 60]]), ANCHOR, 999), {});
    assert.deepEqual(inline.groups(tagged([['A', 40], ['B', 60]]), { ...ANCHOR, periodEnd: '2024-12-31' }, 123), {});
    // Rows adding up to more than filed revenue with no removable subtotal are not a breakdown.
    assert.equal(inline.groups(tagged([['A', 90], ['B', 80]]), ANCHOR, 123).segments, undefined);
});
