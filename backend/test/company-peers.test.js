'use strict';
// 2026-10-10: the Stocks & funds page compared every company with its sector's
// largest — Nvidia and Apple beside every software firm — and a company outside
// the sector's hundred largest was missing from its own table.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { peersFor } = require('../company-peers');

const row = (symbol, marketCapB, sector, extra = {}) => ({ symbol, name: symbol + ' Inc', cik: 'c' + symbol, sector, marketCapB, pe: 10, netMarginPct: 5, ...extra });
const INDUSTRY = { SELF: 'Software - Application', A: 'Software - Application', B: 'Software - Application', C: 'Software - Application', D: 'Software - Application', GIANT: 'Semiconductors', LONE: 'Shell Companies', S1: 'Banks - Regional', S2: 'Insurance - Life', S3: 'Asset Management' };
const industry = (s) => INDUSTRY[s] || '';
const ROWS = [
    row('GIANT', 5000, 'Information Technology'), row('SELF', 15, 'Information Technology'), row('A', 400, 'Information Technology'),
    row('B', 20, 'Information Technology'), row('C', 9, 'Information Technology'), row('D', 0.5, 'Information Technology'),
    row('LONE', 3, 'Financials'), row('S1', 50, 'Financials'), row('S2', 4, 'Financials'), row('S3', 1, 'Financials')
];

test('peers share the company\'s industry and are the closest in market value, never the sector giants', () => {
    const r = peersFor('SELF', ROWS, { industry, limit: 3 });
    assert.equal(r.group.basis, 'industry');
    assert.equal(r.group.label, 'Software - Application');
    assert.equal(r.group.count, 5);
    assert.equal(r.self.symbol, 'SELF');
    assert.deepEqual(r.peers.map((x) => x.symbol), ['A', 'B', 'C']); // B, C and A are nearest in size (D is further); shown largest first
    assert.ok(!r.peers.some((x) => x.symbol === 'GIANT' || x.symbol === 'SELF'));
    assert.equal(r.median.marketCapB, 15);
});

test('a thin industry falls back to the SIC code, then the sector; an unknown company has no peers', () => {
    const sic = { LONE: '6770', S1: '6770', S2: '6770', S3: '6770' };
    const bySic = peersFor('LONE', ROWS, { industry, sicFor: (s) => sic[s] });
    assert.equal(bySic.group.basis, 'sic');
    assert.deepEqual(bySic.peers.map((x) => x.symbol).sort(), ['S1', 'S2', 'S3']);
    const bySector = peersFor('LONE', ROWS, { industry });
    assert.equal(bySector.group.basis, 'sector');
    assert.equal(bySector.group.label, 'Financials');
    assert.equal(peersFor('NOPE', ROWS, { industry }), null);
});

test('a second share class is neither its own peer nor listed twice', () => {
    const rows = [...ROWS, { ...row('SELF.B', 15, 'Information Technology'), cik: 'cSELF' }, { ...row('AA', 400, 'Information Technology'), cik: 'cA' }];
    const r = peersFor('SELF', rows, { industry: (s) => INDUSTRY[s.replace(/\..*/, '')] || (s === 'AA' ? INDUSTRY.A : ''), limit: 7 });
    assert.deepEqual(r.peers.map((x) => x.symbol), ['A', 'B', 'C', 'D']);
});

test('the page reads the peers endpoint, and the committed industry map covers the screen', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    const peers = page.slice(page.indexOf('async function renderPeers()'), page.indexOf('const CMP_METRICS'));
    assert.match(peers, /\/api\/company\/\$\{encodeURIComponent\(symbol\)\}\/peers/);
    assert.doesNotMatch(peers, /api\/screener/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), /app\.get\('\/api\/company\/:symbol\/peers'/);
    const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'data', 'industry-map.json'), 'utf8'));
    assert.ok(map.count > 4000 && map.industries.FICO === 'Software - Application');
});
