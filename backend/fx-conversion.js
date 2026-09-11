'use strict';

// USD presentation layer for foreign-reporter statements.
//
// Balance-sheet values use the fiscal-period closing rate; income and cash-flow
// values use the average of month-end rates over the reporting period. This
// mirrors the SEC's ASC 830 / S-X 3-20 presentation guidance without losing the
// source currency — every converted row keeps originalReportedCurrency,
// fxRateToUSD and fxRateBasis, and the payload carries a currencyConversion
// provenance block.
//
// Where this runs: fundamentals-fetch.js applies it once at the cache write, so
// the stored payload is already USD for every filer. That is deliberate — ten
// modules read that cache synchronously while fetching an FX series is async,
// so the write is the only point that can serve all of them. Conversion is a
// no-op for USD filers, and convertPayloadToUsd is idempotent (an
// already-converted payload reports USD and is returned untouched), so the
// opt-in route callers still use — presentFundamentalsCurrency in app.js, via
// ?presentationCurrency=USD — remains safe to call on top of it.

const yahooSource = require('./yahoo-source');

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const rateCache = new Map();
const NON_MONETARY_FIELDS = new Set([
    'fiscalDateEnding', 'reportedCurrency', 'originalReportedCurrency',
    'fxRateToUSD', 'fxRateBasis',
    'commonStockSharesOutstanding', 'weightedAverageSharesOutstanding',
    'weightedAverageSharesDiluted', 'weightedAverageShsOut',
    'weightedAverageShsOutDil', 'ordinarySharesNumber', 'shareIssued'
]);

function currency(value) {
    const code = String(value || '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : '';
}

function reportingCurrency(payload) {
    for (const statement of ['income', 'balance', 'cash']) {
        for (const period of ['annualReports', 'quarterlyReports']) {
            const row = (((payload || {})[statement] || {})[period] || [])
                .find((item) => item && item.reportedCurrency);
            if (row) return currency(row.reportedCurrency);
        }
    }
    return '';
}

function monthKey(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function shiftMonth(key, delta) {
    const match = String(key || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeSeries(series) {
    if (Array.isArray(series)) {
        return series.map((row) => ({ month: monthKey(row.month || row.date), rate: Number(row.rate ?? row.close) }))
            .filter((row) => row.month && Number.isFinite(row.rate) && row.rate > 0)
            .sort((a, b) => a.month.localeCompare(b.month));
    }
    const raw = (series || {})['Monthly Adjusted Time Series'] || series || {};
    return Object.entries(raw).map(([date, row]) => ({
        month: monthKey(date),
        rate: Number((row || {})['5. adjusted close'] ?? (row || {})['4. close'] ?? row)
    })).filter((row) => row.month && Number.isFinite(row.rate) && row.rate > 0)
        .sort((a, b) => a.month.localeCompare(b.month));
}

function closingRate(points, endMonth) {
    let chosen = null;
    for (const point of points) {
        if (point.month <= endMonth) chosen = point;
        else break;
    }
    return chosen ? chosen.rate : null;
}

function averageRate(points, endMonth, months) {
    const start = shiftMonth(endMonth, -(months - 1));
    const window = points.filter((point) => point.month >= start && point.month <= endMonth);
    if (!window.length) return null;
    return window.reduce((sum, point) => sum + point.rate, 0) / window.length;
}

function convertRow(row, rate, sourceCurrency, basis) {
    const converted = { ...row };
    for (const [key, value] of Object.entries(row || {})) {
        if (NON_MONETARY_FIELDS.has(key)) continue;
        if (value === '' || value === null || value === undefined) continue;
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        converted[key] = number * rate;
    }
    converted.originalReportedCurrency = sourceCurrency;
    converted.reportedCurrency = 'USD';
    converted.fxRateToUSD = rate;
    converted.fxRateBasis = basis;
    return converted;
}

function convertRows(rows, points, sourceCurrency, { balance = false, annual = true } = {}) {
    return (rows || []).map((row) => {
        const end = monthKey(row.fiscalDateEnding);
        if (!end) return row;
        const rate = balance ? closingRate(points, end) : averageRate(points, end, annual ? 12 : 3);
        if (!rate) return row;
        return convertRow(
            row,
            rate,
            sourceCurrency,
            balance ? 'fiscal-period closing rate' : `${annual ? '12' : '3'}-month average of month-end rates`
        );
    });
}

function convertPayloadWithSeries(payload, series, sourceCurrency = reportingCurrency(payload)) {
    const source = currency(sourceCurrency);
    if (!payload || !source || source === 'USD') return payload;
    const points = normalizeSeries(series);
    if (!points.length) throw new Error(`No ${source}/USD exchange-rate history is available.`);
    const out = JSON.parse(JSON.stringify(payload));
    for (const statement of ['income', 'balance', 'cash']) {
        const section = out[statement] || {};
        section.annualReports = convertRows(section.annualReports, points, source, {
            balance: statement === 'balance', annual: true
        });
        section.quarterlyReports = convertRows(section.quarterlyReports, points, source, {
            balance: statement === 'balance', annual: false
        });
    }
    out.currencyConversion = {
        from: source,
        to: 'USD',
        source: 'Yahoo Finance historical FX',
        balanceSheetBasis: 'Fiscal-period closing monthly rate',
        incomeAndCashFlowBasis: 'Average of month-end rates over each reporting period',
        approximate: true
    };
    return out;
}

async function rateSeries(sourceCurrency) {
    const source = currency(sourceCurrency);
    if (!source || source === 'USD') return [];
    const hit = rateCache.get(source);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const pair = `${source}USD=X`;
    const raw = await yahooSource.fetchFromYahoo('TIME_SERIES_MONTHLY_ADJUSTED', { symbol: pair });
    const value = normalizeSeries(raw);
    if (!value.length) throw new Error(`No ${source}/USD exchange-rate history is available.`);
    rateCache.set(source, { at: Date.now(), value });
    if (rateCache.size > 50) rateCache.delete(rateCache.keys().next().value);
    return value;
}

async function convertPayloadToUsd(payload) {
    const source = reportingCurrency(payload);
    if (!source || source === 'USD') return payload;
    return convertPayloadWithSeries(payload, await rateSeries(source), source);
}

module.exports = {
    reportingCurrency,
    normalizeSeries,
    closingRate,
    averageRate,
    convertPayloadWithSeries,
    convertPayloadToUsd
};
