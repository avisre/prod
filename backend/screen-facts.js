'use strict';

// The statement lines of every screenable company, compact enough to scan in
// one pass. The filed statements themselves are 4.5 GB on disk and cannot be
// read per question, and the screen index carries one precomputed row per
// company: a question about any other figure ("revenue of the last four
// quarters against the four before") had nothing to be answered from.
//
// One row per company: its newest run of consecutive quarters and of
// consecutive fiscal years, newest first, for the lines in FIELDS. A value the
// company did not file is null, never estimated.

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

// Newest first, cut at the first gap: a formula that reads "four quarters back"
// must land on the quarter a year earlier, not on whatever row is fourth.
function consecutive(reports, minDays, maxDays, limit) {
    const rows = (reports || []).filter(r => p.day(r.fiscalDateEnding))
        .sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));
    const out = [];
    for (const r of rows) {
        if (out.length) {
            const prev = out[out.length - 1];
            const days = (Date.parse(prev.fiscalDateEnding) - Date.parse(r.fiscalDateEnding)) / 86400000;
            if (days < minDays || days > maxDays || r.reportedCurrency !== prev.reportedCurrency) break;
        }
        out.push(r);
        if (out.length === limit) break;
    }
    return out;
}

function series(view, basis, minDays, maxDays, limit) {
    const key = basis === 'q' ? 'quarterlyReports' : 'annualReports';
    const axis = consecutive(view.income?.[key], minDays, maxDays, limit);
    if (!axis.length) return null;
    const ends = axis.map(r => r.fiscalDateEnding), currency = axis[0].reportedCurrency || null;
    const byEnd = st => new Map((view[st]?.[key] || []).filter(r => r.reportedCurrency === currency).map(r => [r.fiscalDateEnding, r]));
    const maps = { income: byEnd('income'), balance: byEnd('balance'), cash: byEnd('cash') };
    const f = {};
    for (const [name, [statement, field]] of Object.entries(FIELDS)) {
        const values = ends.map(end => p.number(maps[statement].get(end)?.[field]));
        if (values.some(v => v !== null)) f[name] = values;
    }
    return { ends, f };
}

function row(company, view) {
    const q = series(view, 'q', 75, 110, QUARTERS), a = series(view, 'a', 340, 390, YEARS);
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
