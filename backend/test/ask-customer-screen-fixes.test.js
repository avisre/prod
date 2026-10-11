'use strict';
// Faults found in real customer questions to Ask (reviewed 2026-10-11): screens
// that needed index membership, a price range, multi-year EPS growth or a
// 200-day-average condition were approximated by hand or sent to "a charting
// platform"; growth-ranked screens opened with companies profitable in one
// year of ten; a seven-company comparison stopped after one round of lookups.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.DISABLE_BACKGROUND_JOBS = '1';
const chat = require('../ai-chat');
const metrics = require('../financial-metrics');
const src = fs.readFileSync(path.join(__dirname, '..', 'ai-chat.js'), 'utf8');
const screen = (args) => chat.screenRows({ ...args, established_first: true });

test('every screen row carries a price, and most carry the trend and profit-growth figures', () => {
    const { rows, matched } = chat.screenRows({ limit: 25, maxLimit: 10000 });
    assert.ok(matched > 3000);
    const all = chat.screenRows({ limit: 10000, maxLimit: 10000 }).rows;
    const have = (key) => all.filter((r) => typeof r[key] === 'number').length;
    assert.ok(have('price') > all.length * 0.9, 'price');
    assert.ok(have('priceVsAvg10mPct') > all.length * 0.6, 'price against the 10-month average');
    assert.ok(have('netIncomeCagr5Pct') > 1000, '5-year profit growth');
    assert.ok(rows.length === 25);
});

test('profit growth is immune to a stock split; the row never derives growth from filed EPS', () => {
    const year = (end, ni, eps) => ({ fiscalDateEnding: end, reportedCurrency: 'USD', totalRevenue: '1000', netIncome: String(ni), dilutedEPS: String(eps) });
    // A 10-for-1 split between the two years: EPS falls, profit quadruples.
    const data = { coverage: { latestAnnual: { reportDate: '2025-12-31' }, perShareAllowed: true },
        income: { annualReports: [year('2025-12-31', 400, 0.4), year('2020-12-31', 100, 1)], quarterlyReports: [] },
        balance: { annualReports: [] }, cash: { annualReports: [] }, marketData: { currency: 'USD', price: 50, asOf: '2026-10-09' } };
    const row = metrics.screenRow({ symbol: 'TEST' }, data);
    assert.ok(Math.abs(row.netIncomeCagr5Pct - 31.95) < 0.05, String(row.netIncomeCagr5Pct));
    assert.equal(row.price, 50);
    assert.equal(row.priceVsAvg10mPct, null, 'no monthly closes, so no trend figure');
    assert.ok(!('epsCagr5Pct' in row));
});

test('price against the 10-month average needs ten recent month-end closes', () => {
    const monthly = {};
    for (let m = 0; m < 10; m++) monthly[new Date(Date.UTC(2026, 9 - m, 1)).toISOString().slice(0, 10)] = { '4. close': '100' };
    const base = { coverage: { latestAnnual: { reportDate: '2025-12-31' } }, income: { annualReports: [{ fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD' }], quarterlyReports: [] },
        balance: { annualReports: [] }, cash: { annualReports: [] }, marketData: { currency: 'USD', price: 110, asOf: '2026-10-09' } };
    assert.equal(metrics.screenRow({ symbol: 'T' }, { ...base, monthly: { 'Monthly Adjusted Time Series': monthly } }).priceVsAvg10mPct, 10);
    const stale = Object.fromEntries(Object.entries(monthly).map(([d, r]) => [d.replace('2026', '2024').replace('2025', '2023'), r]));
    assert.equal(metrics.screenRow({ symbol: 'T' }, { ...base, monthly: { 'Monthly Adjusted Time Series': stale } }).priceVsAvg10mPct, null);
});

test('index membership comes from the stored lists, and any named index passes', () => {
    const ndx = screen({ index: 'nasdaq100', limit: 25 });
    const oex = screen({ index: 'S&P 100', limit: 25 });
    const either = screen({ index: 'sp100 or nasdaq100', limit: 25 });
    assert.ok(ndx.matched >= 80 && ndx.matched <= 101, String(ndx.matched));
    assert.ok(oex.matched >= 80 && oex.matched <= 100, String(oex.matched));
    assert.ok(either.matched > Math.max(ndx.matched, oex.matched) && either.matched < ndx.matched + oex.matched);
    assert.ok(screen({ index: 'sp500' }).matched > 400);
    assert.match(screen({ index: 'dow30' }).error, /Unknown index/);
    const members = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'data', 'index-members.json'), 'utf8'));
    assert.match(members.asOf, /^\d{4}-\d{2}-\d{2}$/);
    for (const r of ndx.rows) assert.ok(members.nasdaq100.includes(r.symbol), r.symbol);
});

test('price range, profit growth and trend are real filters', () => {
    const r = screen({ min_price: 5, max_price: 250, min_net_income_cagr_5y_pct: 10, min_price_vs_10_month_avg_pct: 0, limit: 25 });
    assert.ok(r.matched > 0);
    for (const row of r.rows) {
        assert.ok(row.price >= 5 && row.price <= 250, `${row.symbol} price`);
        assert.ok(row.netIncomeCagr5Pct >= 10, `${row.symbol} profit growth`);
        assert.ok(row.priceVsAvg10mPct >= 0, `${row.symbol} trend`);
    }
});

test('the same screen gives the same count and the same order', () => {
    const args = { min_revenue_cagr_5y_pct: 10, min_net_margin_pct: 20, sort_by: 'revCagr5Pct', limit: 25 };
    const a = screen(args), b = screen(args);
    assert.equal(a.matched, b.matched);
    assert.deepEqual(a.rows.map((r) => r.symbol), b.rows.map((r) => r.symbol));
});

test('a growth-ranked list for Ask opens with established companies; the page ordering is untouched', () => {
    const args = { min_revenue_cagr_5y_pct: 10, min_net_margin_pct: 20, sort_by: 'revCagr5Pct', limit: 25 };
    const ask = screen(args);
    assert.ok(ask.unprovenMatched > 0);
    const firstUnproven = ask.rows.findIndex((r) => !(r.profitableYears10 >= 5));
    if (firstUnproven !== -1) assert.ok(ask.rows.slice(firstUnproven).every((r) => !(r.profitableYears10 >= 5)));
    assert.ok(ask.rows[0].profitableYears10 >= 5);
    const page = chat.screenRows(args);
    assert.equal(page.matched, ask.matched);
    assert.equal(page.unprovenMatched, 0);
    assert.ok(page.rows[0].revCagr5Pct >= ask.rows[0].revCagr5Pct);
    const tool = chat.runTool('screen_universe', args, {});
    assert.match(tool.ordering, /Established companies first/);
});

test('a named list is compared in one call and unknown tickers are reported', () => {
    const tool = chat.runTool('screen_universe', { symbols: ['MSFT', 'ORCL', 'CRM', 'ADBE', 'NOW', 'INTU', 'ZZZZ'] }, {});
    assert.equal(tool.returned, 6);
    assert.deepEqual(tool.notInUniverse, ['ZZZZ']);
    assert.match(tool.table.split('\n')[0], /price\$.*profitCAGR5y%.*priceVs10mAvg%/);
});

test('the new filters survive the trip from the browser and unknown keys do not', () => {
    const out = chat.screenArgsFromClient({ index: 'nasdaq100', min_price: '5', max_price: 250, min_net_income_cagr_5y_pct: 10, min_price_vs_10_month_avg_pct: 0, established_first: true, symbols: ['A'] });
    assert.deepEqual(out, { index: 'nasdaq100', min_price: 5, max_price: 250, min_net_income_cagr_5y_pct: 10, min_price_vs_10_month_avg_pct: 0 });
});

test('running out of one allowance never tells Ask to stop researching', () => {
    assert.doesNotMatch(src, /answer now with what you already have/);
    assert.doesNotMatch(src, /Round tool budget exhausted — answer with what you already have/);
    assert.match(src, /Request it again in the next round/);
    assert.match(src, /carry on with the other tools/);
});

test('standing rules: all named companies in one answer, gaps said first, real report pages linked', () => {
    const prompt = chat.ASK_SYSTEM_TEXT || src;
    assert.match(prompt, /SEVERAL NAMED COMPANIES:[^\n]*symbols=/);
    assert.match(prompt, /never answer for a subset and ask the user to type "continue"/);
    assert.match(prompt, /WHAT YOU CANNOT COVER, SAID FIRST:/);
    assert.match(prompt, /OUR REPORTS:[^\n]*\/dossier\.html\?symbol=TICKER[^\n]*\/monitor\.html\?symbol=TICKER/);
    assert.match(prompt, /Never write an imitation of those reports/);
    assert.match(prompt, /never judge membership from memory/);
});

test('the Ask page offers a one-click full check on a stock', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(page, /<button>Give me a full check on MSFT:/);
});
