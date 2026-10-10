'use strict';

// model_trade: a deterministic trade scenario built from dated daily prices.
// Every level the answer may state is computed here, never by the model, and
// is returned under `claimable` so the numerical review accepts it. The model
// chooses the wording; it does not choose the numbers.
//
// Measured 2026-10-10 against the provider: 276 daily bars for each of ten
// listings including a sub-dollar one (FRGT); listed options for nine of the
// ten. A listing with no option chain gets a stop order as its protection.

const stockUniverse = require('./stock-universe');

const HORIZONS = {
    short_term: { label: 'short-term (days to two weeks)', atrStop: 1.5, window: 10, minOptionDays: 14 },
    swing: { label: 'swing (two to eight weeks)', atrStop: 2, window: 20, minOptionDays: 30 },
    long_term: { label: 'long-term (six months or more)', atrStop: 3.5, window: 120, minOptionDays: 180 }
};
const DISCLAIMER = 'AI-generated trade model, not financial advice. It can be wrong: prices move, levels fail and the data may be delayed. Do your own research before placing any order.';
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

let yf = null;
function client() {
    if (!yf) {
        const YahooFinance = require('yahoo-finance2').default;
        const noop = () => {};
        yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'],
            logger: { info: noop, warn: noop, error: noop, debug: noop, dir: noop }, validation: { logErrors: false, logOptionsErrors: false } });
    }
    return yf;
}
const yahooSymbol = symbol => String(symbol || '').toUpperCase().trim().replace(/\./g, '-');
function timed(promise, ms = 9000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('market data timeout')), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
}
async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
}
async function fetchBars(symbol) {
    return cached('bars:' + symbol, async () => {
        const chart = await timed(client().chart(symbol, { period1: new Date(Date.now() - 400 * 86400000), interval: '1d' }));
        return { currency: chart.meta?.currency || 'USD',
            bars: (chart.quotes || []).filter(b => [b.high, b.low, b.close].every(Number.isFinite))
                .map(b => ({ date: new Date(b.date).toISOString().slice(0, 10), high: b.high, low: b.low, close: b.close })) };
    });
}
async function fetchOptions(symbol, date) {
    return cached('opt:' + symbol + ':' + (date ? date.toISOString().slice(0, 10) : ''), () => timed(client().options(symbol, date ? { date } : {})));
}
let deps = { fetchBars, fetchOptions };

// Nearest listings for a symbol nobody lists: one edit away, or the same
// letters with one more or fewer. Suggestions only, never a substitution.
function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0]; row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const keep = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = keep;
        }
    }
    return row[b.length];
}
function nearestListings(symbol, limit = 3, companies = stockUniverse.companies()) {
    const key = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '');
    if (key.length < 2) return [];
    return [...companies].filter(c => c.symbol && c.symbol !== key && editDistance(key, String(c.symbol).toUpperCase()) === 1)
        .sort((a, b) => (b.symbol[0] === key[0]) - (a.symbol[0] === key[0]) || (b.symbol.startsWith(key) || key.startsWith(b.symbol)) - (a.symbol.startsWith(key) || key.startsWith(a.symbol)) || a.symbol.localeCompare(b.symbol))
        .slice(0, limit).map(c => ({ symbol: c.symbol, name: c.name }));
}

const px = value => Number(value.toFixed(Math.abs(value) < 1 ? 4 : 2));
const pct = value => Number(value.toFixed(1));
function average(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function indicators(bars) {
    const closes = bars.map(b => b.close);
    const ranges = [];
    for (let i = 1; i < bars.length; i++) ranges.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
    const sma = n => closes.length >= n ? average(closes.slice(-n)) : null;
    const year = bars.slice(-252);
    return { atr14: average(ranges.slice(-14)), sma20: sma(20), sma50: sma(50), sma200: sma(200),
        high52: Math.max(...year.map(b => b.high)), low52: Math.min(...year.map(b => b.low)) };
}

// The option leg: the first listed expiry at least `minDays` out, and the
// strike nearest the stop on the protective side. A contract nobody quotes
// (no bid and ask) is not offered as protection.
async function optionLeg({ symbol, long, stop, entry, minDays, today }) {
    let first;
    try { first = await deps.fetchOptions(symbol, null); } catch (_) { return { available: false, reason: 'The option chain could not be retrieved.' }; }
    const expiries = (first?.expirationDates || []).map(d => new Date(d)).filter(d => Number.isFinite(d.getTime())).sort((a, b) => a - b);
    if (!expiries.length) return { available: false, reason: 'No listed options trade on this symbol.' };
    const wanted = expiries.find(d => (d - today) / 86400000 >= minDays) || expiries[expiries.length - 1];
    let chain = first.options?.find(o => new Date(o.expirationDate).getTime() === wanted.getTime());
    if (!chain) {
        try { chain = (await deps.fetchOptions(symbol, wanted))?.options?.[0]; } catch (_) { chain = null; }
    }
    const contracts = ((long ? chain?.puts : chain?.calls) || []).filter(c => Number.isFinite(c.strike) && c.bid > 0 && c.ask > 0 && c.ask >= c.bid);
    if (!contracts.length) return { available: false, reason: 'No quoted contract was available at a protective strike for that expiry.' };
    const side = contracts.filter(c => long ? c.strike <= entry : c.strike >= entry);
    const pick = (side.length ? side : contracts).slice().sort((a, b) => Math.abs(a.strike - stop) - Math.abs(b.strike - stop))[0];
    const premium = px((pick.bid + pick.ask) / 2);
    const expiry = wanted.toISOString().slice(0, 10);
    return { available: true, type: long ? 'protective put' : 'protective call', expiry, daysToExpiry: Math.round((wanted - today) / 86400000),
        strike: px(pick.strike), bid: px(pick.bid), ask: px(pick.ask), premiumMid: premium,
        costPerContract: px(premium * 100), costPctOfEntry: pct(premium / entry * 100),
        openInterest: Number.isFinite(pick.openInterest) ? pick.openInterest : null,
        impliedVolatilityPct: Number.isFinite(pick.impliedVolatility) ? pct(pick.impliedVolatility * 100) : null,
        breakeven: px(long ? entry + premium : entry - premium),
        maxLossPerShare: px(long ? entry - pick.strike + premium : pick.strike - entry + premium),
        maxLossPct: pct((long ? entry - pick.strike + premium : pick.strike - entry + premium) / entry * 100),
        note: 'One contract covers 100 shares. The premium is the bid/ask midpoint and is paid whether or not the protection is used.' };
}

async function modelTrade(args = {}, ctx = {}) {
    const typed = String(args.symbol || '').toUpperCase().trim();
    if (!typed) return { error: 'No symbol given.' };
    const horizonKey = HORIZONS[args.horizon] ? args.horizon : 'swing';
    const horizon = HORIZONS[horizonKey];
    const long = String(args.direction || 'long').toLowerCase() !== 'short';
    const protect = args.downside_protection !== false;
    const listing = stockUniverse.lookup(typed);
    let data;
    try { data = await deps.fetchBars(yahooSymbol(typed)); } catch (_) { data = null; }
    if (!data || data.bars.length < 30) {
        const didYouMean = listing ? [] : nearestListings(typed);
        return { error: listing ? `Daily prices for ${typed} are unavailable right now, so no trade can be modelled.`
            : `${typed} is not a listed symbol we can price. Tell the user it was not found${didYouMean.length ? ' and name the nearest listing' : ''}; never model another company in its place.`,
            symbol: typed, unknownSymbol: !listing, didYouMean };
    }
    const bars = data.bars, last = bars[bars.length - 1], ind = indicators(bars), currency = data.currency;
    const window = bars.slice(-horizon.window);
    const support = Math.min(...window.map(b => b.low)), resistance = Math.max(...window.map(b => b.high));
    const entry = px(last.close);
    const riskPerShare = px(horizon.atrStop * ind.atr14);
    const stop = px(long ? entry - riskPerShare : entry + riskPerShare);
    if (long && stop <= 0) return { error: `${typed} is too volatile for its price to place a meaningful stop: its typical daily range exceeds the share price.`, symbol: typed };
    const target = multiple => px(long ? entry + multiple * riskPerShare : entry - multiple * riskPerShare);
    const targets = [2, 3].map(multiple => ({ rewardToRisk: multiple, price: target(multiple),
        movePct: pct(multiple * riskPerShare / entry * 100) })).filter(t => t.price > 0);
    const money = [], percentages = [];
    const out = {
        symbol: typed, name: listing?.name || null, currency, asOf: last.date, priceAsOf: last.date,
        horizon: horizonKey, horizonLabel: horizon.label, direction: long ? 'long' : 'short',
        price: entry,
        entry: { reference: entry, zoneLow: px(long ? entry - 0.5 * ind.atr14 : entry), zoneHigh: px(long ? entry : entry + 0.5 * ind.atr14),
            method: 'Reference is the latest daily close; the zone is half of one average daily range on the favourable side.' },
        volatility: { atr14: px(ind.atr14), atrPctOfPrice: pct(ind.atr14 / entry * 100), definition: 'Average true range over the last 14 trading days: the typical daily move.' },
        levels: { recentLow: px(support), recentHigh: px(resistance), windowDays: window.length,
            sma20: ind.sma20 === null ? null : px(ind.sma20), sma50: ind.sma50 === null ? null : px(ind.sma50), sma200: ind.sma200 === null ? null : px(ind.sma200),
            week52High: px(ind.high52), week52Low: px(ind.low52),
            trend: ind.sma50 === null ? 'not enough history' : entry > ind.sma50 ? 'above its 50-day average' : 'below its 50-day average' },
        riskPerShare, riskPctOfEntry: pct(riskPerShare / entry * 100),
        targets,
        source: 'Yahoo Finance daily prices (may be delayed); levels computed by stockportfolio.pro',
        sourceUrl: 'https://finance.yahoo.com/quote/' + encodeURIComponent(yahooSymbol(typed)) + '/history/',
        disclaimer: DISCLAIMER
    };
    // A share whose ordinary daily swing is a large part of its price cannot be
    // held to a tight level. The model is still returned; the reader is told.
    out.warnings = [
        ...(out.volatility.atrPctOfPrice >= 10 ? [`Extremely volatile: the typical daily move is ${out.volatility.atrPctOfPrice}% of the price, so the stop sits ${out.riskPctOfEntry}% away and may still be jumped.`] : []),
        ...(entry < 1 ? ['Sub-dollar share: spreads are wide, fills are unreliable and some brokers restrict or will not accept orders in it.'] : [])
    ];
    if (protect) {
        out.protection = { stop: { price: stop, orderType: long ? 'sell stop' : 'buy stop', distancePct: pct(riskPerShare / entry * 100),
            method: `${horizon.atrStop} × the 14-day average true range from the entry reference.`,
            caveat: 'A stop order can fill below its level when the price gaps, and a stop on a thinly traded share may not fill near it at all.' } };
        out.protection.option = await optionLeg({ symbol: yahooSymbol(typed), long, stop, entry, minDays: horizon.minOptionDays, today: new Date(last.date + 'T00:00:00Z') });
    } else {
        out.protection = null;
        out.protectionNote = `No protective order is modelled because the user declined it. The size below still assumes an exit after an adverse move of ${riskPerShare} per share (${horizon.atrStop} × average true range); without an order nothing enforces that exit.`;
    }
    const account = Number(args.account_size), riskPct = Number.isFinite(Number(args.risk_pct)) && Number(args.risk_pct) > 0 ? Math.min(Number(args.risk_pct), 100) : 1;
    if (Number.isFinite(account) && account > 0) {
        const budget = account * riskPct / 100;
        const shares = Math.max(0, Math.min(Math.floor(budget / riskPerShare), Math.floor(account / entry)));
        out.positionSize = { accountSize: px(account), riskPct, riskBudget: px(budget), shares, positionValue: px(shares * entry),
            positionPctOfAccount: pct(shares * entry / account * 100), lossAtStop: px(shares * riskPerShare),
            gainAtTargets: targets.map(t => ({ rewardToRisk: t.rewardToRisk, gain: px(shares * t.rewardToRisk * riskPerShare) })),
            method: 'Shares = the risk budget divided by the risk per share, capped at what the account can buy without borrowing.' };
        const p = out.positionSize;
        money.push(p.accountSize, p.riskBudget, p.positionValue, p.lossAtStop, ...p.gainAtTargets.map(g => g.gain));
        percentages.push(p.riskPct, p.positionPctOfAccount);
    } else {
        out.positionSize = { per1000AtRisk: { shares: Math.floor(1000 / riskPerShare), positionValue: px(Math.floor(1000 / riskPerShare) * entry) },
            method: 'No account size was given. Shares = the amount the user is willing to lose divided by the risk per share; shown for 1,000 at risk.' };
        money.push(1000, out.positionSize.per1000AtRisk.positionValue);
    }
    const held = (ctx?.holdings || []).find(h => yahooSymbol(h.symbol || h.ticker) === yahooSymbol(typed));
    out.existingHolding = held ? { shares: Number(held.shares ?? held.quantity) || null, note: 'The user already holds this symbol; the new trade adds to that exposure.' } : null;
    money.push(entry, out.entry.zoneLow, out.entry.zoneHigh, out.volatility.atr14, riskPerShare, ...targets.map(t => t.price),
        ...Object.values(out.levels).filter(Number.isFinite));
    percentages.push(out.volatility.atrPctOfPrice, out.riskPctOfEntry, ...targets.map(t => t.movePct));
    if (out.protection) {
        money.push(stop); percentages.push(out.protection.stop.distancePct);
        const o = out.protection.option;
        if (o.available) {
            money.push(o.strike, o.bid, o.ask, o.premiumMid, o.costPerContract, o.breakeven, o.maxLossPerShare);
            percentages.push(o.costPctOfEntry, o.maxLossPct, ...(o.impliedVolatilityPct === null ? [] : [o.impliedVolatilityPct]));
        }
    }
    out.claimable = { money: [...new Set(money.filter(Number.isFinite))].map(value => ({ value, unit: currency })), percentages: [...new Set(percentages.filter(Number.isFinite))] };
    out.note = 'State only the levels in this result, each with the price date. Do not derive further prices or percentages yourself. This is a scenario, not a prediction.';
    return out;
}

module.exports = { modelTrade, nearestListings, editDistance, indicators, HORIZONS, DISCLAIMER,
    __setDeps: next => { deps = { ...deps, ...next }; }, __resetDeps: () => { deps = { fetchBars, fetchOptions }; cache.clear(); } };
