'use strict';

// The statement lines of every screenable company, compact enough to scan in
// one pass. The filed statements themselves are 4.5 GB on disk and cannot be
// read per question, and the screen index carries one precomputed row per
// company: a question about any other figure ("revenue of the last four
// quarters against the four before") had nothing to be answered from.
//
// One row per company: its last quarters and fiscal years, newest first, for
// the lines in FIELDS. A value the company did not file is null, never estimated.

const fs = require('node:fs');
const path = require('node:path');
const p = require('./sec-coverage');

const VERSION = 1;
const FILE = 'screen-facts.json';
const QUARTERS = 12;
const YEARS = 10;

// Query name -> [statement, filed field]. The names are what Ask writes in a
// formula, so they stay short and plain.
const FIELDS = {
    revenue: ['income', 'totalRevenue'],
    cost_of_revenue: ['income', 'costOfRevenue'],
    gross_profit: ['income', 'grossProfit'],
    operating_expenses: ['income', 'operatingExpenses'],
    rnd: ['income', 'researchAndDevelopment'],
    sga: ['income', 'sellingGeneralAndAdministrative'],
    operating_income: ['income', 'operatingIncome'],
    interest_expense: ['income', 'interestExpense'],
    pretax_income: ['income', 'incomeBeforeTax'],
    income_tax: ['income', 'incomeTaxExpense'],
    net_income: ['income', 'netIncome'],
    discontinued_operations: ['income', 'discontinuedOperations'],
    eps_diluted: ['income', 'dilutedEPS'],
    diluted_shares: ['income', 'weightedAverageSharesDiluted'],
    total_assets: ['balance', 'totalAssets'],
    total_liabilities: ['balance', 'totalLiabilities'],
    equity: ['balance', 'totalShareholderEquity'],
    current_assets: ['balance', 'totalCurrentAssets'],
    current_liabilities: ['balance', 'totalCurrentLiabilities'],
    cash: ['balance', 'cashAndCashEquivalentsAtCarryingValue'],
    inventory: ['balance', 'inventory'],
    receivables: ['balance', 'currentNetReceivables'],
    goodwill: ['balance', 'goodwill'],
    ppe: ['balance', 'propertyPlantEquipment'],
    long_term_debt: ['balance', 'longTermDebt'],
    total_debt: ['balance', 'shortLongTermDebtTotal'],
    shares_outstanding: ['balance', 'commonStockSharesOutstanding'],
    operating_cash_flow: ['cash', 'operatingCashflow'],
    capex: ['cash', 'capitalExpenditures'],
    sbc: ['cash', 'shareBasedCompensation'],
    buybacks: ['cash', 'paymentsForRepurchaseOfCommonStock'],
    dividends_paid: ['cash', 'dividendPayout'],
    depreciation: ['cash', 'depreciationDepletionAndAmortization']
};

// Newest first, on the company's own calendar: each step back lands on the
// period one quarter (or one year) earlier. A period the company did not file
// keeps its place as a blank, so "four quarters back" is always the quarter a
// year earlier and never whatever row happens to be fourth. (Cutting the
// series at the first gap left Citigroup, one unfiled quarter in twelve, with
// a single quarter of history.)
function aligned(reports, stepDays, tolerance, limit) {
    const rows = (reports || []).filter(r => p.day(r.fiscalDateEnding))
        .sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));
    if (!rows.length) return [];
    const out = [rows[0]], currency = rows[0].reportedCurrency;
    let anchor = Date.parse(rows[0].fiscalDateEnding), misses = 0;
    while (out.length < limit && misses < 4) {
        const want = anchor - stepDays * 86400000;
        let best = null;
        for (const r of rows) {
            const gap = Math.abs(Date.parse(r.fiscalDateEnding) - want) / 86400000;
            if (gap <= tolerance && r.reportedCurrency === currency && (!best || gap < best.gap)) best = { r, gap };
        }
        if (best) { out.push(best.r); anchor = Date.parse(best.r.fiscalDateEnding); misses = 0; }
        else { out.push(null); anchor = want; misses++; }
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
}

function series(view, basis, stepDays, tolerance, limit) {
    const key = basis === 'q' ? 'quarterlyReports' : 'annualReports';
    const axis = aligned(view.income?.[key], stepDays, tolerance, limit);
    if (!axis.length) return null;
    const ends = axis.map(r => (r ? r.fiscalDateEnding : null)), currency = axis[0].reportedCurrency || null;
    const byEnd = st => new Map((view[st]?.[key] || []).filter(r => r.reportedCurrency === currency).map(r => [r.fiscalDateEnding, r]));
    const maps = { income: byEnd('income'), balance: byEnd('balance'), cash: byEnd('cash') };
    const f = {};
    for (const [name, [statement, field]] of Object.entries(FIELDS)) {
        const values = ends.map(end => (end ? p.number(maps[statement].get(end)?.[field]) : null));
        if (values.some(v => v !== null)) f[name] = values;
    }
    return { ends, f };
}

function row(company, view) {
    const q = series(view, 'q', 91.31, 20, QUARTERS), a = series(view, 'a', 365.25, 25, YEARS);
    if (!q && !a) return null;
    const currency = (view.income?.annualReports?.[0] || view.income?.quarterlyReports?.[0] || {}).reportedCurrency || null;
    return { s: company.symbol, c: currency, ...(q ? { q } : {}), ...(a ? { a } : {}) };
}

function snapshot(rows, asOf) {
    return { v: VERSION, asOf, generatedAt: new Date().toISOString(), count: rows.length, rows };
}

let cached = null;
function load(dir = p.DATA_DIR) {
    const file = path.join(dir, FILE);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return null; }
    if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.doc;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc.v !== VERSION || !Array.isArray(doc.rows)) return null;
    doc.bySymbol = new Map(doc.rows.map(r => [r.s, r]));
    cached = { file, mtimeMs: stat.mtimeMs, doc };
    return doc;
}
function invalidate() { cached = null; }

module.exports = { VERSION, FILE, FIELDS, QUARTERS, YEARS, row, snapshot, load, invalidate };
