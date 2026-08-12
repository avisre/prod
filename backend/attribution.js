// Movement attribution — "why is my portfolio down today?"
//
// Brokers show the red number with zero explanation; a wave of micro-startups
// exists just to answer this one question. We answer it deterministically:
// each holding's day move × its weight = its contribution to your day, sorted
// by what actually mattered, with today's headlines attached to the biggest
// movers. Passive dashboard loads are fully deterministic and never invoke AI.

const yahooSource = require('./yahoo-source');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function quoteFor(symbol) {
    try {
        const q = await yahooSource.fetchQuote(symbol);
        const g = (q && q['Global Quote']) || {};
        const pct = parseFloat(String(g['10. change percent'] || '').replace('%', ''));
        return {
            price: num(g['05. price']),
            dayPct: Number.isFinite(pct) ? pct : null,
            tradingDay: g['07. latest trading day'] || null
        };
    } catch (_) { return { price: null, dayPct: null, tradingDay: null }; }
}

async function headlinesFor(symbol, max = 2) {
    try {
        const feed = await yahooSource.fetchNews({ tickers: symbol, limit: 6 });
        const items = (feed && feed.feed) || [];
        return items.slice(0, max).map((i) => ({
            title: String(i.title || '').slice(0, 160),
            url: String(i.url || ''),
            source: String(i.source || '')
        })).filter((i) => i.title);
    } catch (_) { return []; }
}

async function computeAttribution(holdings) {
    const positions = [];
    for (const h of holdings || []) {
        const symbol = String(h.symbol || '').toUpperCase();
        const shares = num(h.shares) || 0;
        const stored = num(h.currentPrice) !== null ? num(h.currentPrice) : num(h.purchasePrice);
        if (!symbol || shares <= 0) continue;
        positions.push({ symbol, shares, stored });
    }
    if (!positions.length) return { empty: true };

    // live quotes, small parallel batches (Yahoo tolerates this fine)
    const BATCH = 4;
    for (let i = 0; i < positions.length; i += BATCH) {
        await Promise.all(positions.slice(i, i + BATCH).map(async (p) => {
            const q = await quoteFor(p.symbol);
            p.price = q.price !== null ? q.price : p.stored;
            p.dayPct = q.dayPct;
            p.tradingDay = q.tradingDay;
        }));
    }

    const valued = positions.filter((p) => p.price !== null && p.price > 0);
    const total = valued.reduce((a, p) => a + p.shares * p.price, 0);
    if (!total) return { empty: true };

    let portfolioDayPct = 0;
    let covered = 0;
    for (const p of valued) {
        p.value = p.shares * p.price;
        p.weightPct = (p.value / total) * 100;
        if (p.dayPct !== null) {
            p.contributionPct = (p.weightPct / 100) * p.dayPct;
            p.dollarMove = p.value * (p.dayPct / 100) / (1 + p.dayPct / 100);
            portfolioDayPct += p.contributionPct;
            covered += p.weightPct;
        } else {
            p.contributionPct = null;
            p.dollarMove = null;
        }
    }
    const movers = valued
        .filter((p) => p.contributionPct !== null)
        .sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));

    // headlines for the holdings that actually drove the day
    const drivers = movers.slice(0, 3).filter((p) => Math.abs(p.dayPct) >= 1);
    // Search/RSS feeds can return the same generic item for multiple tickers.
    // Keep each sourced headline on one driver only so a headline is not
    // presented as evidence for unrelated holdings.
    const seenHeadlineKeys = new Set();
    for (const p of drivers) {
        const headlines = await headlinesFor(p.symbol);
        p.headlines = headlines.filter((headline) => {
            const key = String(headline.url || headline.title || '').split('?')[0].trim().toLowerCase();
            if (!key || seenHeadlineKeys.has(key)) return false;
            seenHeadlineKeys.add(key);
            return true;
        });
    }

    const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
    const payload = {
        asOf: (movers[0] && movers[0].tradingDay) || new Date().toISOString().slice(0, 10),
        portfolioDayPct: round2(portfolioDayPct),
        portfolioDayUsd: round2(valued.reduce((a, p) => a + (p.dollarMove || 0), 0)),
        coveragePct: Math.round(covered),
        totalValue: Math.round(total),
        movers: movers.slice(0, 8).map((p) => ({
            symbol: p.symbol,
            weightPct: round2(p.weightPct),
            dayPct: round2(p.dayPct),
            contributionPct: round2(p.contributionPct),
            dollarMove: round2(p.dollarMove),
            headlines: p.headlines || []
        })),
        note: 'Contribution = weight × day move, from live quotes. Headlines are the day\'s news for the biggest movers — context, not confirmed causes.'
    };

    return payload;
}

module.exports = { computeAttribution };
