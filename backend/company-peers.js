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
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.SEC_COVERAGE_DATA_DIR || path.join(__dirname, '../frontend/data'), 'industry-map.json');
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
function peersFor(symbol, rows, { limit = 7, industry = industryOf, sicFor = () => null } = {}) {
    const self = rows.find((r) => key(r.symbol) === key(symbol));
    if (!self) return null;
    const others = oneListingPerIssuer(rows.filter((r) => finite(r.marketCapB) && r.symbol !== self.symbol && !(self.cik && r.cik === self.cik)));
    const label = industry(self.symbol);
    const sic = String(sicFor(self.symbol) || '');
    const tiers = [
        label && { basis: 'industry', label, rows: () => others.filter((r) => industry(r.symbol) === label) },
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
            group: { basis: tier.basis, label: tier.label, count: all.length },
            self: slim(self),
            peers: nearest.sort((a, b) => b.marketCapB - a.marketCapB).map(slim),
            median: Object.fromEntries(MEDIAN_KEYS.map((k) => [k, median(all, k)]))
        };
    }
    return null;
}

module.exports = { peersFor, industryOf, MIN_PEERS };
