'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ip = require('../ask-industry-profile');

test('real industry labels map to the intended archetype', () => {
    const cases = {
        'Banks - Regional': 'bank',
        'Banks - Diversified': 'bank',
        'Insurance - Diversified': 'insurer',
        'REIT - Retail': 'reit',
        'REIT - Mortgage': 'reit',
        'Asset Management': 'capital-markets',
        'Software - Infrastructure': 'software',
        'Semiconductors': 'semis-hardware',
        'Consumer Electronics': 'semis-hardware',
        'Biotechnology': 'pharma-biotech',
        'Drug Manufacturers - General': 'pharma-biotech',
        'Medical Devices': 'pharma-biotech',
        'Oil & Gas Integrated': 'energy',
        'Utilities - Regulated Electric': 'utility',
        'Discount Stores': 'consumer',
        'Packaged Foods': 'consumer',
        'Aerospace & Defense': 'industrial',
        'Airlines': 'industrial',
        'Shell Companies': 'shell'
    };
    for (const [industry, expected] of Object.entries(cases)) {
        assert.equal(ip.archetypeFor(industry, ''), expected, industry);
    }
});

test('every archetype names only metrics the engine can actually source', () => {
    // The guard against inventing FFO, net interest margin, ARR or EBITDA later.
    for (const [key, p] of Object.entries(ip.PROFILES)) {
        for (const m of p.metrics) assert.ok(ip.RATIOS.includes(m), `${key} metric ${m} is not a get_ratios_history ratio`);
        for (const l of p.lines) assert.ok(ip.LINES.includes(l), `${key} line ${l} is not a statement line`);
        assert.ok(p.note && p.note.length > 40, `${key} needs an explanation for its omissions`);
    }
    assert.equal(ip.PROFILES.shell.metrics.length, 0);
});

test('a missing Industry still narrows the metric set from the sector', () => {
    assert.equal(ip.archetypeFor('', 'Financials'), 'capital-markets');
    assert.equal(ip.archetypeFor('', 'Health Care'), 'pharma-biotech');
    assert.equal(ip.archetypeFor('', 'Healthcare'), 'pharma-biotech');
    assert.equal(ip.archetypeFor('', 'Materials'), 'industrial');
    assert.equal(ip.archetypeFor('', ''), 'generic');
    assert.equal(ip.archetypeFor('Unheard Of Industry', ''), 'generic');
});

test('the profile reports which label it decided from', () => {
    const p = ip.profile('Banks - Regional', 'Financials');
    assert.equal(p.archetype, 'bank');
    assert.equal(p.basis, 'Banks - Regional');
    assert.equal(p.sector, 'Financials');
    // Sector-only: the basis falls back to the canonical sector, not null.
    assert.equal(ip.profile('', 'Financial Services').basis, 'Financials');
});

test('select keeps only metrics with a value, and names those it dropped', () => {
    const history = { observations: [{ periodEnd: '2025-12-27', currency: 'USD', metrics: {
        netMarginPct: { value: 12.5 }, roePct: { value: null }, roaPct: { value: 0.9 }
    } }] };
    const sel = ip.select(ip.profile('Banks - Regional', ''), history);
    assert.deepEqual(sel.metrics, ['netMarginPct', 'roaPct']);
    assert.deepEqual(sel.missing, ['roePct', 'ocfToNetIncome']);
    assert.equal(sel.periodEnd, '2025-12-27');
    assert.equal(sel.currency, 'USD');
    // No history at all: nothing is claimed, everything is named as missing.
    const none = ip.select(ip.profile('Semiconductors', ''), null);
    assert.deepEqual(none.metrics, []);
    assert.deepEqual(none.missing, ip.PROFILES['semis-hardware'].metrics);
    // A shell company has no metric rows to fill in the first place.
    assert.deepEqual(ip.select(ip.profile('Shell Companies', ''), history).metrics, []);
});

// 2,248 of 4,649 covered companies carried no industry label and no sector on
// 2026-10-06 and were answered with the catch-all metric set.
test('an unlabelled company is typed by its SEC SIC code', () => {
    const cases = { 6022: 'bank', 6331: 'insurer', 6798: 'reit', 6199: 'capital-markets', 2834: 'pharma-biotech', 3841: 'pharma-biotech',
        7372: 'software', 3674: 'semis-hardware', 1311: 'energy', 2911: 'energy', 4911: 'utility', 1040: 'mining', 4813: 'telecom-media',
        5812: 'consumer', 3711: 'industrial', 8742: 'services', 6770: 'shell', 100: 'consumer' };
    for (const [sic, want] of Object.entries(cases)) assert.strictEqual(ip.archetypeFor('', '', sic), want, 'SIC ' + sic);
});
test('an industry label still outranks the SIC code, and a missing code falls back to the sector', () => {
    assert.strictEqual(ip.archetypeFor('Semiconductors', '', '6022'), 'semis-hardware');
    assert.strictEqual(ip.archetypeFor('', 'Energy', null), 'energy');
    assert.strictEqual(ip.archetypeFor('', '', '0000'), 'generic');
    assert.strictEqual(ip.profile('', '', '1040').metrics.length, 4);
});
