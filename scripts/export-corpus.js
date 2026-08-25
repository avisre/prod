#!/usr/bin/env node
'use strict';

// Bulk corpus export — public-filing-derived data only.
//
//   node scripts/export-corpus.js --out /tmp/corpus [--limit 500] [--symbols AAPL,MSFT] [--no-db]
//
// Produces CSV + JSON for three tables, each row carrying the SEC source link
// for the filing the figures came from:
//
//   companies.*          identity only (CIK, exchange, sector, reporting currency)
//   fundamentals-annual.*  the XBRL panel: income / balance / cash, as filed
//   filing-changes.*     the deterministic part of the cached filing-change
//                        reports (period-over-period deltas + materiality)
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY EXCLUDED, and why
// ---------------------------------------------------------------------------
// * Any user data. Nothing here reads users, stocks, watchlists, alertrules,
//   funnel_events, scheduled_emails, prepared_emails or support tickets. The
//   only Mongo collection touched is `filing_reports`, which is keyed by ticker
//   and filing accession and contains no user reference at all.
// * Credentials and env. Nothing from process.env is written to the output.
// * Model-written prose. `summary`, `summaryPlain` and the whole `narrative`
//   block (headline, tone, per-area change text and pulled quotes) are our
//   analysis, not the filings' facts. They are excluded from the corpus.
// * Vendor market data. The daily/monthly price series and every quote-derived
//   overview field (market cap, P/E, PEG, analyst target, 52-week range, beta,
//   TTM ratios) come from a market-data source, not from SEC filings. We do not
//   have redistribution rights to those, so they never enter a bulk export.
// * `unitEconomics` — a derived proprietary metric, not a filed figure.
//
// Everything that remains is a number a company itself filed with the SEC, or a
// deterministic difference between two such numbers, with the filing URL.

const fs = require('node:fs');
const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
const FUND_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');

// Identity fields only — everything omitted here is either vendor market data
// or free-text we have no reason to redistribute in bulk.
const COMPANY_FIELDS = ['Symbol', 'Name', 'CIK', 'Exchange', 'Currency', 'Country', 'Sector', 'Industry', 'FiscalYearEnd'];

const STATEMENT_FIELDS = {
    income: ['totalRevenue', 'costOfRevenue', 'grossProfit', 'researchAndDevelopment',
        'sellingGeneralAndAdministrative', 'operatingExpenses', 'operatingIncome', 'interestExpense',
        'incomeBeforeTax', 'incomeTaxExpense', 'netIncome', 'ebit', 'ebitda', 'eps', 'dilutedEPS'],
    balance: ['totalAssets', 'totalCurrentAssets', 'cashAndCashEquivalentsAtCarryingValue',
        'shortTermInvestments', 'inventory', 'currentNetReceivables', 'propertyPlantEquipment', 'goodwill',
        'totalLiabilities', 'totalCurrentLiabilities', 'shortTermDebt', 'currentLongTermDebt',
        'longTermDebt', 'totalShareholderEquity', 'retainedEarnings', 'commonStockSharesOutstanding'],
    cash: ['operatingCashflow', 'capitalExpenditures', 'depreciationDepletionAndAmortization',
        'cashflowFromInvestment', 'cashflowFromFinancing', 'dividendPayout',
        'paymentsForRepurchaseOfCommonStock', 'changeInCashAndCashEquivalents', 'netIncome']
};

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        if (key === 'no-db') { out.noDb = true; continue; }
        out[key] = argv[i + 1];
        i += 1;
    }
    return out;
}

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, columns) {
    return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}
function writePair(outDir, name, rows, columns) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(rows, null, 1));
    fs.writeFileSync(path.join(outDir, `${name}.csv`), toCsv(rows, columns));
    return rows.length;
}

// Every filed figure gets a link back to the filer's own EDGAR record. Without
// a CIK we emit nothing rather than guessing a URL.
function edgarCompanyUrl(cik) {
    const c = String(cik || '').replace(/\D/g, '');
    return c ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.padStart(10, '0')}&type=10-K&dateb=&owner=include&count=40` : '';
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : ''; };

// ---- 1 + 2. companies + the XBRL panel, from the local fundamentals cache ----
// The fundamentals cache doesn't always carry a CIK, so resolve it from the
// US-filer list. No CIK means no citable source, and an uncitable row is worth
// nothing to a licensee — so it does not ship.
let _cikBysymbol = null;
function cikFor(symbol, overviewCik) {
    if (String(overviewCik || '').replace(/\D/g, '')) return String(overviewCik).replace(/\D/g, '');
    if (!_cikBysymbol) {
        _cikBysymbol = new Map();
        try {
            const raw = require(path.join(__dirname, '..', 'frontend', 'data', 'us-companies.json'));
            for (const c of (Array.isArray(raw) ? raw : (raw.companies || []))) {
                if (c && c.symbol && c.cik) _cikBysymbol.set(String(c.symbol).toUpperCase(), String(c.cik));
            }
        } catch (_) { /* falls through to "no CIK" */ }
    }
    return _cikBysymbol.get(String(symbol).toUpperCase()) || '';
}

function exportFundamentals(outDir, { symbols, limit }) {
    let files;
    try { files = fs.readdirSync(FUND_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json'); } catch (_) { files = []; }
    if (symbols && symbols.length) {
        const want = new Set(symbols.map((s) => `${s.replace(/[^A-Z0-9]/g, '_')}.json`));
        files = files.filter((f) => want.has(f));
    }
    if (Number.isFinite(limit) && limit > 0) files = files.slice(0, limit);

    const companies = [];
    const panel = [];
    for (const file of files) {
        let d = null;
        try { d = JSON.parse(fs.readFileSync(path.join(FUND_DIR, file), 'utf8')); } catch (_) { continue; }
        const ov = (d && d.overview) || {};
        const symbol = String(ov.Symbol || file.replace(/\.json$/, '')).toUpperCase();
        const cik = cikFor(symbol, ov.CIK);
        if (!cik) continue; // no CIK => we cannot cite a source filing => it does not ship
        const sourceUrl = edgarCompanyUrl(cik);

        const company = { sourceUrl };
        for (const f of COMPANY_FIELDS) company[f] = ov[f] === undefined ? '' : ov[f];
        company.Symbol = symbol;
        company.CIK = cik;
        companies.push(company);

        // One row per (symbol, fiscal period), income+balance+cash joined.
        const byPeriod = new Map();
        for (const st of ['income', 'balance', 'cash']) {
            for (const basis of ['annualReports', 'quarterlyReports']) {
                for (const r of ((d[st] || {})[basis]) || []) {
                    const end = String(r.fiscalDateEnding || '');
                    if (!end) continue;
                    const key = `${basis}|${end}`;
                    if (!byPeriod.has(key)) {
                        byPeriod.set(key, {
                            symbol, cik, sourceUrl,
                            basis: basis === 'annualReports' ? 'annual' : 'quarterly',
                            fiscalPeriodEnd: end,
                            reportedCurrency: String(r.reportedCurrency || ov.Currency || '').toUpperCase()
                        });
                    }
                    const row = byPeriod.get(key);
                    for (const f of STATEMENT_FIELDS[st]) {
                        // netIncome appears on both income and cash; income wins.
                        if (row[f] !== undefined && row[f] !== '') continue;
                        row[f] = num(r[f]);
                    }
                }
            }
        }
        for (const row of byPeriod.values()) panel.push(row);
    }

    const panelColumns = ['symbol', 'cik', 'basis', 'fiscalPeriodEnd', 'reportedCurrency',
        ...new Set([...STATEMENT_FIELDS.income, ...STATEMENT_FIELDS.balance, ...STATEMENT_FIELDS.cash]), 'sourceUrl'];
    for (const row of panel) for (const c of panelColumns) if (row[c] === undefined) row[c] = '';

    return {
        companies: writePair(outDir, 'companies', companies, ['Symbol', ...COMPANY_FIELDS.filter((f) => f !== 'Symbol'), 'sourceUrl']),
        fundamentals: writePair(outDir, 'fundamentals-panel', panel, panelColumns)
    };
}

// ---- 3. the deterministic half of the cached filing-change reports ----
async function exportFilingChanges(outDir, mongoose, { symbols, limit }) {
    const query = {};
    if (symbols && symbols.length) query.symbol = { $in: symbols };
    const docs = await mongoose.connection.collection('filing_reports')
        .find(query, { projection: { _id: 0 } })
        .limit(Number.isFinite(limit) && limit > 0 ? limit : 100000)
        .toArray();

    const rows = [];
    for (const doc of docs) {
        const p = doc.payload || {};
        const f = p.latestFiling || {};
        // The narrative/summary fields on `p` are intentionally not read here.
        for (const d of (p.deltas || [])) {
            rows.push({
                symbol: doc.symbol || p.symbol || '',
                accession: doc.accession || '',
                filingForm: f.form || '',
                filingDate: f.date || doc.filedDate || '',
                reportedPeriod: p.reportedPeriod || '',
                priorPeriod: p.priorPeriod || '',
                currency: p.currency || '',
                metric: d.label || '',
                latest: d.latest === undefined ? '' : d.latest,
                prior: d.prior === undefined ? '' : d.prior,
                change: d.change === undefined ? '' : d.change,
                direction: d.direction || '',
                materiality: p.materiality === undefined ? '' : p.materiality,
                materialityBucket: p.materialityBucket || '',
                sourceUrl: f.url || ''
            });
        }
    }
    const columns = ['symbol', 'accession', 'filingForm', 'filingDate', 'reportedPeriod', 'priorPeriod',
        'currency', 'metric', 'latest', 'prior', 'change', 'direction', 'materiality', 'materialityBucket', 'sourceUrl'];
    return { filingChanges: writePair(outDir, 'filing-changes', rows, columns), reports: docs.length };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const outDir = path.resolve(String(args.out || './corpus-export'));
    const limit = args.limit === undefined ? null : Number(args.limit);
    const symbols = args.symbols
        ? [...new Set(String(args.symbols).split(/[\s,]+/).map((s) => s.toUpperCase().trim()).filter(Boolean))]
        : null;

    fs.mkdirSync(outDir, { recursive: true });
    const counts = exportFundamentals(outDir, { symbols, limit });

    let mongoose = null;
    if (!args.noDb) {
        require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
        require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
        if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required (or pass --no-db to export the XBRL panel only)');
        mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
        Object.assign(counts, await exportFilingChanges(outDir, mongoose, { symbols, limit }));
        await mongoose.disconnect();
    }

    const manifest = {
        generatedAt: new Date().toISOString(),
        contents: {
            'companies.{csv,json}': 'Company identity as filed: ticker, CIK, exchange, reporting currency, sector, industry, fiscal year end.',
            'fundamentals-panel.{csv,json}': 'Income statement, balance sheet and cash flow line items as filed, one row per company-period, annual and quarterly.',
            'filing-changes.{csv,json}': args.noDb ? 'not included (--no-db)' : 'Period-over-period deltas from the cached filing-change reports, with the deterministic materiality score.'
        },
        excluded: [
            'All user data — no collection containing a user reference was read.',
            'Model-written analysis: report summaries, narrative headlines, per-area change text and pulled quotes.',
            'Vendor market data: daily/monthly price series and every quote-derived overview ratio.',
            'Derived proprietary metrics (unit economics).',
            'Credentials, environment and internal identifiers.'
        ],
        provenance: 'Every row carries a sourceUrl pointing at the filer\'s own SEC EDGAR record or the specific source filing.',
        licence: 'See docs/growth/corpus-license-terms.md. Not licensed for resale or redistribution.',
        counts
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ outDir, ...counts }, null, 2));
}

module.exports = { exportFundamentals, exportFilingChanges, COMPANY_FIELDS, STATEMENT_FIELDS };

if (require.main === module) {
    main().catch((error) => { console.error(error && error.message || error); process.exit(1); });
}
