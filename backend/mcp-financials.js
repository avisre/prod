'use strict';

// Data layer for the OpenAI Apps MCP surface (/mcp/apps) — see
// backend/mcp-apps.js for the tool contract and notes/2026-09-29-openai-plugin
// -architecture.md for the design decisions.
//
// Everything here is read-only. Values come from two places, in this order:
//   1. frontend/data/fundamentals/*.json — the same normalized cache every
//      other surface reads (instant, local files).
//   2. The SEC's own submissions + XBRL companyconcept endpoints, for the
//      filing metadata (accession, report date, URL) and for the diluted
//      weighted-average share count, which the fundamentals cache does not
//      carry. Both are cached in Mongo so the second call for a symbol is a
//      single indexed read.
//
// Nothing is estimated. A metric with no value is returned as null and every
// value that has a filing behind it carries that filing's accession and URL.
// The linkage is labelled: "xbrl_fact" when the value was read from an SEC
// XBRL fact (the fact's own accession), "filing_period" when the value comes
// from the normalized cache and the source is the filing that reports that
// fiscal period. Callers must not describe a filing_period link as if the
// number were extracted from that document.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const secSource = require('./sec-source');
const filingSections = require('./filing-sections');
const { normalizeTicker } = require('./symbol-resolver');
const { loadFundamentals: loadCachedFundamentals } = require('./fundamentals-cache');

const DATA_DIR = path.join(__dirname, '..', 'frontend', 'data');
const FUND_DIR = path.join(DATA_DIR, 'fundamentals');
const SITE = 'https://www.stockportfolio.pro';

const FILING_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // filings change slowly
const SHARES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMO_MAX = 200;
const FILING_MAX_CHARS = 400000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
// A single typed error so the MCP layer can map to a stable code without
// string-matching. `details` is what makes an error actionable (the metric
// list, the candidate companies) and is safe to return — no internal data.
function mcpError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    if (details) err.details = details;
    return err;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const DAY = 86400000;

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
    if (!Number.isFinite(value)) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

function pctChange(current, prior) {
    if (current === null || prior === null || prior === 0) return null;
    return round((current / Math.abs(prior) - Math.sign(prior)) * 100, 4);
}

function dayDiff(a, b) { return Math.abs(Date.parse(a) - Date.parse(b)) / DAY; }

function isoDay(value) {
    const s = String(value || '');
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// Bounded LRU — the process is long-lived and these maps only cache SEC reads.
function memoGet(map, key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > (hit.ttl || FILING_TTL_MS)) { map.delete(key); return null; }
    map.delete(key); map.set(key, hit); // refresh recency
    return hit;
}
function memoSet(map, key, value, ttl) {
    map.set(key, { at: Date.now(), ttl, value });
    while (map.size > MEMO_MAX) map.delete(map.keys().next().value);
}

// ---------------------------------------------------------------------------
// Company catalog — symbol, name, CIK, sector, index membership
// ---------------------------------------------------------------------------
let _catalog = null;
let _fundamentalsSet = null;

function fundamentalsSet() {
    if (_fundamentalsSet) return _fundamentalsSet;
    try {
        _fundamentalsSet = new Set(
            fs.readdirSync(FUND_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
        );
    } catch (_) { _fundamentalsSet = new Set(); }
    return _fundamentalsSet;
}

function readJsonFile(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function companyCatalog() {
    if (_catalog) return _catalog;
    const bySymbol = new Map();
    const universe = readJsonFile(path.join(DATA_DIR, 'us-companies.json'), { companies: [] });
    for (const c of universe.companies || []) {
        const symbol = normalizeTicker(c.symbol);
        if (!symbol) continue;
        bySymbol.set(symbol, {
            ticker: symbol,
            name: String(c.name || symbol),
            cik: c.cik ? String(c.cik).padStart(10, '0') : null, exchange:c.exchange || null,
            sector: c.sector || null,
            index: null, securityType:c.securityType || 'stock'
        });
    }
    for(const [symbol,entry] of bySymbol) if(entry.securityType !== 'stock') bySymbol.delete(symbol);
    _catalog = bySymbol;
    return _catalog;
}

// Ranked search over the local catalog. A ticker-shaped query that exactly
// matches wins outright; otherwise exact names, then prefixes, then substrings.
// This is what prevents ticker ambiguity before any data call.
function searchCompanies(query, limit = 10) {
    const raw = String(query || '').trim();
    if (!raw) return [];
    const upper = raw.toUpperCase();
    const normalized = normalizeTicker(raw);
    const catalog = companyCatalog();
    const hits = [];
    for (const entry of catalog.values()) {
        const nameUpper = entry.name.toUpperCase();
        let score = null;
        if (entry.ticker === normalized || entry.ticker === upper) score = 0;
        else if (entry.ticker.startsWith(normalized)) score = 1;
        else if (nameUpper === upper) score = 2;
        else if (nameUpper.startsWith(upper)) score = 3;
        else if (nameUpper.includes(upper)) score = 4;
        else if (entry.ticker.includes(normalized)) score = 5;
        if (score === null) continue;
        hits.push({
            score,
            hasFundamentals: ['ready','partial','historical_only'].includes(require('./public-stock-index').get(entry.ticker)?.financialCoverage),
            entry
        });
    }
    hits.sort((a, b) => a.score - b.score
        || Number(b.hasFundamentals) - Number(a.hasFundamentals)
        || a.entry.ticker.length - b.entry.ticker.length
        || a.entry.ticker.localeCompare(b.entry.ticker));
    const max = Math.min(Math.max(Number(limit) || 10, 1), 25);
    return hits.slice(0, max).map((h) => {
        const fundamentals = h.hasFundamentals ? loadFundamentals(h.entry.ticker) : null;
        const overview = fundamentals ? fundamentals.overview || {} : {};
        return {
            ...h.entry,
            exchange: overview.Exchange || h.entry.exchange || null,
            fiscal_year_end: overview.FiscalYearEnd || null,
            has_financial_data: h.hasFundamentals
        };
    });
}

// Resolve one user-supplied company identifier. Accepts an exact ticker, a CIK
// number, or a name. An ambiguous name throws with the candidates so the model
// can ask the user instead of guessing.
async function resolveCompany(input) {
    const instrument=require('./stock-universe').lookup(input);
    if(instrument && instrument.securityType!=='stock')throw mcpError('UNSUPPORTED_SECURITY_TYPE','Company financial analysis is unavailable for this instrument.');
    const raw = String(input || '').trim();
    if (!raw) throw mcpError('COMPANY_REQUIRED', 'Provide a company ticker, name or CIK.');
    if (/^\d{4,10}$/.test(raw)) {
        const cik = raw.padStart(10, '0');
        for (const entry of companyCatalog().values()) if (entry.cik === cik) return { ...entry };
        throw mcpError('COMPANY_NOT_FOUND', `No US-listed company with CIK ${raw} was found.`);
    }
    const normalized = normalizeTicker(raw);
    const catalog = companyCatalog();
    const exact = catalog.get(normalized);
    if (exact) return { ...exact };

    const candidates = searchCompanies(raw, 6);
    if (!candidates.length) {
        throw mcpError('COMPANY_NOT_FOUND', `No company matched "${raw}". Use search_companies to find the ticker.`);
    }
    // A unique exact-name or exact-ticker hit is safe; anything else is
    // ambiguous, and picking one silently is how wrong-company answers happen.
    if (candidates.length === 1) return { ...candidates[0] };
    throw mcpError('AMBIGUOUS_COMPANY', `"${raw}" matches more than one company. Use search_companies, then pass the exact ticker.`, {
        candidates: candidates.map((c) => ({ ticker: c.ticker, name: c.name }))
    });
}

// ---------------------------------------------------------------------------
// Fundamentals cache
// ---------------------------------------------------------------------------
function loadFundamentals(symbol) {
    const data = loadCachedFundamentals(symbol);
    return data && data.income ? data : null;
}

function overviewOf(symbol, data) {
    const ov = (data && data.overview) || {};
    return {
        ticker: symbol,
        name: ov.Name || null,
        cik: ov.CIK ? String(ov.CIK).padStart(10, '0') : null,
        exchange: ov.Exchange || null,
        currency: String(ov.Currency || 'USD').toUpperCase(),
        fiscal_year_end: ov.FiscalYearEnd || null
    };
}

// Merges the three statements per fiscal period and returns newest first.
// Cash-flow and balance rows sometimes carry a date a few days off the income
// row's (Yahoo rounds to month-end; SEC reports the real 13/52-week period
// end), so the merge tolerates ±14 days and prefers an exact date match.
function periodRows(data, periodType) {
    const key = periodType === 'quarterly' ? 'quarterlyReports' : 'annualReports';
    const income = ((data.income || {})[key]) || [];
    const balance = ((data.balance || {})[key]) || [];
    const cash = ((data.cash || {})[key]) || [];
    const pick = (list, target) => {
        if (!list.length) return {};
        const exact = list.find((r) => r.fiscalDateEnding === target);
        if (exact) return exact;
        if(data.provenance)return {};
        let best = null;
        for (const row of list) {
            const d = dayDiff(row.fiscalDateEnding, target);
            if (d <= 14 && (!best || d < best.d)) best = { d, row };
        }
        return best ? best.row : {};
    };
    return income
        .filter((r) => r && r.fiscalDateEnding)
        .map((row) => ({
            period_end: isoDay(row.fiscalDateEnding),
            currency: String(row.reportedCurrency || (data.overview && data.overview.Currency) || 'USD').toUpperCase(),
            income: row,
            balance: pick(balance, row.fiscalDateEnding),
            cash: pick(cash, row.fiscalDateEnding)
        }))
        .sort((a, b) => (a.period_end < b.period_end ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Metric catalog
// ---------------------------------------------------------------------------
// ids are the stable public contract; aliases are accepted on input so the
// model does not have to know the canonical spelling.
const METRICS = {
    revenue: { label: 'Revenue', units: 'USD', statement: 'income', field: 'totalRevenue', aliases: ['revenues', 'total_revenue', 'sales', 'net_sales', 'totalRevenue'] },
    cost_of_revenue: { label: 'Cost of revenue', units: 'USD', statement: 'income', field: 'costOfRevenue', aliases: ['cogs', 'cost_of_goods_sold', 'costOfRevenue'] },
    gross_profit: { label: 'Gross profit', units: 'USD', statement: 'income', field: 'grossProfit', aliases: ['grossProfit'] },
    research_and_development: { label: 'Research and development expense', units: 'USD', statement: 'income', field: 'researchAndDevelopment' },
    selling_general_and_administrative: { label: 'Selling, general and administrative expense', units: 'USD', statement: 'income', field: 'sellingGeneralAndAdministrative', aliases: ['sga', 'sg_and_a'] },
    operating_expenses: { label: 'Operating expenses', units: 'USD', statement: 'income', field: 'operatingExpenses' },
    operating_income: { label: 'Operating income', units: 'USD', statement: 'income', field: 'operatingIncome', aliases: ['operatingIncome'] },
    interest_expense: { label: 'Interest expense', units: 'USD', statement: 'income', field: 'interestExpense', aliases: ['interestExpense'] },
    other_non_operating_income: { label: 'Other non-operating income (expense)', units: 'USD', statement: 'income', field: 'otherNonOperatingIncome' },
    income_before_tax: { label: 'Income before income taxes', units: 'USD', statement: 'income', field: 'incomeBeforeTax', aliases: ['pretax_income', 'incomeBeforeTax'] },
    income_tax_expense: { label: 'Income tax expense', units: 'USD', statement: 'income', field: 'incomeTaxExpense', aliases: ['tax_expense', 'incomeTaxExpense', 'provision_for_income_taxes'] },
    net_income: { label: 'Net income', units: 'USD', statement: 'income', field: 'netIncome', aliases: ['net_income_loss', 'netIncome', 'earnings'] },
    basic_eps: { label: 'Basic earnings per share', units: 'USD_per_share', statement: 'income', field: 'eps', aliases: ['basicEPS', 'eps'] },
    diluted_eps: { label: 'Diluted earnings per share', units: 'USD_per_share', statement: 'income', field: 'dilutedEPS', aliases: ['dilutedEPS', 'eps_diluted'] },
    operating_cash_flow: { label: 'Net cash provided by operating activities', units: 'USD', statement: 'cash', field: 'operatingCashflow', aliases: ['ocf', 'cash_from_operations', 'operatingCashFlow'] },
    capital_expenditure: { label: 'Capital expenditure (as reported; usually a negative outflow)', units: 'USD', statement: 'cash', field: 'capitalExpenditures', aliases: ['capex', 'capital_expenditures'] },
    depreciation_and_amortization: { label: 'Depreciation and amortization', units: 'USD', statement: 'cash', field: 'depreciationDepletionAndAmortization' },
    stock_based_compensation: { label: 'Stock-based compensation', units: 'USD', statement: 'cash', field: 'shareBasedCompensation', aliases: ['sbc', 'share_based_compensation'] },
    share_repurchases: { label: 'Payments to repurchase common stock', units: 'USD', statement: 'cash', field: 'paymentsForRepurchaseOfCommonStock', aliases: ['buybacks', 'share_repurchase'] },
    dividends_paid: { label: 'Cash dividends paid', units: 'USD', statement: 'cash', field: 'dividendPayout', aliases: ['dividends'] },
    cash_and_equivalents: { label: 'Cash and cash equivalents', units: 'USD', statement: 'balance', field: 'cashAndCashEquivalentsAtCarryingValue', aliases: ['cash_and_cash_equivalents'] },
    cash_and_short_term_investments: { label: 'Cash, cash equivalents and short-term investments', units: 'USD', statement: 'balance', field: 'cashAndShortTermInvestments' },
    long_term_debt: { label: 'Long-term debt', units: 'USD', statement: 'balance', field: 'longTermDebt' },
    total_debt: { label: 'Total debt (short and long term, as reported)', units: 'USD', statement: 'balance', field: 'shortLongTermDebtTotal', aliases: ['debt'] },
    total_assets: { label: 'Total assets', units: 'USD', statement: 'balance', field: 'totalAssets' },
    total_liabilities: { label: 'Total liabilities', units: 'USD', statement: 'balance', field: 'totalLiabilities' },
    total_equity: { label: 'Total shareholders\u2019 equity', units: 'USD', statement: 'balance', field: 'totalShareholderEquity', aliases: ['shareholders_equity', 'stockholders_equity'] },
    shares_outstanding: { label: 'Common shares outstanding (balance-sheet date)', units: 'shares', statement: 'balance', field: 'commonStockSharesOutstanding', aliases: ['shares'] }
};

// Derived metrics compute from reported fields in the same period. They carry
// `derived_from` so the response says exactly which line items produced them.
const DERIVED = {
    free_cash_flow: {
        label: 'Free cash flow (operating cash flow minus capital expenditure)',
        units: 'USD',
        derived_from: ['operating_cash_flow', 'capital_expenditure'],
        compute: (r) => {
            const ocf = num((r.cash || {}).operatingCashflow);
            const capex = num((r.cash || {}).capitalExpenditures);
            return ocf !== null && capex !== null ? ocf - Math.abs(capex) : null;
        }
    },
    gross_margin: {
        label: 'Gross margin', units: 'percent', derived_from: ['gross_profit', 'revenue'],
        compute: (r) => ratioPct(num((r.income || {}).grossProfit), num((r.income || {}).totalRevenue))
    },
    operating_margin: {
        label: 'Operating margin', units: 'percent', derived_from: ['operating_income', 'revenue'],
        compute: (r) => ratioPct(num((r.income || {}).operatingIncome), num((r.income || {}).totalRevenue))
    },
    net_margin: {
        label: 'Net margin', units: 'percent', derived_from: ['net_income', 'revenue'],
        compute: (r) => ratioPct(num((r.income || {}).netIncome), num((r.income || {}).totalRevenue))
    },
    free_cash_flow_margin: {
        label: 'Free-cash-flow margin', units: 'percent', derived_from: ['free_cash_flow', 'revenue'],
        compute: (r) => ratioPct(DERIVED.free_cash_flow.compute(r), num((r.income || {}).totalRevenue))
    },
    // A filed fourth-quarter weighted-average share count does not exist: the
    // 10-K reports the full-year average and the 10-Qs report the first three
    // quarters. Where a caller needs a complete quarterly series, this metric is
    // the arithmetic implication of two reported figures and is labelled as
    // derived. It is never substituted for the filed value of diluted_shares.
    implied_diluted_shares: {
        label: 'Implied diluted shares (net income divided by diluted EPS)',
        units: 'shares', derived_from: ['net_income', 'diluted_eps'],
        compute: (r) => {
            const ni = num((r.income || {}).netIncome);
            const eps = num((r.income || {}).dilutedEPS);
            return ni !== null && eps ? Math.round(ni / eps) : null;
        }
    }
};

// A metric that needs the SEC XBRL share history rather than the cache.
const XBRL_METRICS = {
    diluted_shares: {
        label: 'Diluted weighted-average shares outstanding',
        units: 'shares',
        concept: 'WeightedAverageNumberOfDilutedSharesOutstanding'
    },
    basic_shares: {
        label: 'Basic weighted-average shares outstanding',
        units: 'shares',
        concept: 'WeightedAverageNumberOfSharesOutstandingBasic'
    }
};

const ALL_METRIC_IDS = [
    ...Object.keys(METRICS),
    ...Object.keys(DERIVED),
    ...Object.keys(XBRL_METRICS),
    'revenue_growth',
    'diluted_eps_growth'
];

const ALIAS_TO_ID = (() => {
    const map = new Map();
    for (const id of ALL_METRIC_IDS) map.set(id.toLowerCase(), id);
    for (const [id, def] of Object.entries(METRICS)) for (const a of def.aliases || []) map.set(a.toLowerCase(), id);
    map.set('free_cash_flow_yoy_growth', 'free_cash_flow');
    return map;
})();

function resolveMetricId(raw) {
    const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ALIAS_TO_ID.get(key) || null;
}

function metricDef(id) {
    if (METRICS[id]) return { id, kind: 'reported', ...METRICS[id] };
    if (DERIVED[id]) return { id, kind: 'derived', ...DERIVED[id] };
    if (XBRL_METRICS[id]) return { id, kind: 'xbrl', ...XBRL_METRICS[id] };
    if (id === 'revenue_growth' || id === 'diluted_eps_growth') {
        return { id, kind: 'derived', units: 'percent', label: id === 'revenue_growth' ? 'Revenue growth, year over year' : 'Diluted EPS growth, year over year', derived_from: [id.replace('_growth', '')] };
    }
    return null;
}

function resolveMetrics(rawList) {
    const list = Array.isArray(rawList) && rawList.length ? rawList : ['revenue', 'net_income', 'diluted_eps'];
    const out = [];
    const unknown = [];
    for (const raw of list.slice(0, 12)) {
        const id = resolveMetricId(raw);
        if (!id) { unknown.push(String(raw)); continue; }
        if (!out.includes(id)) out.push(id);
    }
    if (unknown.length) {
        throw mcpError('UNSUPPORTED_METRIC', `Unsupported metric: ${unknown.join(', ')}.`, { supported_metrics: ALL_METRIC_IDS });
    }
    return out;
}

function ratioPct(numerator, denominator) {
    if (numerator === null || denominator === null || denominator <= 0) return null;
    return round((numerator / denominator) * 100, 4);
}

function rowValue(id, row) {
    const def = metricDef(id);
    if (!def) return null;
    if (def.kind === 'reported') return num((row[def.statement] || {})[def.field]);
    if (def.kind === 'derived') {
        if (id === 'revenue_growth') return null; // filled by the series builder
        if (id === 'diluted_eps_growth') return null;
        return def.compute(row);
    }
    return null; // xbrl metrics are filled by the series builder
}

function priorRowFor(rows, index, periodType) {
    const current=rows[index];
    return rows.find(r=>r.period_end<current.period_end && r.currency===current.currency && Math.abs((Date.parse(current.period_end)-Date.parse(r.period_end))/86400000-365.2425)<=14) || null;
}

// ---------------------------------------------------------------------------
// SEC filing index (accessions, report dates, URLs) — Mongo + memory cached
// ---------------------------------------------------------------------------
const PERIODIC_FORMS = ['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A', '8-K', '8-K/A', 'DEF 14A', '6-K'];
const _filingMemo = new Map();

function secIndexCollection() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.collection('sec_filing_index');
}

function filingIndexFromDoc(doc) {
    if (!doc || !Array.isArray(doc.filings)) return null;
    return { symbol: doc._id, cik: doc.cik, fetchedAt: doc.fetchedAt, filings: doc.filings };
}

function parseSubmissions(symbol, cik, payload) {
    const recent = payload && payload.filings && payload.filings.recent;
    if (!recent || !Array.isArray(recent.accessionNumber)) return [];
    const cikNum = Number(cik);
    const caps = { '10-K': 10, '10-Q': 24, '8-K': 15, 'DEF 14A': 3, '6-K': 6, '20-F': 8, '40-F': 8 };
    const counts = {};
    const out = [];
    for (let i = 0; i < recent.accessionNumber.length; i++) {
        const form = String(recent.form && recent.form[i] || '');
        if (!PERIODIC_FORMS.includes(form)) continue;
        const family = form.startsWith('10-K') ? '10-K' : form.startsWith('10-Q') ? '10-Q' : form.startsWith('20-F') ? '20-F' : form.startsWith('40-F') ? '40-F' : form;
        if ((counts[family] || 0) >= (caps[family] || 4)) continue;
        counts[family] = (counts[family] || 0) + 1;
        const accession = String(recent.accessionNumber[i] || '');
        const doc = String(recent.primaryDocument && recent.primaryDocument[i] || '');
        const noDash = accession.replace(/-/g, '');
        out.push({
            form,
            filing_date: isoDay(recent.filingDate && recent.filingDate[i]),
            report_date: isoDay(recent.reportDate && recent.reportDate[i]),
            accession_number: accession,
            primary_document: doc || null,
            description: String(recent.primaryDocDescription && recent.primaryDocDescription[i] || '') || null,
            url: doc
                ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${noDash}/${doc}`
                : `https://www.sec.gov/Archives/edgar/data/${cikNum}/${noDash}/${accession}-index.htm`
        });
    }
    return out.sort((a, b) => (a.filing_date < b.filing_date ? 1 : -1));
}

async function cikFor(symbol) {
    const local = companyCatalog().get(symbol);
    if (local && local.cik) return local.cik;
    try { return await secSource.cikFor(symbol); } catch (_) { return null; }
}

async function getFilingIndex(symbol) {
    const memo = memoGet(_filingMemo, symbol);
    if (memo) return memo.value;
    const col = secIndexCollection();
    let cik = await cikFor(symbol);
    if (!cik) throw mcpError('COMPANY_NOT_FOUND', `No SEC filer record was found for ${symbol}.`);
    if (col) {
        try {
            const doc = await col.findOne({ _id: symbol });
            if (doc && doc.fetchedAt && Date.now() - new Date(doc.fetchedAt).getTime() < FILING_TTL_MS) {
                const value = filingIndexFromDoc(doc);
                if (value) { memoSet(_filingMemo, symbol, value, FILING_TTL_MS); return value; }
            }
        } catch (_) { /* cache is best-effort */ }
    }
    let payload;
    try {
        const r = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
            headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 30e6
        });
        payload = r.data;
    } catch (_) {
        // A cold cache plus an SEC outage must degrade to "no filing metadata",
        // not fail the financials call: values are already served from the
        // local cache. The caller sees source: null with an honest note.
        const empty = { symbol, cik, fetchedAt: new Date(), filings: [] };
        memoSet(_filingMemo, symbol, empty, 5 * 60 * 1000);
        return empty;
    }
    const value = { symbol, cik, fetchedAt: new Date(), filings: parseSubmissions(symbol, cik, payload) };
    memoSet(_filingMemo, symbol, value, FILING_TTL_MS);
    if (col) {
        try { await col.updateOne({ _id: symbol }, { $set: { cik, fetchedAt: value.fetchedAt, filings: value.filings } }, { upsert: true }); } catch (_) { /* best-effort */ }
    }
    return value;
}

function sourceForPeriod(index, periodEnd, periodType) {
    if (!index || !index.filings || !index.filings.length || !periodEnd) return null;
    const formRe = periodType === 'quarterly' ? /^10-Q/ : /^(10-K|20-F|40-F)/;
    const candidates = index.filings.filter((f) => formRe.test(f.form) && f.report_date);
    if (!candidates.length) return null;
    let best = null;
    for (const f of candidates) {
        const d = dayDiff(f.report_date, periodEnd);
        if (d > 21) continue;
        if (!best || d < best.d || (d === best.d && f.filing_date > best.f.filing_date)) best = { d, f };
    }
    if (!best) return null;
    const f = best.f;
    return {
        type: 'sec_filing',
        form: f.form,
        filing_date: f.filing_date || null,
        report_date: f.report_date || null,
        accession_number: f.accession_number,
        url: f.url,
        linkage: 'filing_period'
    };
}

function shareSourceForFact(fact, cik) {
    if (!fact || !fact.accn) return null;
    const noDash = String(fact.accn).replace(/-/g, '');
    return {
        type: 'sec_xbrl_fact',
        form: fact.form || null,
        filing_date: isoDay(fact.filed),
        report_date: isoDay(fact.end),
        accession_number: fact.accn,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${noDash}/${fact.accn}-index.htm`,
        linkage: 'xbrl_fact'
    };
}

// ---------------------------------------------------------------------------
// Diluted/basic weighted-average share history — SEC XBRL, Mongo + memory
// ---------------------------------------------------------------------------
const _sharesMemo = new Map();
const SHARE_CONCEPTS = [
    ['diluted', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
    ['diluted', 'WeightedAverageNumberOfDilutedSharesOutstandingBasicAndDiluted'],
    ['basic', 'WeightedAverageNumberOfSharesOutstandingBasic']
];

function shareCollection() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.collection('sec_share_history');
}

async function fetchConceptRows(cik, concept) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;
    const r = await axios.get(url, { headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 20e6 });
    const units = (r.data && r.data.units) || {};
    const arr = units.shares || Object.values(units)[0] || [];
    const out = [];
    for (const row of arr) {
        const end = isoDay(row.end);
        if (!end || !Number.isFinite(Number(row.val))) continue;
        const start = isoDay(row.start);
        out.push({
            start: start || null,
            end,
            days: start ? Math.round(dayDiff(end, start)) : null,
            val: Number(row.val),
            accn: row.accn || null,
            form: row.form || null,
            filed: isoDay(row.filed),
            fy: row.fy || null,
            fp: row.fp || null
        });
    }
    return out;
}

async function getShareHistory(symbol) {
    const memo = memoGet(_sharesMemo, symbol);
    if (memo) return memo.value;
    const cik = await cikFor(symbol);
    if (!cik) return { symbol, cik: null, fetchedAt: new Date(), facts: [] };
    const col = shareCollection();
    if (col) {
        try {
            const doc = await col.findOne({ _id: symbol });
            if (doc && doc.fetchedAt && Date.now() - new Date(doc.fetchedAt).getTime() < SHARES_TTL_MS) {
                const value = { symbol, cik, fetchedAt: doc.fetchedAt, facts: doc.facts || [] };
                memoSet(_sharesMemo, symbol, value, SHARES_TTL_MS);
                return value;
            }
        } catch (_) { /* best-effort */ }
    }
    let facts = [];
    let basis = 'diluted';
    for (const [candidateBasis, concept] of SHARE_CONCEPTS) {
        try {
            facts = await fetchConceptRows(cik, concept);
        } catch (_) { facts = []; }
        if (facts.length) { basis = candidateBasis; break; }
    }
    const value = { symbol, cik, fetchedAt: new Date(), basis, facts };
    memoSet(_sharesMemo, symbol, value, SHARES_TTL_MS);
    if (col) {
        try { await col.updateOne({ _id: symbol }, { $set: { cik, basis, fetchedAt: value.fetchedAt, facts } }, { upsert: true }); } catch (_) { /* best-effort */ }
    }
    return value;
}

function shareFactFor(history, periodEnd, periodType) {
    if (!history || !history.facts || !history.facts.length || !periodEnd) return null;
    const wantAnnual = periodType !== 'quarterly';
    let best = null;
    for (const fact of history.facts) {
        if (!fact.val) continue;
        const isAnnual = fact.days !== null && fact.days >= 330 && fact.days <= 380;
        const isQuarter = fact.days !== null && fact.days >= 80 && fact.days <= 100;
        if (wantAnnual && !isAnnual) continue;
        if (!wantAnnual && !isQuarter) continue;
        const d = dayDiff(fact.end, periodEnd);
        if (d > 21) continue;
        if (!best || d < best.d || (d === best.d && String(fact.filed) > String(best.fact.filed))) best = { d, fact };
    }
    return best ? best.fact : null;
}

// ---------------------------------------------------------------------------
// Series builder
// ---------------------------------------------------------------------------
function sourceRefsForMetric(data,row,id,seen=new Set()) {
    if(seen.has(id))return [];seen.add(id);
    const def=metricDef(id);if(!def)return [];
    if(def.kind==='reported')return require('./verified-fundamentals').sourcesFor(data,row[def.statement],def.field).map(s=>({...s,filing_date:s.filingDate,report_date:s.periodEnd,accession_number:s.accessionNumber,url:s.filingUrl}));
    return (def.derived_from || []).flatMap(base=>sourceRefsForMetric(data,row,base,seen));
}

async function buildSeries(symbol, metricIds, periodType, opts = {}) {
    const start=opts.startPeriod?isoDay(opts.startPeriod):null,end=opts.endPeriod?isoDay(opts.endPeriod):null;
    if(opts.startPeriod && !start)throw mcpError('INVALID_PERIOD','start_period must be an ISO date (YYYY-MM-DD).');
    if(opts.endPeriod && !end)throw mcpError('INVALID_PERIOD','end_period must be an ISO date (YYYY-MM-DD).');
    if(start && end && start>end)throw mcpError('INVALID_PERIOD','start_period must be on or before end_period.');
    const count=Math.min(Math.max(Number(opts.periods) || (periodType==='quarterly'?8:5),1),20);
    const listing=require('./stock-universe').lookup(symbol);
    if(listing && listing.securityType !== 'stock') throw mcpError('UNSUPPORTED_SECURITY_TYPE','Company financial analysis is unavailable for this instrument.');
    const online=process.env.SEC_COVERAGE_DISABLE_ON_DEMAND!=='1' && process.env.SEC_COVERAGE_READ_ONLY!=='1';
    const fieldsFor=id=>{const def=metricDef(id);return def?.field?[def.field]:(def?.derived_from || []).flatMap(fieldsFor);};
    const requiredFields=[...new Set(metricIds.flatMap(fieldsFor))];
    const data=online?(await require('./verified-fundamentals').getCompanyEvidence(symbol,requiredFields.length?requiredFields:undefined,{annual:periodType==='annual'?(opts.periods || 5):0,quarterly:periodType==='quarterly'?(opts.periods || 4):0})).data:loadFundamentals(symbol);
    if (!data) throw mcpError('COMPANY_NOT_FOUND', `No normalized filing data is available for ${symbol}.`);
    const overview = overviewOf(symbol, data);
    const rows = periodRows(data, periodType);
    if (!rows.length) {
        const supplemental=data.supplementalObservations || [],observations=[];
        for(const id of metricIds){const def=metricDef(id);if(!def?.field)continue;for(const f of supplemental.filter(f=>f.field===def.field && (f.historyBasis || f.basis)===periodType && f.state==='available' && (!start || f.periodEnd>=start) && (!end || f.periodEnd<=end)).sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd)).slice(0,count))observations.push({metric:id,label:def.label,period_type:periodType,period_end:f.periodEnd,value:f.value,units:f.unit,currency:f.currency,derived_from:null,source:{type:'supplemental',linkage:'attributed_provider_observation',source_name:f.sourceName,source_type:f.sourceType,url:f.sourceUrl,source_date:f.publicationDate || f.sourceDataDate,retrieved_at:f.retrievedAt,accounting_basis:f.accountingBasis},verification:'attributed_supplemental'});}
        if(observations.length)return {overview,observations,currency:new Set(observations.map(f=>f.currency)).size===1?observations[0].currency:null,periodType,totalPeriods:new Set(observations.map(f=>f.period_end)).size,coverage:data.coverage,freshness:data.freshness,supplementalObservations:supplemental};
        throw mcpError('VERIFIED_FINANCIALS_UNAVAILABLE', `No compatible ${periodType} financial observations are available for ${symbol}.`,{coverage:data.coverage,freshness:data.freshness});
    }

    let selected = rows;
    if (opts.startPeriod) {
        const start = isoDay(opts.startPeriod);
        if (!start) throw mcpError('INVALID_PERIOD', 'start_period must be an ISO date (YYYY-MM-DD).');
        selected = selected.filter((r) => r.period_end >= start);
    }
    if (opts.endPeriod) {
        const end = isoDay(opts.endPeriod);
        if (!end) throw mcpError('INVALID_PERIOD', 'end_period must be an ISO date (YYYY-MM-DD).');
        selected = selected.filter((r) => r.period_end <= end);
    }
    selected = selected.slice(0, count);
    if (!selected.length) throw mcpError('INVALID_PERIOD', 'No periods matched the requested date range.');

    const needsIndex = metricIds.some((id) => METRICS[id] || DERIVED[id] || id.endsWith('_growth'));
    const needsShares = metricIds.some((id) => XBRL_METRICS[id]);
    const [index, shares] = await Promise.all([
        needsIndex && !data.provenance ? getFilingIndex(symbol).catch(() => null) : Promise.resolve(null),
        needsShares && !data.provenance && data.coverage?.perShareAllowed ? getShareHistory(symbol).catch(() => null) : Promise.resolve(null)
    ]);

    const observations = [];
    for (let i = 0; i < selected.length; i++) {
        const row = selected[i];
        const source = data.provenance ? null : sourceForPeriod(index, row.period_end, periodType);
        for (const id of metricIds) {
            const def = metricDef(id);
            let value;
            let sourceOverride = null;
            let derivedFrom = def.derived_from || null;
            if (XBRL_METRICS[id]) {
                if(data.provenance){const field=id==='diluted_shares'?'weightedAverageSharesDiluted':'weightedAverageSharesOutstanding';value=num(row.income[field]);const ref=row.income._sources?.[field]?.[0];sourceOverride=ref?data.provenance.sources[ref]:null;if(sourceOverride)sourceOverride={...sourceOverride,filing_date:sourceOverride.filingDate,report_date:sourceOverride.periodEnd,accession_number:sourceOverride.accessionNumber,url:sourceOverride.filingUrl};}else{const fact=shareFactFor(shares,row.period_end,periodType);value=fact?fact.val:null;sourceOverride=shareSourceForFact(fact,shares && shares.cik);}
            } else if (id === 'revenue_growth' || id === 'diluted_eps_growth') {
                const baseId = id === 'revenue_growth' ? 'revenue' : 'diluted_eps';
                const prior = priorRowFor(rows, rows.indexOf(row), periodType);
                value = prior ? pctChange(rowValue(baseId, row), rowValue(baseId, prior)) : null;
                derivedFrom = [baseId];
            } else {
                value = rowValue(id, row);
            }
            let exactSource=sourceOverride || source;
            if(data.provenance && !XBRL_METRICS[id]) {
                const refs=sourceRefsForMetric(data,row,id);
                const prior=(id==='revenue_growth' || id==='diluted_eps_growth')?priorRowFor(rows,rows.indexOf(row),periodType):null;
                if(prior) refs.push(...sourceRefsForMetric(data,prior,id==='revenue_growth'?'revenue':'diluted_eps'));
                if(!refs.length) value=null;
                const unique=[...new Map(refs.map(x=>[JSON.stringify(x),x])).values()];
                if(unique.length) exactSource=!derivedFrom && !row[def.statement]?._derivations?.[def.field] && unique.length===1 ? unique[0] : {type:'calculated',linkage:'derived_from_facts',inputs:unique};
            }
            const observation = {
                metric: id,
                label: def.label,
                period_type: periodType,
                period_end: row.period_end,
                value: value === null || value === undefined ? null : round(value, 6),
                units: def.units === 'USD' ? row.currency : def.units === 'USD_per_share' ? row.currency+'_per_share' : def.units,
                currency: def.units === 'USD' || def.units === 'USD_per_share' ? row.currency : null,
                derived_from: derivedFrom,
                source: value === null || value === undefined ? null : exactSource
            };
            if (observation.value === null && XBRL_METRICS[id]) {
                observation.note = `No discrete ${periodType === 'quarterly' ? 'quarterly' : 'annual'} weighted-average share count was tagged for this period. A fourth fiscal quarter is normally reported only inside the annual filing, so no filed value exists for it.`;
            }
            observations.push(observation);
        }
    }
    return { overview, observations, currency: rows[0].currency, periodType,totalPeriods:rows.length,coverage:data.coverage,freshness:data.freshness,supplementalObservations:data.supplementalObservations || [] };
}

function groupObservations(observations, order) {
    const byMetric = new Map();
    for (const obs of observations) {
        if (!byMetric.has(obs.metric)) byMetric.set(obs.metric, []);
        byMetric.get(obs.metric).push(obs);
    }
    const out = [];
    for (const [metric, list] of byMetric) {
        const sorted = list.slice().sort((a, b) => (order === 'oldest_first'
            ? (a.period_end < b.period_end ? -1 : 1)
            : (a.period_end < b.period_end ? 1 : -1)));
        const def = metricDef(metric);
        out.push({
            metric,
            label: def.label,
            units: sorted[0]?.units || def.units,
            observations: sorted
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Public API used by mcp-apps.js
// ---------------------------------------------------------------------------
async function companyFinancials({ company, metrics, periodType, periods, startPeriod, endPeriod }) {
    const resolved = await resolveCompany(company);
    const metricIds = resolveMetrics(metrics);
    const type = periodType === 'quarterly' ? 'quarterly' : 'annual';
    const built = await buildSeries(resolved.ticker, metricIds, type, { periods, startPeriod, endPeriod });
    return {
        company: {
            ticker: resolved.ticker,
            name: resolved.name || built.overview.name,
            cik: resolved.cik || built.overview.cik,
            exchange: built.overview.exchange,
            currency: built.currency
        },
        coverage:built.coverage,freshness:built.freshness,supplementalObservations:built.supplementalObservations || [],
        period_type: type,
        order: 'most_recent_first',
        metrics: groupObservations(built.observations, 'most_recent_first')
    };
}

async function metricHistory({ company, metric, periodType, periods }) {
    const resolved = await resolveCompany(company);
    const metricIds = resolveMetrics([metric]);
    const type = periodType === 'quarterly' ? 'quarterly' : 'annual';
    const built = await buildSeries(resolved.ticker, metricIds, type, { periods: periods || (type === 'quarterly' ? 8 : 5) });
    const series = groupObservations(built.observations, 'oldest_first')[0];
    return {
        company: {
            ticker: resolved.ticker,
            name: resolved.name || built.overview.name,
            cik: resolved.cik || built.overview.cik,
            exchange: built.overview.exchange,
            currency: built.currency
        },
        coverage: built.coverage,
        metric: series.metric,
        label: series.label,
        units: series.units,
        period_type: type,
        order: 'oldest_first',
        observations: series.observations
    };
}

async function compareCompanyMetrics({ companies, metrics, periodType, periods }) {
    const list = Array.isArray(companies) ? companies.filter((c) => String(c || '').trim()) : [];
    if (list.length < 2) throw mcpError('TOO_FEW_COMPANIES', 'Provide between 2 and 5 companies to compare.');
    if (list.length > 5) throw mcpError('TOO_MANY_COMPANIES', 'At most 5 companies can be compared in one call.', { requested: list.length, maximum: 5 });
    const metricIds = resolveMetrics(metrics);
    const type = periodType === 'quarterly' ? 'quarterly' : 'annual';
    const count = periods || 1;
    if (count < 1 || count > 5) throw mcpError('INVALID_PERIOD', 'periods must be between 1 and 5 for a comparison.');
    const resolved = [];
    for (const item of list) resolved.push(await resolveCompany(item));
    const built = [];
    for (const company of resolved) {
        built.push({ company, series: await buildSeries(company.ticker, metricIds, type, { periods: count }) });
    }
    // Alignment warning: same-type fiscal periods more than a month apart are
    // comparable as periods but not simultaneous, and the model must say so.
    // The spread is the widest gap between any two companies, not the gap
    // between whichever two the caller happened to list first and last: a peer
    // set whose extreme dates sit in the middle of the list would otherwise
    // report no misalignment at all and skip the warning entirely.
    const ends = built.map((b) => b.series.observations.filter((o) => o.metric === metricIds[0]).map((o) => Date.parse(o.period_end)));
    const firstEnds = ends.map((e) => e[0]).filter((t) => Number.isFinite(t));
    const spreadDays = firstEnds.length > 1 ? Math.round((Math.max(...firstEnds) - Math.min(...firstEnds)) / DAY) : 0;
    return {
        period_type: type,
        order: 'most_recent_first',
        companies: built.map((b) => ({
            ticker: b.company.ticker,
            name: b.company.name || b.series.overview.name,
            cik: b.company.cik || b.series.overview.cik,
            exchange: b.series.overview.exchange,
            currency: b.series.currency
        })),
        // Every company's observations land in one series per metric, so each
        // observation has to name the company it belongs to. Without the tag the
        // series is a column of numbers ordered by date, and the owner of a value
        // can only be recovered by resolving the CIK inside its filing URL.
        metrics: groupObservations(
            built.flatMap((b) => b.series.observations.map((o) => ({ ...o, ticker: b.company.ticker }))),
            'most_recent_first'
        ),
        notes: spreadDays > 31
            ? [`The companies report different fiscal period-end dates (up to ${spreadDays} days apart). Periods are labelled separately and are not simultaneous.`]
            : []
    };
}

async function searchFilings({ company, forms, startDate, endDate, query, limit }) {
    const resolved = await resolveCompany(company);
    const index = await getFilingIndex(resolved.ticker);
    if (!index.filings || !index.filings.length) {
        throw mcpError('FILING_NOT_FOUND', `No recent SEC filings were found for ${resolved.ticker}.`);
    }
    const wanted = Array.isArray(forms) && forms.length
        ? forms.map((f) => String(f).trim().toUpperCase()).filter(Boolean)
        : null;
    const q = String(query || '').trim().toLowerCase();
    const start = isoDay(startDate);
    const end = isoDay(endDate);
    if (startDate && !start) throw mcpError('INVALID_PERIOD', 'start_date must be an ISO date (YYYY-MM-DD).');
    if (endDate && !end) throw mcpError('INVALID_PERIOD', 'end_date must be an ISO date (YYYY-MM-DD).');
    let rows = index.filings;
    if (wanted) rows = rows.filter((f) => wanted.some((w) => f.form === w || f.form.startsWith(`${w}/`)));
    if (start) rows = rows.filter((f) => f.filing_date >= start);
    if (end) rows = rows.filter((f) => f.filing_date <= end);
    if (q) {
        rows = rows.filter((f) => String(f.form).toLowerCase().includes(q)
            || String(f.description || '').toLowerCase().includes(q)
            || String(f.report_date || '').includes(q));
    }
    const max = Math.min(Math.max(Number(limit) || 10, 1), 25);
    return {
        company: { ticker: resolved.ticker, name: resolved.name, cik: resolved.cik || index.cik },
        match_count: rows.length,
        filings: rows.slice(0, max).map((f) => ({
            form: f.form,
            filing_date: f.filing_date,
            report_date: f.report_date || null,
            accession_number: f.accession_number,
            description: f.description,
            source_url: f.url
        }))
    };
}

// Filing text: reuses the existing Mongo filing_text cache (same collection
// and shape filing-fetcher.js writes) and the filing-sections converter, which
// keeps words intact — the section anchors depend on that.
async function fetchFilingText(symbol, filing) {
    const accession = String(filing.accession_number || filing.accession || '').trim();
    // readyState guard, not just try/catch: calling .findOne() on a buffering
    // Mongoose connection blocks for bufferTimeoutMS (10s) before failing, and
    // this sits on the hot path of every filing-content call.
    const col = mongoose.connection.readyState === 1 ? mongoose.connection.collection('filing_text') : null;
    if (col && accession) {
        try {
            const hit = await col.findOne({ symbol, accession });
            if (hit && hit.text) {
                return { symbol, form: hit.form || filing.form, date: hit.date || filing.filing_date || null, url: hit.url || filing.url, accession, text: hit.text };
            }
        } catch (_) { /* best-effort */ }
    }
    let text;
    try {
        const r = await axios.get(filing.url, { headers: secSource.SEC_HEADERS, timeout: 35000, maxContentLength: 40e6, responseType: 'text' });
        text = filingSections.htmlToText(r.data).slice(0, FILING_MAX_CHARS);
    } catch (_) {
        throw mcpError('UPSTREAM_DATA_ERROR', 'The SEC filing could not be retrieved right now. Try again shortly.');
    }
    if (!text || text.length < 500) throw mcpError('UPSTREAM_DATA_ERROR', 'The SEC filing text could not be read.');
    if (col && accession) {
        try {
            await col.updateOne({ symbol, accession, form: filing.form }, { $set: { symbol, accession, form: filing.form, date: filing.filing_date || null, url: filing.url, text, at: new Date() } }, { upsert: true });
        } catch (_) { /* best-effort */ }
    }
    return { symbol, form: filing.form, date: filing.filing_date || null, url: filing.url, accession, text };
}

// Resolves the filing to read: one exact accession, or the most recent filing
// of a requested form. For an annual request the whole annual-report family is
// accepted, matching filing-fetcher's behaviour for 20-F/40-F issuers.
async function resolveFiling(symbol, accession, form) {
    if (accession) {
        const normalized = String(accession).trim();
        if (!/^[0-9-]{10,25}$/.test(normalized)) throw mcpError('FILING_NOT_FOUND', 'accession_number must look like 0000320193-25-000079.');
        const index = await getFilingIndex(symbol).catch(() => null);
        let filing = index && index.filings.find((f) => f.accession_number === normalized);
        if (!filing) {
            // Deep archive fetch for filings older than the recent window.
            const deep = await require('./watchdog').fetchFilingsDeep(symbol, new Set(PERIODIC_FORMS), { '10-K': 10, '10-Q': 24, '8-K': 15 }).catch(() => null);
            const found = (deep || []).find((f) => f.accession === normalized);
            if (found) filing = { form: found.form, filing_date: found.date, url: found.url, accession_number: found.accession };
        }
        if (!filing || !filing.url) {
            throw mcpError('FILING_NOT_FOUND', `Filing ${normalized} was not found for ${symbol}.`, { hint: 'Use search_filings to list accession numbers.' });
        }
        return filing;
    }
    const index = await getFilingIndex(symbol);
    const wanted = String(form || '10-K').trim().toUpperCase();
    const family = wanted === '10-K' ? ['10-K', '20-F', '40-F'] : [wanted];
    for (const candidate of family) {
        const filing = index.filings.find((f) => f.form === candidate);
        if (filing) return filing;
    }
    throw mcpError('FILING_NOT_FOUND', `No ${wanted} filing was found for ${symbol}.`, { hint: 'Use search_filings to see available forms and accession numbers.' });
}

// Maps a human section name onto the extractor's item keys for this form.
const SECTION_ALIASES = {
    'business': '1', 'item 1': '1', 'item1': '1',
    'risk factors': '1A', 'riskfactors': '1A', 'item 1a': '1A',
    'unresolved comments': '1B',
    'properties': '2',
    'legal proceedings': '3',
    'market for equity': '5', 'market for registrant': '5',
    'mda': '7', "md&a": '7', 'management discussion': '7', 'management discussion and analysis': '7',
    'quantitative risk': '7A', 'quantitative and qualitative disclosures': '7A',
    'financial statements': '8',
    'controls': '9A',
    // 20-F scheme
    'information on the company': '4',
    'operating and financial review': '5',
    'financial information': '8',
    // 20-F keys are matched directly by the keys themselves below
};

function sectionKeyFor(section, profile, availableKeys) {
    const raw = String(section || '').trim();
    if (!raw) return null;
    const keys = availableKeys || profile.keys;
    const upper = raw.toUpperCase();
    if (keys.includes(raw)) return raw;
    if (keys.includes(upper)) return upper;
    const alias = SECTION_ALIASES[raw.toLowerCase()];
    if (alias && keys.includes(alias)) return alias;
    // Match by label, case-insensitively.
    const byLabel = profile.sections.find((s) => s.label.toLowerCase() === raw.toLowerCase());
    if (byLabel && keys.includes(byLabel.key)) return byLabel.key;
    return null;
}

// Decodes the HTML entities the converter leaves behind (numeric references
// and the common named ones) so an excerpt reads as the filing does.
function decodeEntities(value) {
    return String(value || '')
        .replace(/&#(\d+);/g, (match, code) => { try { return String.fromCodePoint(Number(code)); } catch (_) { return match; } })
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return match; } })
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function excerptsFor(text, query, maxExcerpts, maxChars) {
    const needle = String(query).toLowerCase();
    const hay = String(text).toLowerCase();
    const out = [];
    let from = 0;
    while (out.length < maxExcerpts) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        const start = Math.max(0, at - Math.floor(maxChars / 3));
        const end = Math.min(text.length, start + maxChars);
        out.push({ text: decodeEntities(text.slice(start, end)).trim(), char_offset: at });
        from = at + needle.length;
    }
    return out;
}

async function getFilingContent({ company, accessionNumber, form, section, query, maxExcerpts, maxChars }) {
    const resolved = await resolveCompany(company);
    const cik = resolved.cik || await cikFor(resolved.ticker);
    const filing = await resolveFiling(resolved.ticker, accessionNumber, form);
    const doc = await fetchFilingText(resolved.ticker, filing);
    const profile = filingSections.profileFor(doc.form);
    // Extract every section the form profile can locate, not only the core
    // narrative keys, so names such as "Legal Proceedings" or "Financial
    // Statements" are available. Every section keeps its own budget.
    const extracted = filingSections.extractSections(doc.text, { form: doc.form, keys: profile.sections.map((s) => s.key) });
    const available = Object.entries(extracted.sections).map(([key, s]) => ({ key, label: s.label }));
    const availableKeys = available.map((s) => s.key);
    const requestedChars = Math.min(Math.max(Number(maxChars) || 4000, 500), 12000);
    const requestedExcerpts = Math.min(Math.max(Number(maxExcerpts) || 3, 1), 8);

    const base = {
        company: { ticker: resolved.ticker, name: resolved.name, cik },
        filing: {
            form: doc.form,
            filing_date: doc.date || null,
            accession_number: doc.accession || (accessionNumber ? String(accessionNumber) : null),
            source_url: doc.url
        }
    };

    const sectionKey = sectionKeyFor(section, profile, availableKeys);
    if (section && !sectionKey) {
        throw mcpError('UNSUPPORTED_SECTION', `"${section}" is not an extractable section of this ${doc.form}.`, {
            section: String(section),
            available_sections: available
        });
    }
    const targetKey = sectionKey || null;
    const targetText = targetKey ? extracted.sections[targetKey].text : extracted.text;
    const targetLabel = targetKey ? extracted.sections[targetKey].label : null;

    if (query) {
        // Search the extracted narrative first, so an excerpt lands in MD&A or
        // Risk Factors instead of in the inline-XBRL header at the top of the
        // document, where a ticker or segment name also appears as boilerplate.
        let excerpts = [];
        let scope = 'extracted_sections';
        if (targetKey) {
            excerpts = excerptsFor(targetText, query, requestedExcerpts, requestedChars)
                .map((e) => ({ ...e, section: targetKey, section_label: targetLabel }));
        } else {
            for (const s of available) {
                const list = excerptsFor(extracted.sections[s.key].text, query, requestedExcerpts - excerpts.length, requestedChars);
                for (const e of list) excerpts.push({ ...e, section: s.key, section_label: s.label });
                if (excerpts.length >= requestedExcerpts) break;
            }
            if (!excerpts.length) {
                scope = 'full_text';
                excerpts = excerptsFor(extracted.text, query, requestedExcerpts, requestedChars)
                    .map((e) => ({ ...e, section: null, section_label: null }));
            }
        }
        return {
            ...base,
            section: targetKey ? { key: targetKey, label: targetLabel } : null,
            query,
            search_scope: scope,
            match_count: excerpts.length,
            excerpts,
            available_sections: available
        };
    }

    if (targetKey) {
        return {
            ...base,
            section: { key: targetKey, label: targetLabel },
            text: decodeEntities(targetText.slice(0, requestedChars)),
            truncated: targetText.length > requestedChars,
            available_sections: available
        };
    }

    // Neither a section nor a query: return the section map, never the document.
    return {
        ...base,
        available_sections: available,
        note: 'Specify a section name or a search query to retrieve filing text. The full document is never returned.'
    };
}

// Deterministic arithmetic decomposition of a period-over-period change. Every
// input is a reported line item with its own source; the contributions are
// exact algebra, not causal claims, and the response says so.
async function changeDrivers({ company, periodType, periodEnd, compareToPeriodEnd }) {
    const resolved = await resolveCompany(company);
    const type = periodType === 'quarterly' ? 'quarterly' : 'annual';
    const data = loadFundamentals(resolved.ticker);
    if (!data) throw mcpError('COMPANY_NOT_FOUND', `No normalized filing data is available for ${resolved.ticker}.`);
    const rows = periodRows(data, type);
    if (rows.length < 2) throw mcpError('INVALID_PERIOD', `Not enough ${type} periods are available for ${resolved.ticker} to compare.`);
    let currentIndex = 0;
    if (periodEnd) {
        const target = isoDay(periodEnd);
        if (!target) throw mcpError('INVALID_PERIOD', 'period_end must be an ISO date (YYYY-MM-DD).');
        currentIndex = rows.findIndex((r) => dayDiff(r.period_end, target) <= 21);
        if (currentIndex === -1) throw mcpError('INVALID_PERIOD', `No ${type} period near ${periodEnd} was found.`);
    }
    const current = rows[currentIndex];
    let prior;
    if (compareToPeriodEnd) {
        const target = isoDay(compareToPeriodEnd);
        prior = rows.find((r) => dayDiff(r.period_end, target) <= 21);
        if (!prior) throw mcpError('INVALID_PERIOD', `No ${type} period near ${compareToPeriodEnd} was found.`);
    } else {
        prior = priorRowFor(rows, currentIndex, type) || rows[currentIndex + 1];
    }
    if (!prior) throw mcpError('INVALID_PERIOD', 'No comparable prior period is available.');
    const index = data.provenance ? null : await getFilingIndex(resolved.ticker).catch(() => null);
    const sourceCur = sourceForPeriod(index, current.period_end, type);
    const sourcePrior = sourceForPeriod(index, prior.period_end, type);
    const history = data.provenance ? null : await getShareHistory(resolved.ticker).catch(() => null);
    const sharesCurFact = shareFactFor(history, current.period_end, type);
    const sharesPriorFact = shareFactFor(history, prior.period_end, type);
    const sourceCurShares = shareSourceForFact(sharesCurFact, history && history.cik);
    const sourcePriorShares = shareSourceForFact(sharesPriorFact, history && history.cik);
    const impliedCur = data.provenance ? null : DERIVED.implied_diluted_shares.compute(current);
    const impliedPrior = data.provenance ? null : DERIVED.implied_diluted_shares.compute(prior);
    // A filed value always wins; the implied value is a labelled fallback, used
    // only because the fourth fiscal quarter has no separately filed average.
    const shareSide = (filed, implied, source) => (filed !== null
        ? { value: filed, basis: 'filed_diluted_weighted_average', source }
        : implied !== null
            ? { value: implied, basis: 'implied_from_net_income_and_diluted_eps', source }
            : { value: null, basis: null, source: null });
    const shares = {
        current: shareSide(sharesCurFact ? sharesCurFact.val : null, impliedCur, sourceCurShares || sourceCur),
        prior: shareSide(sharesPriorFact ? sharesPriorFact.val : null, impliedPrior, sourcePriorShares || sourcePrior)
    };
    const val = (r, id) => rowValue(id, r);
    const observed = {};
    for (const id of ['revenue', 'cost_of_revenue', 'gross_profit', 'operating_expenses', 'operating_income', 'other_non_operating_income', 'income_before_tax', 'income_tax_expense', 'net_income', 'diluted_eps']) {
        const cur = val(current, id);
        const pri = val(prior, id);
        observed[id] = {
            sources:data.provenance ? {current:sourceRefsForMetric(data,current,id),prior:sourceRefsForMetric(data,prior,id)} : null,
            current: cur, prior: pri,
            change: cur !== null && pri !== null ? round(cur - pri, 6) : null,
            change_pct: pctChange(cur, pri)
        };
    }
    observed.diluted_shares = {
        current: shares.current.value,
        prior: shares.prior.value,
        change: shares.current.value !== null && shares.prior.value !== null ? shares.current.value - shares.prior.value : null,
        change_pct: pctChange(shares.current.value, shares.prior.value),
        current_basis: shares.current.basis,
        prior_basis: shares.prior.basis
    };

    const d = (id) => observed[id].change;
    const component = (driver, amount, formula) => ({
        driver,
        amount: amount === null || !Number.isFinite(amount) ? null : round(amount, 6),
        units: current.currency,
        formula
    });
    const negate = (value) => (value === null ? null : -value);
    // Every step closes exactly. Where the reported line items do not add up on
    // their own (interest income/expense and other non-operating items are not
    // always broken out in the normalized cache), the balancing difference is
    // added as an explicit, named component rather than hidden — a bridge whose
    // components do not sum to its subtotal is worse than no bridge.
    const step = (subtotal, components, residualLabel) => {
        const list = components.filter((c) => c.amount !== null);
        let check = null;
        if (list.length === components.length && subtotal !== null) {
            const sum = list.reduce((acc, c) => acc + c.amount, 0);
            const residual = round(subtotal - sum, 4);
            if (Math.abs(residual) >= 1 && residualLabel) {
                list.push({ driver: residualLabel, amount: residual, units: current.currency, formula: 'reported difference that balances this step (not separately broken out in the normalized data)' });
            }
            check = round(subtotal - list.reduce((acc, c) => acc + c.amount, 0), 4);
        }
        return { change: subtotal, components: list, check };
    };
    const netNonOperatingChange = d('income_before_tax') === null || d('operating_income') === null
        ? null
        : d('income_before_tax') - d('operating_income');
    const bridge = {
        gross_profit: step(d('gross_profit'), [
            component('revenue_change', d('revenue'), 'current revenue minus prior revenue'),
            component('cost_of_revenue_change', negate(d('cost_of_revenue')), 'negative of the change in cost of revenue')
        ], 'other_gross_profit_difference'),
        operating_income: step(d('operating_income'), [
            component('gross_profit_change', d('gross_profit'), 'current gross profit minus prior gross profit'),
            component('operating_expense_change', negate(d('operating_expenses')), 'negative of the change in operating expenses')
        ], 'other_operating_income_difference'),
        income_before_tax: step(d('income_before_tax'), [
            component('operating_income_change', d('operating_income'), 'current operating income minus prior operating income'),
            component('net_non_operating_change', netNonOperatingChange, 'all non-operating items net (interest, other income and expense, equity-method items) as the difference between income before taxes and operating income')
        ], 'other_pretax_difference'),
        net_income: step(d('net_income'), [
            component('income_before_tax_change', d('income_before_tax'), 'current income before taxes minus prior'),
            component('income_tax_change', negate(d('income_tax_expense')), 'negative of the change in income tax expense')
        ], 'other_net_income_difference')
    };

    let epsDecomposition = null;
    const epsCur = val(current, 'diluted_eps');
    const epsPrior = val(prior, 'diluted_eps');
    const niCur = val(current, 'net_income');
    const niPrior = val(prior, 'net_income');
    const sc = shares.current.value;
    const sp = shares.prior.value;
    if ([epsCur, epsPrior, niCur, niPrior, sc, sp].every((v) => Number.isFinite(v) && v !== 0)) {
        const netIncomeEffect = (niCur - niPrior) / sp;
        const shareCountEffect = niCur / sc - niCur / sp;
        epsDecomposition = {
            eps_current: epsCur,
            eps_prior: epsPrior,
            eps_change: round(epsCur - epsPrior, 6),
            net_income_effect: round(netIncomeEffect, 6),
            share_count_effect: round(shareCountEffect, 6),
            share_basis: { current: shares.current.basis, prior: shares.prior.basis },
            method: 'two_factor_decomposition: EPS = net income / diluted weighted-average shares; net-income effect at prior shares, share-count effect at current net income',
            check: round((netIncomeEffect + shareCountEffect) - (epsCur - epsPrior), 6)
        };
    }

    return {
        company: { ticker: resolved.ticker, name: resolved.name, cik: resolved.cik || (index && index.cik), currency: current.currency },
        period_type: type,
        current_period: { end: current.period_end, source: sourceCur },
        prior_period: { end: prior.period_end, source: sourcePrior },
        observed,
        bridge,
        eps_decomposition: epsDecomposition,
        share_sources: { current: shares.current.source, prior: shares.prior.source },
        interpretation: 'observed_change_vs_arithmetic_contribution',
        notes: [
            'The bridge is arithmetic: each step\u2019s components sum to that step\u2019s change, and every input is a reported line item with its own source. It is not a causal claim.',
            'Line items outside this bridge (business mix, pricing, one-off items, segment effects) are not captured here.',
            Object.values(bridge).some((s) => s.components.some((c) => /balances this step/.test(String(c.formula))))
                ? 'One or more steps include a named balancing difference where the normalized data does not break out every non-operating line item. It is shown, not hidden.'
                : null,
            shares.current.basis === 'implied_from_net_income_and_diluted_eps' || shares.prior.basis === 'implied_from_net_income_and_diluted_eps'
                ? 'One period has no separately filed fourth-quarter weighted-average share count, so its share count is implied from reported net income and diluted EPS and labelled as such.'
                : null,
            'Verify every figure in the linked SEC filing before relying on it.'
        ].filter(Boolean)
    };
}

module.exports = {
    mcpError,
    searchCompanies,
    resolveCompany,
    companyFinancials,
    metricHistory,
    compareCompanyMetrics,
    searchFilings,
    getFilingContent,
    changeDrivers,
    // exported for tests and the refresh script
    ALL_METRIC_IDS,
    METRICS,
    DERIVED,
    XBRL_METRICS,
    resolveMetricId,
    periodRows,
    priorRowFor,
    companyCatalog,
    // test seam: clears the process-level memoization of SEC reads so a test
    // that stubs the network cannot be served a previous test's real data
    _clearMemo: () => { _filingMemo.clear(); _sharesMemo.clear(); }
};
