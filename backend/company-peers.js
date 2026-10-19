'use strict';

// Peers for the Stocks & funds page.
//
// Until 2026-10-10 the page asked the screener for a company's GICS sector and
// showed the first seven rows. The screener sorts by market value, so every
// Information Technology company was compared with Nvidia, Apple and Microsoft,
// and a company outside the sector's hundred largest (Fair Isaac) was missing
// from its own table.
//
// Measured on 20 tickers against the committed index: the industry label each
// company's overview already carries (145 labels, 4,936 of 4,944 screenable
// rows) gives the related companies — Boeing with Lockheed, GD and RTX — where
// the SIC code does not (Boeing with Joby and Archer). So: same industry label,
// closest in market value. A group too thin to compare falls back to the same
// four-digit SIC code, then to the sector.
//
// 2026-10-19 (owner): a company is grouped by its LARGEST business line, where
// its annual report breaks revenue into lines (primary-business.json, built by
// scripts/build-primary-business.js). Honeywell's label is "Conglomerates"; its
// largest line, Aerospace Technologies, is aerospace & defense. A company with
// no such table reports one business, which its label already names.
const fs = require('fs');
const path = require('path');

const DATA = process.env.SEC_COVERAGE_DATA_DIR || path.join(__dirname, '../frontend/data');
const FILE = path.join(DATA, 'industry-map.json');
const BUSINESS_FILE = path.join(DATA, 'primary-business.json');
const MIN_PEERS = 3;
const MEDIAN_KEYS = ['marketCapB', 'pe', 'revCagr5Pct', 'qtrNetIncomeYoYPct', 'netMarginPct', 'roePct', 'divYieldPct', 'profitableYears10'];
const ROW_KEYS = ['symbol', 'name', 'sector', ...MEDIAN_KEYS];

const key = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '-');
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

let industries;
function industryOf(symbol) {
    if (industries === undefined) {
        try { industries = JSON.parse(fs.readFileSync(FILE, 'utf8')).industries || {}; }
        catch (e) { if (e.code !== 'ENOENT') throw e; industries = {}; }
    }
    return industries[key(symbol)] || '';
}

let businesses;
function businessOf(symbol) {
    if (businesses === undefined) {
        try { businesses = JSON.parse(fs.readFileSync(BUSINESS_FILE, 'utf8')).businesses || {}; }
        catch (e) { if (e.code !== 'ENOENT') throw e; businesses = {}; }
    }
    return businesses[key(symbol)] || null;
}

// Dual-class pairs share a cik; the shortest symbol is the primary listing.
function oneListingPerIssuer(rows) {
    const best = new Map();
    for (const r of rows) {
        const id = r.cik || r.symbol;
        const cur = best.get(id);
        if (!cur || r.symbol.length < cur.symbol.length || (r.symbol.length === cur.symbol.length && r.symbol < cur.symbol)) best.set(id, r);
    }
    return [...best.values()];
}

function median(rows, k) {
    const vs = rows.map((r) => r[k]).filter(finite).map(Number).sort((a, b) => a - b);
    return vs.length ? vs[Math.floor(vs.length / 2)] : null;
}

const slim = (r) => Object.fromEntries(ROW_KEYS.map((k) => [k, r[k] === undefined ? null : r[k]]));

// `rows` is the screen index; `deps` lets a test supply its own lookups.
function peersFor(symbol, rows, { limit = 7, industry = industryOf, business = businessOf, sicFor = () => null } = {}) {
    const self = rows.find((r) => key(r.symbol) === key(symbol));
    if (!self) return null;
    const others = oneListingPerIssuer(rows.filter((r) => finite(r.marketCapB) && r.symbol !== self.symbol && !(self.cik && r.cik === self.cik)));
    // Every company, peers included, is placed by its largest line where it files one.
    const placed = (s) => (business(s) || {}).industry || industry(s);
    // Named as the basis only when the largest line moved the company: Apple's
    // iPhone line is consumer electronics, which its label already said.
    const own = business(self.symbol) && business(self.symbol).industry !== industry(self.symbol) ? business(self.symbol) : null;
    const label = placed(self.symbol);
    const sic = String(sicFor(self.symbol) || '');
    const tiers = [
        label && { basis: own ? 'business' : 'industry', label, rows: () => others.filter((r) => placed(r.symbol) === label) },
        /^\d{3,4}$/.test(sic) && { basis: 'sic', label: self.sector || '', rows: () => others.filter((r) => String(sicFor(r.symbol) || '') === sic) },
        self.sector && { basis: 'sector', label: self.sector, rows: () => others.filter((r) => r.sector === self.sector) }
    ].filter(Boolean);
    for (const tier of tiers) {
        const group = tier.rows();
        if (group.length < MIN_PEERS) continue;
        const cap = finite(self.marketCapB) && Number(self.marketCapB) > 0 ? Number(self.marketCapB) : null;
        // Closest in size, by ratio: a $15bn company is nearer $30bn than $1bn.
        const distance = (r) => cap && r.marketCapB > 0 ? Math.abs(Math.log(r.marketCapB / cap)) : Infinity;
        const nearest = group.slice().sort((a, b) => (distance(a) - distance(b)) || (b.marketCapB - a.marketCapB) || a.symbol.localeCompare(b.symbol)).slice(0, limit);
        const all = [self, ...group];
        return {
            symbol: self.symbol,
            group: { basis: tier.basis, label: tier.label, count: all.length,
                ...(tier.basis === 'business' ? { line: { name: own.line, sharePct: own.sharePct, periodEnd: own.periodEnd, sourceUrl: own.sourceUrl } } : {}) },
            self: slim(self),
            peers: nearest.sort((a, b) => b.marketCapB - a.marketCapB).map(slim),
            median: Object.fromEntries(MEDIAN_KEYS.map((k) => [k, median(all, k)]))
        };
    }
    return null;
}

module.exports = { peersFor, industryOf, businessOf, MIN_PEERS };
