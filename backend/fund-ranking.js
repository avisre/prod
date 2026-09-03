'use strict';

// ETF / mutual-fund performance ranking shared by Ask and portfolio Q&A.
// Yahoo's predefined fund screens provide the candidate universe and sort;
// asset-profile supplies the one-year return that the screen omits from rows.
const axios = require('axios');
const assetProfile = require('./asset-profile');

const ENDPOINT = 'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved';
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

const PERIODS = {
    '3m': { sortField: 'trailing_3m_return', rowField: 'trailingThreeMonthReturns', label: 'Trailing 3-month total return' },
    '1y': { sortField: 'annualreturnnavy1', rowField: null, label: 'Trailing 1-year total return' },
    '3y': { sortField: 'annualreturnnavy3', rowField: 'annualReturnNavY3', label: 'Annualised trailing 3-year return' }
};

function n(value) {
    const out = Number(value);
    return Number.isFinite(out) ? out : null;
}

function canonicalType(value) {
    const type = assetProfile.normalizeAssetType(value);
    if (type === 'etf' || type === 'mutual_fund') return type;
    return String(value || '').toLowerCase() === 'all' ? 'all' : null;
}

function baseFundName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[®™]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\b(?:class|cl)\s+[a-z0-9-]+\b.*$/i, '')
        .replace(/\s+(?:admiral|investor|institutional|instl|inst|adv|service|serv|inv|r[1-6]|[a-z])(?:\s+shares?)?$/i, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function distinctCandidates(rows, assetType) {
    const seen = new Set();
    const expected = assetType === 'etf' ? 'ETF' : 'MUTUALFUND';
    const out = [];
    for (const row of rows || []) {
        if (!row || !row.symbol || String(row.quoteType || '').toUpperCase() !== expected) continue;
        const name = row.longName || row.shortName || row.symbol;
        const key = baseFundName(name) || String(row.symbol).toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

async function fetchScreen(assetType, period) {
    const screenId = assetType === 'etf' ? 'top_etfs_us' : 'top_mutual_funds';
    const cfg = PERIODS[period];
    const response = await axios.get(ENDPOINT, {
        params: {
            formatted: false,
            lang: 'en-US',
            region: 'US',
            scrIds: screenId,
            count: 60,
            sortField: cfg.sortField,
            sortType: 'DESC'
        },
        headers: { 'User-Agent': 'Mozilla/5.0 stockportfolio.pro fund screener' },
        timeout: 15000
    });
    const finance = response && response.data && response.data.finance;
    if (finance && finance.error) throw new Error(finance.error.description || 'Fund screen unavailable');
    const result = finance && finance.result && finance.result[0];
    if (!result) throw new Error('Fund screen returned no results');
    return { rows: result.quotes || [], universe: n(result.total) };
}

// "Short <index>" is how the plain -1x products are named (ProShares Short
// S&P500, Short QQQ, Short Dow30, Short Russell2000) alongside the more
// obviously-marked 2x/3x/ultra/leveraged/inverse/bear/bull funds. The
// lookahead keeps ordinary short-duration bond funds ("Short-Term Treasury",
// "Short Duration Bond") from being misflagged as inverse products.
const LEVERAGED_RE = /(?:\b[23]x\b|\b1\.5x\b|\b1\.75x\b|ultra|leveraged|inverse|bear\b|bull\s+[123](?:\.\d+)?x|\bshort\b(?![\s-]*(?:term|duration|maturity|bond)))/i;

function rankedRow(row, assetType, period, returnPct, profile) {
    const name = (profile && profile.name) || row.longName || row.shortName || row.symbol;
    return {
        symbol: String(row.symbol || '').toUpperCase(),
        name,
        assetType,
        assetTypeLabel: assetType === 'etf' ? 'ETF' : 'Mutual fund',
        returnPct: n(returnPct),
        period,
        leveragedOrInverse: LEVERAGED_RE.test(name)
    };
}

async function rankOne(assetType, period) {
    const key = `${assetType}:${period}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const screen = await fetchScreen(assetType, period);
    const candidates = distinctCandidates(screen.rows, assetType);
    let results = [];

    if (period === '1y') {
        // The screen sorts by one-year NAV return but does not include that
        // field in its quote rows, so resolve the top distinct candidates.
        const selected = candidates.slice(0, 15);
        const profiles = await Promise.all(selected.map((row) =>
            assetProfile.fetchAssetProfile(row.symbol).catch(() => null)
        ));
        results = selected.map((row, index) => {
            const profile = profiles[index];
            const raw = profile && profile.returns && n(profile.returns.oneYear);
            return raw === null ? null : rankedRow(row, assetType, period, raw * 100, profile);
        }).filter(Boolean).sort((a, b) => b.returnPct - a.returnPct);
    } else {
        const field = PERIODS[period].rowField;
        results = candidates.map((row) => {
            const value = n(row[field]);
            return value === null ? null : rankedRow(row, assetType, period, value, null);
        }).filter(Boolean).sort((a, b) => b.returnPct - a.returnPct);
    }

    const value = {
        assetType,
        period,
        periodLabel: PERIODS[period].label,
        eligibleUniverse: screen.universe,
        results: results.slice(0, 10)
    };
    cache.set(key, { at: Date.now(), value });
    return value;
}

async function rankFunds(options = {}) {
    const assetType = canonicalType(options.assetType || options.asset_type || 'all');
    if (!assetType) throw new Error('assetType must be etf, mutual_fund, or all');
    const period = String(options.period || 'all').toLowerCase();
    if (period !== 'all' && !PERIODS[period]) throw new Error('period must be 3m, 1y, 3y, or all');
    const limit = Math.min(Math.max(Number(options.limit) || 3, 1), 10);
    const types = assetType === 'all' ? ['mutual_fund', 'etf'] : [assetType];
    const periods = period === 'all' ? ['3m', '1y', '3y'] : [period];
    const jobs = [];
    for (const type of types) for (const p of periods) jobs.push(rankOne(type, p));
    const ranked = await Promise.all(jobs);
    const rankings = {};
    for (const block of ranked) {
        if (!rankings[block.assetType]) rankings[block.assetType] = {};
        rankings[block.assetType][block.period] = { ...block, results: block.results.slice(0, limit) };
    }
    return {
        asOf: new Date().toISOString(),
        source: 'Yahoo Finance fund screener and fund profiles',
        scope: 'Eligible US funds in Yahoo Finance predefined screening universes; duplicate share classes are collapsed. This is not every registered fund.',
        methodology: '3-month and 1-year figures are trailing total returns. The 3-year figure is an annualised NAV return. Rankings are historical observations, not forecasts.',
        rankings
    };
}

module.exports = { rankFunds, baseFundName, distinctCandidates, PERIODS };
