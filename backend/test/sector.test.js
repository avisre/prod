'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sector = require('../sector');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'data', 'screen-index.json');

test('both vocabularies resolve to the one canonical GICS name', () => {
    // The six Yahoo names that differ from GICS.
    const differing = {
        'Financial Services': 'Financials',
        'Healthcare': 'Health Care',
        'Technology': 'Information Technology',
        'Consumer Cyclical': 'Consumer Discretionary',
        'Basic Materials': 'Materials',
        'Consumer Defensive': 'Consumer Staples'
    };
    for (const [yahoo, gics] of Object.entries(differing)) {
        assert.equal(sector.canonical(yahoo), gics, yahoo);
        assert.equal(sector.canonical(gics), gics, gics);
        assert.equal(sector.canonical(yahoo.toUpperCase()), gics, yahoo.toUpperCase());
        assert.equal(sector.canonical('  ' + yahoo + ' '), gics, 'whitespace ' + yahoo);
    }
    // The five the two taxonomies already share.
    for (const same of ['Industrials', 'Real Estate', 'Energy', 'Communication Services', 'Utilities']) {
        assert.equal(sector.canonical(same), same);
    }
    assert.equal(sector.CANONICAL.length, 11);
    assert.deepEqual([...sector.CANONICAL].sort(), [...new Set(sector.CANONICAL.map((s) => sector.canonical(s)))].sort());
});

test('unknown and empty values are preserved, never guessed', () => {
    assert.equal(sector.canonical(''), '');
    assert.equal(sector.canonical(null), '');
    assert.equal(sector.canonical(undefined), '');
    assert.equal(sector.canonical('Nonexistent Sector'), 'Nonexistent Sector');
});

test('a sector query matches across vocabularies without over-matching', () => {
    assert.equal(sector.matches('Information Technology', 'Technology'), true);
    assert.equal(sector.matches('Information Technology', 'Information Technology'), true);
    assert.equal(sector.matches('Health Care', 'Healthcare'), true);
    assert.equal(sector.matches('Financials', 'Financial Services'), true);
    assert.equal(sector.matches('Consumer Discretionary', 'Consumer Cyclical'), true);
    assert.equal(sector.matches('Energy', 'Financials'), false);
    assert.equal(sector.matches('', 'Financials'), false);
    assert.equal(sector.matches('Financials', ''), false);
});

test('every Yahoo sector finds rows in the GICS-keyed screen index', (t) => {
    if (!fs.existsSync(INDEX)) return t.skip('screen index not built');
    const rows = JSON.parse(fs.readFileSync(INDEX, 'utf8')).rows;
    const yahoo = ['Technology', 'Healthcare', 'Financial Services', 'Basic Materials',
        'Consumer Cyclical', 'Consumer Defensive', 'Industrials', 'Real Estate',
        'Energy', 'Communication Services', 'Utilities'];
    for (const name of yahoo) {
        const matched = rows.filter((r) => sector.matches(r.sector, name)).length;
        // Peer analysis needs >= 3 peers; before normalisation five of these were 0.
        assert.ok(matched >= 3, `${name} matched ${matched} rows`);
    }
});
