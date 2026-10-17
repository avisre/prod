#!/usr/bin/env node
'use strict';

// Row-level audit of the company page's three statements (income, balance, cash
// flow) for every stock: which rows the page shows filled, which show blank cells,
// and which it hides because every period is blank — and WHY each blank is blank.
//
// The row definitions are evaluated from frontend-v2/assets/company.js itself (the
// same getters the page runs), and each stock's payload is built through the same
// verified-fundamentals path the /api/demo/alpha/fundamentals route uses, so the
// audit cannot drift from what a reader sees.
//
//   node scripts/audit-statement-rows.js
//   SEC_BULK_DIR=<dir with companyfacts.zip> node scripts/audit-statement-rows.js
//   (SHARD=i/n SHARD_OUT=<dir>/i.json per process, then MERGE_DIR=<dir> for the reports)
// With SEC_BULK_DIR, every blank that is not structural is checked against the
// company's own SEC XBRL facts: sec_has_mapped_tag (a tag we already read is there,
// so extraction dropped it), sec_has_alt_tag (SEC has it under a tag we don't read),
// or not_reported (the filings carry no such figure for that period).
// Writes docs/statement-audit/{by-stock.csv,by-row.csv,summary.md} and
// frontend/data/statement-completeness.json.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'statement-audit');
const ANNUAL_PERIODS = 5;
const QUARTER_PERIODS = 8;

// ---------- the page's own row definitions ----------
function pageRows() {
    const src = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'assets', 'company.js'), 'utf8');
    const cut = (from, to) => {
        const a = src.indexOf(from); const b = src.indexOf(to, a);
        if (a < 0 || b < 0) throw new Error(`company.js changed shape: cannot find ${from}`);
        return src.slice(a, b);
    };
    const code = [
        cut('    // ---------- shared math ----------', '    let payload = null;'),
        cut('    function groupDefs(defs, st) {', '    function alignStatementYearColumns'),
        ';({ ROWS, groupDefs });'
    ].join('\n');
    const num = (v) => {
        if (v === null || v === undefined || (typeof v === 'string' && /^(?:none|null)?$/i.test(v.trim()))) return null;
        const n = Number(v); return Number.isFinite(n) ? n : null;
    };
    const fmt = () => '';
    const { ROWS, groupDefs } = vm.runInNewContext(code, { num, money: fmt, fixed: fmt, pct: fmt, Math, Number, Object, Set });
    const out = {};
    for (const st of ['income', 'balance', 'cash']) {
        out[st] = groupDefs(ROWS[st], st).map((d) => {
            const body = d.get.toString();
            const fields = new Set([...body.matchAll(/\br\.(\w+)/g)].map((m) => m[1]));
            if (/derive\(r\)/.test(body)) ['totalRevenue', 'grossProfit', 'costOfRevenue'].forEach((f) => fields.add(f));
            if (/fcfOf\(r\)/.test(body)) ['operatingCashflow', 'capitalExpenditures'].forEach((f) => fields.add(f));
            fields.delete('_sources');
            const role = d.parentOf !== undefined ? 'dropdown' : d.gid !== undefined ? 'in-dropdown' : 'row';
            return { label: d.label, get: d.get, fields: [...fields], role, gid: d.gid, parentOf: d.parentOf, kind: d.kind };
        });
    }
    return out;
}

// ---------- rows that are structurally absent for an industry ----------
const BANK_ONLY = new Set(['Net interest income', 'Noninterest income', 'Loans', 'Deposits']);
const NO_COST_OF_SALES = new Set(['Cost of revenue', 'Gross margin', 'Gross profit', 'Inventory', 'Change in inventory', 'R&D',
    'Total current assets', 'Total current liabilities', 'Total long-term assets', 'Total long-term liabilities']);
function notApplicable(label, archetype) {
    if (BANK_ONLY.has(label)) return archetype !== 'bank';
    // Banks and insurers file no operating income line, so EBIT and EBITDA have no base.
    if (['bank', 'insurer'].includes(archetype)) return NO_COST_OF_SALES.has(label) || ['EBIT', 'EBITDA'].includes(label);
    if (archetype === 'reit') return ['Inventory', 'Change in inventory', 'R&D', 'Total current assets', 'Total current liabilities', 'Total long-term assets', 'Total long-term liabilities'].includes(label);
    return false;
}

// ---------- SEC tags that would carry each field ----------
// MAPS tags come from backend/sec-facts.js (what extraction reads today). ALT tags
// are standard us-gaap elements for the same line that extraction does not read.
const ALT = {
    totalRevenue: ['RevenuesNetOfInterestExpense', 'InterestAndDividendIncomeOperating', 'RegulatedOperatingRevenue', 'OperatingLeasesIncomeStatementLeaseRevenue', 'RealEstateRevenueNet'],
    costOfRevenue: ['CostOfGoodsAndServicesSoldExcludingDepreciationDepletionAndAmortization', 'CostOfServices', 'CostDirectMaterial'],
    operatingExpenses: ['CostsAndExpenses', 'OperatingCostsAndExpenses', 'NoninterestExpense', 'BenefitsLossesAndExpenses'],
    sellingGeneralAndAdministrative: ['GeneralAndAdministrativeExpense', 'SellingAndMarketingExpense', 'SellingGeneralAndAdministrativeExpenseExcludingOtherExpense'],
    researchAndDevelopment: ['ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost', 'ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost'],
    operatingIncome: ['IncomeLossFromContinuingOperationsBeforeInterestExpenseInterestIncomeIncomeTaxesExtraordinaryItemsNoncontrollingInterestsNet'],
    interestExpense: ['InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestAndDebtExpense', 'InterestExpenseOperating'],
    interestIncome: ['InterestAndDividendIncomeOperating', 'InvestmentIncomeInterestAndDividend', 'InterestIncomeOther'],
    otherNonOperatingIncome: ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'],
    incomeBeforeTax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign'],
    depreciationAndAmortization: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
    eps: ['IncomeLossFromContinuingOperationsPerBasicShare'], dilutedEPS: ['IncomeLossFromContinuingOperationsPerDilutedShare'],
    commonStockSharesOutstanding: ['EntityCommonStockSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
    cashAndShortTermInvestments: ['CashCashEquivalentsAndShortTermInvestments'],
    shortTermInvestments: ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
    cashAndCashEquivalentsAtCarryingValue: ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash', 'CashAndDueFromBanks'],
    currentNetReceivables: ['ReceivablesNetCurrent', 'AccountsReceivableNet', 'AccountsNotesAndLoansReceivableNetCurrent'],
    inventory: ['InventoryFinishedGoodsNetOfReserves', 'InventoryGross', 'RetailRelatedInventoryMerchandise'],
    otherCurrentAssets: ['OtherAssetsCurrent', 'PrepaidExpenseAndOtherAssetsCurrent'],
    propertyPlantEquipment: ['PropertyPlantAndEquipmentGross', 'RealEstateInvestmentPropertyNet'],
    intangibleAssets: ['FiniteLivedIntangibleAssetsNet', 'IndefiniteLivedIntangibleAssetsExcludingGoodwill'],
    intangibleAssetsExcludingGoodwill: ['FiniteLivedIntangibleAssetsNet', 'IndefiniteLivedIntangibleAssetsExcludingGoodwill'],
    longTermInvestments: ['LongTermInvestmentsAndReceivablesNet', 'EquityMethodInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent'],
    deferredTaxAssets: ['DeferredIncomeTaxAssetsNet', 'DeferredTaxAssetsLiabilitiesNet'],
    otherNonCurrentAssets: ['OtherAssets'],
    currentAccountsPayable: ['AccountsPayableCurrent', 'AccountsPayableAndAccruedLiabilitiesCurrent', 'AccountsPayableTradeCurrent'],
    shortTermDebt: ['ShortTermBorrowings', 'DebtCurrent', 'LongTermDebtCurrent', 'CommercialPaper'],
    currentLongTermDebt: ['LongTermDebtAndCapitalLeaseObligationsCurrent'],
    longTermDebt: ['LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations', 'SeniorNotes', 'ConvertibleNotesPayable', 'LongTermLineOfCredit', 'NotesPayable'],
    totalNonCurrentLiabilities: ['LiabilitiesNoncurrent'],
    otherNonCurrentLiabilities: ['OtherLiabilitiesNoncurrent'],
    totalCurrentAssets: [], totalCurrentLiabilities: [], totalNonCurrentAssets: ['NoncurrentAssets'],
    totalLiabilities: ['LiabilitiesAndStockholdersEquity'],
    commonStock: ['CommonStockValue', 'CommonStocksIncludingAdditionalPaidInCapital', 'CommonStockValueOutstanding'],
    retainedEarnings: [], treasuryStock: ['TreasuryStockValue', 'TreasuryStockCommonValue'],
    operatingLeaseRightOfUseAsset: [], goodwill: [], loans: ['LoansAndLeasesReceivableNetReportedAmount', 'FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss'],
    deposits: ['DepositsDomestic'],
    netInterestIncome: ['InterestIncomeExpenseAfterProvisionForLoanLoss'], nonInterestIncome: [],
    depreciationDepletionAndAmortization: ['DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
    changeInReceivables: ['IncreaseDecreaseInAccountsReceivable', 'IncreaseDecreaseInReceivables', 'IncreaseDecreaseInAccountsAndNotesReceivable'],
    changeInInventory: ['IncreaseDecreaseInInventories', 'IncreaseDecreaseInRetailRelatedInventories'],
    changeInOperatingAssets: ['IncreaseDecreaseInOperatingAssets', 'IncreaseDecreaseInOtherOperatingAssets', 'IncreaseDecreaseInPrepaidDeferredExpenseAndOtherAssets'],
    changeInOperatingLiabilities: ['IncreaseDecreaseInOperatingLiabilities'],
    proceedsFromRepaymentsOfShortTermDebt: ['ProceedsFromRepaymentsOfShortTermDebt', 'ProceedsFromRepaymentsOfCommercialPaper'],
    proceedsFromIssuanceOfCommonStock: ['ProceedsFromIssuanceOfCommonStock', 'ProceedsFromStockOptionsExercised', 'ProceedsFromIssuanceOrSaleOfEquity'],
    shareBasedCompensation: ['AllocatedShareBasedCompensationExpense', 'ShareBasedCompensationArrangementByShareBasedPaymentAwardCompensationCost'],
    paymentsForRepurchaseOfCommonStock: ['PaymentsForRepurchaseOfEquity'],
    dividendPayout: ['PaymentsOfDividendsCommonStock', 'PaymentsOfOrdinaryDividends', 'PaymentsOfCapitalDistribution'],
    changeInCashAndCashEquivalents: ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect', 'CashAndCashEquivalentsPeriodIncreaseDecrease', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect'],
    operatingCashflow: [], capitalExpenditures: ['PaymentsToAcquireOtherPropertyPlantAndEquipment', 'PaymentsToDevelopRealEstateAssets'],
    cashflowFromInvestment: ['NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'],
    cashflowFromFinancing: ['NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'],
    incomeTaxExpense: ['CurrentIncomeTaxExpenseBenefit'], netIncome: [], grossProfit: [],
    premiums: [], investmentIncome: []
};

function secMatcher(facts) {
    const day = 864e5;
    const forms = /^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/;
    return function has(tag, st, basis, end) {
        const [tax, name] = tag.includes(':') ? tag.split(':') : ['us-gaap', tag];
        const units = facts && facts[tax] && facts[tax][name] && facts[tax][name].units;
        if (!units) return false;
        const target = Date.parse(end);
        for (const list of Object.values(units)) {
            for (const f of list) {
                if (!forms.test(f.form || '') || f.val === null || f.val === undefined) continue;
                if (Math.abs(Date.parse(f.end) - target) > 4 * day) continue;
                if (st === 'balance') { if (!f.start) return true; continue; }
                if (!f.start) continue;
                const len = (Date.parse(f.end) - Date.parse(f.start)) / day;
                if (basis === 'annual' ? (len >= 340 && len <= 390) : (st === 'cash' ? len >= 80 && len <= 290 : len >= 80 && len <= 100)) return true;
            }
        }
        return false;
    };
}

async function main() {
    const ROWDEFS = pageRows();
    const { MAPS } = require('../backend/sec-facts');
    // Per statement: a field extraction fills on the income statement (netIncome)
    // is still blank when the cash-flow table reads it from a cash-flow row.
    const mappedTags = { income: {}, balance: {}, cash: {} };
    for (const [st, defs] of Object.entries(MAPS)) for (const [field, m] of Object.entries(defs)) {
        mappedTags[st][field] = [...(m['us-gaap'] || []).map((t) => 'us-gaap:' + t), ...(m['ifrs-full'] || []).map((t) => 'ifrs-full:' + t)];
    }
    const otherTags = (f) => Object.values(mappedTags).flatMap((m) => m[f] || []);
    const verified = require('../backend/verified-fundamentals');
    const p = require('../backend/sec-coverage');
    const { requirements } = require('../backend/financial-requirements');
    const psi = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'public-stock-index.json'), 'utf8'));

    let bulk = null;
    if (process.env.SEC_BULK_DIR) {
        bulk = require('../backend/companyfacts-bulk');
        if (!bulk.enabled()) bulk = null;
    }

    const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null; // spot checks
    // SHARD=i/n audits every n-th stock from i and writes its results to SHARD_OUT, so n processes can
    // share the cores; MERGE_DIR then builds the reports from every shard file in that directory.
    const [shard, shards] = String(process.env.SHARD || '0/1').split('/').map(Number);
    const stocks = process.env.MERGE_DIR ? [] : psi.securities.filter((s, i) => s.securityType === 'stock' && (!only || only.has(s.symbol)) && i % shards === shard);
    const results = process.env.MERGE_DIR ? fs.readdirSync(process.env.MERGE_DIR).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(process.env.MERGE_DIR, f), 'utf8'))) : [];
    let n = 0;
    for (const s of stocks) {
        const issuer = psi.issuers[s.cik] || {};
        const ev = issuer.evidence || {};
        const tier = (!s.isADR && s.annualReportingStatus === 'recent_annual' && ev.reportingCadence === 'quarterly') ? 1 : 2;
        let payload = null;
        try { payload = verified.load(s.symbol, null); } catch (_) { payload = null; }
        let raw = null;
        try { raw = verified.loadIssuer(p.cik(s.cik), issuer.financialDigest || ev.financialDigest); } catch (_) { raw = null; }
        let archetype = 'generic';
        try { archetype = requirements((payload && payload.overview) || { Sector: s.sector }, ev.sic).archetype; } catch (_) { /* generic */ }
        let facts = null;
        if (bulk && s.cik) { try { const gaap = await bulk.factsForCik(s.cik); facts = gaap ? { 'us-gaap': gaap } : null; } catch (_) { facts = null; } }
        const secHas = facts ? secMatcher(facts) : null;
        const perShare = !(payload && payload.coverage && payload.coverage.perShareAllowed === false);

        const stock = { sym: s.symbol, name: s.name || '', tier, archetype, hasSecFile: !!raw, statements: {} };
        for (const st of ['income', 'balance', 'cash']) {
            for (const basis of ['annual', 'quarterly']) {
                const rows = ((payload && payload[st] && payload[st][basis + 'Reports']) || []).slice(0, basis === 'annual' ? ANNUAL_PERIODS : QUARTER_PERIODS);
                const rawRows = (raw && raw[st] && raw[st][basis + 'Reports']) || [];
                const out = [];
                for (const def of ROWDEFS[st]) {
                    const vals = rows.map((r) => { try { return def.get(r); } catch (_) { return null; } });
                    const filled = vals.filter((v) => v !== null).length;
                    const status = !rows.length || !filled ? 'hidden' : filled === rows.length ? 'filled' : 'gappy';
                    let reason = null; let tag = null;
                    if (status !== 'filled') {
                        if (notApplicable(def.label, archetype)) reason = 'not_applicable';
                        else if (!rows.length) reason = raw ? 'no_statement_rows' : 'no_sec_file';
                        else if (!perShare && (def.kind === 'ps' || def.kind === 'shares')) reason = 'per_share_withheld';
                        else {
                            const blank = rows.filter((r, i) => vals[i] === null);
                            const present = (v) => v !== null && v !== undefined && v !== '';
                            // extracted, then nulled by safeRows / conflicting evidence
                            const rejected = def.fields.some((f) => blank.some((r) => {
                                const rr = rawRows.find((x) => x.fiscalDateEnding === r.fiscalDateEnding);
                                return rr && !present(r[f]) && (present(rr[f]) || (rr._states && rr._states[f] === 'conflicting_evidence'));
                            }));
                            // every input is there; the page's formula yields nothing (a nil
                            // remainder, a tax rate on a pre-tax loss)
                            const byDesign = def.fields.length > 0 && blank.every((r) => def.fields.every((f) => present(r[f])));
                            // only the inputs that are actually blank can explain the gap
                            const missing = def.fields.filter((f) => blank.some((r) => !present(r[f])));
                            const unmapped = missing.every((f) => !mappedTags[st][f]);
                            // an input explains a period only where that input itself is blank
                            const inSec = (f) => (t) => blank.some((r) => !present(r[f]) && secHas(t, st, basis, r.fiscalDateEnding));
                            if (byDesign) reason = 'formula_blank_by_design';
                            else if (rejected) reason = 'rejected_by_validation';
                            else if (secHas) {
                                for (const f of missing) {
                                    const m = (mappedTags[st][f] || otherTags(f)).find(inSec(f));
                                    if (m) { reason = mappedTags[st][f] ? 'sec_has_mapped_tag' : 'unmapped_sec_has_it'; tag = m; break; }
                                }
                                if (!reason) for (const f of missing) {
                                    const a = (ALT[f] || []).find(inSec(f));
                                    if (a) { reason = mappedTags[st][f] ? 'sec_has_alt_tag' : 'unmapped_sec_has_it'; tag = 'us-gaap:' + a; break; }
                                }
                                if (!reason) reason = unmapped ? 'unmapped_not_reported' : 'not_reported';
                            } else reason = unmapped ? 'unmapped' : 'missing_unchecked';
                        }
                    }
                    out.push({ label: def.label, role: def.role, status, reason, tag });
                }
                stock.statements[st + ':' + basis] = out;
            }
        }
        results.push(stock);
        if (++n % 1000 === 0) console.log(`${n}/${stocks.length} stocks`);
    }

    if (process.env.SHARD) { fs.writeFileSync(process.env.SHARD_OUT, JSON.stringify(results)); process.exit(0); }

    // ---------- reports ----------
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const STRUCTURAL = new Set(['not_applicable', 'per_share_withheld', 'formula_blank_by_design']);
    const NOT_FILED = new Set(['not_reported', 'unmapped_not_reported']);
    const counts = (rows) => {
        const app = rows.filter((r) => !STRUCTURAL.has(r.reason));
        return [app.filter((r) => r.status === 'filled').length, app.filter((r) => r.status === 'gappy').length, app.length];
    };
    const csvCell = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;

    const byStock = ['symbol,name,tier,archetype,sec_file,income_filled,income_gappy,income_rows,balance_filled,balance_gappy,balance_rows,cash_filled,cash_gappy,cash_rows,quarterly_filled,quarterly_rows,missing_annual_rows'];
    const ordered = results.slice().sort((a, b) => a.tier - b.tier || a.sym.localeCompare(b.sym));
    const index = { generatedAt: new Date().toISOString(), periods: { annual: ANNUAL_PERIODS, quarterly: QUARTER_PERIODS }, stocks: {} };
    for (const r of ordered) {
        const [i, b, c] = ['income', 'balance', 'cash'].map((st) => counts(r.statements[st + ':annual']));
        const q = ['income', 'balance', 'cash'].map((st) => counts(r.statements[st + ':quarterly'])).reduce((a, x) => [a[0] + x[0], a[1] + x[1], a[2] + x[2]], [0, 0, 0]);
        const missing = ['income', 'balance', 'cash'].flatMap((st) => r.statements[st + ':annual']
            .filter((x) => x.status !== 'filled' && !STRUCTURAL.has(x.reason))
            .map((x) => `${st[0].toUpperCase()}:${x.label}${x.status === 'gappy' ? ' (gaps)' : ''}=${x.reason}`));
        byStock.push([r.sym, r.name, r.tier, r.archetype, r.hasSecFile ? 'yes' : 'no', i[0], i[1], i[2], b[0], b[1], b[2], c[0], c[1], c[2], q[0], q[2], missing.join(' | ')].map(csvCell).join(','));
        // m: annual rows left blank although SEC reports the missing years (ours to fill).
        const m = ['income', 'balance', 'cash'].reduce((n, st) => n + r.statements[st + ':annual']
            .filter((x) => x.status !== 'filled' && !STRUCTURAL.has(x.reason) && !NOT_FILED.has(x.reason)).length, 0);
        index.stocks[r.sym] = { t: r.tier, i: [i[0], i[2]], b: [b[0], b[2]], c: [c[0], c[2]], q: [q[0], q[2]], m };
    }
    fs.writeFileSync(path.join(OUT_DIR, 'by-stock.csv'), byStock.join('\n') + '\n');
    fs.writeFileSync(path.join(ROOT, 'frontend', 'data', 'statement-completeness.json'), JSON.stringify(index));

    // row x reason rollup, per tier and basis
    const roll = {};
    for (const r of results) for (const [key, rows] of Object.entries(r.statements)) for (const x of rows) {
        const k = `${r.tier}|${key}|${x.label}`;
        const e = roll[k] ||= { tier: r.tier, statement: key.split(':')[0], basis: key.split(':')[1], label: x.label, role: x.role, stocks: 0, filled: 0, gappy: 0, hidden: 0, reasons: {}, tags: {} };
        e.stocks++; e[x.status]++;
        if (x.reason) e.reasons[x.reason] = (e.reasons[x.reason] || 0) + 1;
        if (x.tag) e.tags[x.tag] = (e.tags[x.tag] || 0) + 1;
    }
    const byRow = ['tier,statement,basis,row,role,stocks,filled,gappy,hidden,not_filled_by_reason,top_sec_tags'];
    const rollRows = Object.values(roll).sort((a, b) => a.tier - b.tier || a.basis.localeCompare(b.basis) || (b.gappy + b.hidden) - (a.gappy + a.hidden));
    for (const e of rollRows) {
        const reasons = Object.entries(e.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
        const tags = Object.entries(e.tags).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
        byRow.push([e.tier, e.statement, e.basis, e.label, e.role, e.stocks, e.filled, e.gappy, e.hidden, reasons, tags].map(csvCell).join(','));
    }
    fs.writeFileSync(path.join(OUT_DIR, 'by-row.csv'), byRow.join('\n') + '\n');

    // console + summary: Tier 1 annual first
    const lines = [];
    for (const tier of [1, 2]) {
        const set = results.filter((r) => r.tier === tier);
        const complete = set.filter((r) => ['income', 'balance', 'cash'].every((st) => { const c = counts(r.statements[st + ':annual']); return c[0] === c[2]; })).length;
        const reasonTotals = {};
        for (const r of set) for (const st of ['income', 'balance', 'cash']) for (const x of r.statements[st + ':annual']) if (x.reason) reasonTotals[x.reason] = (reasonTotals[x.reason] || 0) + 1;
        lines.push(`TIER ${tier} (${tier === 1 ? 'regular US reporters' : 'other stocks'}): ${set.length} stocks, ${complete} with every applicable annual row filled for ${ANNUAL_PERIODS} years`);
        lines.push('  annual blank rows by reason: ' + Object.entries(reasonTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
    }
    console.log(lines.join('\n'));
    fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), lines.join('\n') + '\n');
    process.exit(0);
}

if (require.main === module) main();
module.exports = { pageRows, notApplicable, secMatcher };
