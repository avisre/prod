// Look-through: what the user actually owns underneath their tickers.
//
// The dashboard has always shown a user their positions. It has never shown
// them the thing those positions resolve to. A portfolio of three funds is
// sixty-one companies, and the largest of them is usually not any ticker the
// user typed — that is the finding this module exists to state.
//
// The arithmetic is deliberately value-based, not weight-based: each fund's
// N-PORT weights are a fraction of that fund's own net assets, so a company's
// exposure is `fund value × weight in fund`, and a company's share of the
// portfolio is that exposure over the portfolio total. Summing percentages of
// different bases would be a quiet lie; summing dollars is not.
//
// Every number returned is derived from a filing or from the user's own stored
// holding. A fund whose holdings could not be read is never guessed at — it is
// named in `notExpanded` and its share of the portfolio is disclosed as
// uncovered, which is why `coveredPct` is returned alongside the counts.

const fundHoldings = require('./fund-holdings');

// Expanding every fund in a large portfolio would mean a dozen SEC fetches on
// one request. The biggest positions are expanded first and the rest are named
// as not expanded, so the reveal states what it read rather than implying it
// read everything.
const MAX_FUNDS = 8;
const TOP_N = 8;

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// N-PORT Part C codes: EC = common equity, EP = preferred equity. Everything
// else (debt, derivatives, repos, and a blank category we cannot classify) is
// held by the fund but is not a company, so it is excluded from the company
// count and reported separately rather than silently inflating it.
function isEquity(row) {
    return /^E[CP]$/i.test(String(row.assetCategory || '').trim());
}

function keyFor(name) {
    const key = fundHoldings.normalizeName(name);
    return key || String(name || '').trim().toLowerCase();
}

function buildReveal(holdings, options) {
    const opts = options || {};
    const fetchHoldings = opts.fetchHoldings || fundHoldings.fetchFundHoldings;
    const maxFunds = opts.maxFunds || MAX_FUNDS;

    const positions = (holdings || [])
        .map((h) => {
            const symbol = String(h.symbol || '').toUpperCase();
            const shares = num(h.shares) || 0;
            const price = num(h.currentPrice) !== null ? num(h.currentPrice) : num(h.purchasePrice);
            if (!symbol || shares <= 0 || price === null) return null;
            return {
                symbol,
                name: String(h.name || symbol),
                assetType: String(h.assetType || 'stock').toLowerCase(),
                value: shares * price
            };
        })
        .filter(Boolean);

    const total = positions.reduce((sum, p) => sum + p.value, 0);
    if (!positions.length || total <= 0) return null;

    const isFund = (p) => p.assetType === 'etf' || p.assetType === 'mutual_fund';
    const direct = positions.filter((p) => !isFund(p));
    const funds = positions.filter(isFund).sort((a, b) => b.value - a.value);
    const byValue = (list) => list.slice().sort((a, b) => b.value - a.value);
    const pct = (value) => Number(((value / total) * 100).toFixed(1));

    const companies = new Map();
    const add = (name, value, via) => {
        const key = keyFor(name);
        if (!key || value <= 0) return;
        const row = companies.get(key) || { name: String(name).trim(), value: 0, via: new Set(), direct: false };
        row.value += value;
        if (via === null) row.direct = true; else row.via.add(via);
        // The longest title seen is usually the legal one; keep it for display.
        if (String(name).trim().length > row.name.length) row.name = String(name).trim();
        companies.set(key, row);
    };

    for (const p of direct) add(p.name || p.symbol, p.value, null);

    const requested = funds.slice(0, maxFunds);
    const skipped = funds.slice(maxFunds);
    const notExpanded = skipped.map((f) => ({
        symbol: f.symbol, weightPct: pct(f.value), reason: 'beyond the largest funds expanded in one pass'
    }));

    return Promise.all(requested.map((fund) =>
        Promise.resolve()
            .then(() => fetchHoldings(fund.symbol))
            .then((data) => ({ fund, data }))
            .catch(() => ({ fund, data: null }))
    )).then((results) => {
        let coveredValue = direct.reduce((s, p) => s + p.value, 0);
        let otherValue = 0;
        const expanded = [];

        for (const { fund, data } of results) {
            const rows = (data && Array.isArray(data.holdings)) ? data.holdings : null;
            if (!rows || !rows.length) {
                notExpanded.push({
                    symbol: fund.symbol, weightPct: pct(fund.value),
                    reason: 'this fund files no holding report we can read'
                });
                continue;
            }
            coveredValue += fund.value;
            let equityWeight = 0;
            for (const row of rows) {
                const weight = num(row.weight);
                if (weight === null || weight <= 0) continue;   // shorts and derivatives
                if (!isEquity(row)) { otherValue += fund.value * weight; continue; }
                equityWeight += weight;
                add(row.name || row.issuer, fund.value * weight, fund.symbol);
            }
            expanded.push({
                symbol: fund.symbol, weightPct: pct(fund.value),
                positions: rows.length, asOf: (data && data.asOf) || null,
                source: (data && data.source) || null, sourceUrl: (data && data.sourceUrl) || null,
                // A fund whose equity rows carry no weight at all would otherwise
                // look like a fund that holds nothing.
                equityWeightPct: Number((equityWeight * 100).toFixed(1))
            });
        }

        const ranked = byValue([...companies.values()]).map((c) => ({
            name: c.name, weightPct: pct(c.value), value: Number(c.value.toFixed(2)),
            direct: c.direct, via: [...c.via].sort()
        }));
        if (!ranked.length) return null;

        const top = ranked.slice(0, TOP_N);

        return {
            tickers: positions.length,
            companies: ranked.length,
            top,
            largest: top[0],
            // The finding the reveal exists to state: the biggest thing you own
            // is not a line you entered. `direct` false means the whole exposure
            // arrived through a fund, which is the only case where that claim is
            // literally true — a company held both ways is described as both.
            largestIsUntyped: !top[0].direct,
            expanded,
            notExpanded,
            coveredPct: pct(coveredValue),
            otherPct: pct(otherValue),
            more: Math.max(0, ranked.length - top.length)
        };
    });
}

module.exports = { buildReveal, isEquity, keyFor };
