'use strict';

// Reduce a Yahoo-shaped daily series to the latest real close, its prior close,
// the change, and a sparkline. `date` is the trading date of `value`, not the
// time this response happened to be generated.
function buildMarketStripQuote(series) {
    if (!series || typeof series !== 'object') return null;
    const dates = Object.keys(series)
        .filter((date) => Number.isFinite(parseFloat((series[date] || {})['4. close'])))
        .sort((a, b) => (a < b ? 1 : -1));
    if (dates.length < 2) return null;
    const latest = parseFloat(series[dates[0]]['4. close']);
    const prior = parseFloat(series[dates[1]]['4. close']);
    if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) return null;
    const closes = dates.slice(0, 30).reverse()
        .map((date) => Number(parseFloat(series[date]['4. close']).toFixed(2)))
        .filter(Number.isFinite);
    return {
        value: latest,
        change: Number((latest - prior).toFixed(4)),
        pct: Number((((latest - prior) / prior) * 100).toFixed(4)),
        date: dates[0],
        closes
    };
}

module.exports = { buildMarketStripQuote };
