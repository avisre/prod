#!/usr/bin/env node
'use strict';
// Every stock and fund page, checked for the data a reader would see missing, so
// gaps are found in one run instead of by opening companies one at a time.
//
// Stocks go through the page's own payload (verified-fundamentals, the path behind
// /api/demo/alpha/fundamentals, with no live top-up). Funds go through the fund
// page's own profile (asset-profile, live from Yahoo, plus the filed fee table).
//
//   node scripts/audit-page-gaps.js                 # stocks and funds
//   node scripts/audit-page-gaps.js --stocks        # or --funds
//   node scripts/audit-page-gaps.js --symbols CLSK,PDI
//   node scripts/audit-page-gaps.js --stocks --explain
// --explain opens the SEC filing behind each missing headline figure and names the
// cause: filed under the company's own tag, only broken out by segment or member,
// present but dropped by extraction, or not in the filing. --jobs N stock workers (4).
//
// Writes docs/data-gaps/{stocks.csv,funds.csv,summary.md}. Rows are sorted by market
// cap (net assets for funds), so the most visited pages come first.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const DATA = path.join(ROOT, 'frontend', 'data');
const OUT = path.join(ROOT, 'docs', 'data-gaps');
const ANNUAL = 5, QUARTERS = 4;
const STATEMENT = { totalRevenue: 'income', netIncome: 'income', totalAssets: 'balance', totalShareholderEquity: 'balance', operatingCashflow: 'cash', capitalExpenditures: 'cash' };
const DAY = 86400000;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const only = opt('--symbols', '') ? new Set(opt('--symbols', '').toUpperCase().split(',')) : null;
const doStocks = !args.includes('--funds') || args.includes('--stocks');
const doFunds = !args.includes('--stocks') || args.includes('--funds');
const today = new Date().toISOString().slice(0, 10);
const ageDays = (d) => d ? Math.round((Date.parse(today) - Date.parse(String(d).slice(0, 10))) / DAY) : null;

// ---------- stocks ----------
function stockUniverse() {
    const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'public-stock-index.json'), 'utf8'));
    return idx.securities.filter((s) => s.securityType === 'stock' && (!only || only.has(s.symbol))).map((s) => s.symbol);
}

async function auditStock(symbol, report) {
    const verified = require(path.join(BACKEND, 'verified-fundamentals'));
    const gaps = [], add = (check, detail, extra = {}) => gaps.push({ check, detail, ...extra });
    let d;
    try { d = await verified.getCompanyEvidence(symbol, undefined, undefined, false); }
    catch (e) { return { symbol, cap: 0, gaps: [{ check: 'page_error', detail: e.code || e.message }] }; }
    const data = d?.data || {}, cov = d?.coverage || {}, m = data.marketData || d?.marketData || {}, o = data.overview || {};
    const cik = d?.cik || o.CIK || null, issuer = cik ? report.issuers[String(cik).padStart(10, '0')] : null;
    const base = { symbol, name: o.Name || '', cik, cap: Number(m.marketCap) || 0, sector: o.Sector || '' };
    const reports = (st, basis) => (data[st]?.[basis] || []).slice().sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));

    if (!['ready', 'partial'].includes(cov.financialCoverage) || !reports('income', 'annualReports').length) {
        add('no_financials', `${cov.financialCoverage || 'none'}${cov.missingReason ? ': ' + cov.missingReason : ''}`);
    } else {
        // Headline figures: the fields the coverage policy requires of this company, over the
        // periods the page leads with. Quarters only for an issuer that files quarterly.
        const fields = (cov.fields || Object.keys(STATEMENT)).filter((f) => STATEMENT[f] && f !== 'capitalExpenditures');
        const quarterly = (issuer?.reportingCadence || 'quarterly') === 'quarterly';
        for (const [basis, n, key] of [['annual', ANNUAL, 'annualReports'], ['quarterly', QUARTERS, 'quarterlyReports']]) {
            if (basis === 'quarterly' && !quarterly) continue;
            for (const f of fields) {
                const rows = reports(STATEMENT[f], key).slice(0, n);
                const blank = rows.filter((r) => r[f] === null || r[f] === undefined).map((r) => r.fiscalDateEnding);
                if (blank.length) add('headline_missing', `${basis} ${f}: ${blank.length}/${rows.length} blank`, { field: f, basis, periods: blank });
            }
        }
        // Newer filing at SEC than the newest period on the page.
        const newest = [reports('income', 'quarterlyReports')[0], reports('income', 'annualReports')[0]].filter(Boolean).map((r) => r.fiscalDateEnding).sort().pop();
        const filed = [issuer?.latestPeriodic, issuer?.latestAnnual].filter((f) => f?.reportDate).sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0];
        // A 6-K is a foreign issuer's furnished release, not a periodic report the pipeline reads.
        if (filed && newest && filed.reportDate > newest) add(/^6-K/.test(filed.form) ? 'foreign_interim_not_read' : 'sec_filing_not_loaded', `${filed.form} for ${filed.reportDate} filed ${filed.filingDate}; page ends ${newest}`, { url: filed.filingUrl });
        else if (newest && ageDays(newest) > 460) add('statements_stale', `newest period ${newest} (${ageDays(newest)} days old)`);
    }
    if (!(Number(m.price) > 0)) add('no_price', 'no stored quote');
    else if (ageDays(m.asOf) > 7) add('stale_price', `quote as of ${String(m.asOf).slice(0, 10)}`);
    if (Number(m.price) > 0 && !(Number(m.marketCap) > 0)) add('no_market_cap', 'price but no market cap');
    if (!o.Description) add('no_description', 'no business description');
    if (!o.Sector) add('no_sector', 'no sector');
    // The chart reads the monthly series; the daily one only feeds the one-month range. With
    // none stored, the API fetches it live for a visitor (price-history topUp) but a crawler
    // and the server-rendered page get no chart.
    const monthly = data.monthly?.['Monthly Adjusted Time Series'] || data.monthly?.['Monthly Time Series'] || {};
    if (!Object.keys(monthly).length) add('no_stored_chart', 'no stored price history; visitors get it live, crawlers get none');
    else if (!Object.keys(data.daily?.['Time Series (Daily)'] || {}).length) add('no_daily_prices', 'chart has no one-month range');
    return { ...base, gaps, filings: issuer ? { periodic: issuer.latestPeriodic, annual: issuer.latestAnnual } : null };
}

async function runStockShard(symbols) {
    const report = JSON.parse(fs.readFileSync(path.join(DATA, 'sec-reporting.json'), 'utf8'));
    const out = [];
    for (const s of symbols) out.push(await auditStock(s, report));
    return out;
}

function shardProcesses(symbols, jobs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-gaps-'));
    return Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((resolve, reject) => {
        const file = path.join(dir, `${i}.json`), list = path.join(dir, `${i}.in.json`);
        fs.writeFileSync(list, JSON.stringify(symbols.filter((_, k) => k % jobs === i)));
        const child = spawn(process.execPath, ['--max-old-space-size=1536', __filename, '--shard', list, file], { cwd: BACKEND, stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('exit', (code) => code === 0 ? resolve(JSON.parse(fs.readFileSync(file, 'utf8'))) : reject(new Error(`stock worker ${i} exited ${code}`)));
    }))).then((parts) => parts.flat());
}

// ---------- --explain: what the filing itself carries for a missing headline figure ----------
const KEYWORD = { totalRevenue: /Revenue|Sales/i, netIncome: /NetIncome|ProfitLoss|NetLoss|NetEarnings/i, totalAssets: /^Assets$|TotalAssets/i, totalShareholderEquity: /Equity/i, operatingCashflow: /OperatingActivities/i };
const STANDARD = /^(us-gaap|ifrs-full|dei|srt|country|currency|exch|naics|sic|stpr)$/;
const NOT_HEADLINE = /Proceeds|Payments?|Percent|Liabilit|Stock|Issuance|IncreaseDecrease|Reclass|Gain|(?<!Income|Profit|Net)Loss|Unrealized|Commission|Deferred|Receivable|Segment|EquityMethod|Taxable|Sold|Transfers?/;

function scanFiling(html) {
    const ctx = new Map();
    for (const c of html.matchAll(/<xbrli:context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g)) {
        const b = c[2];
        ctx.set(c[1], { start: (b.match(/startDate>\s*([^<\s]+)/) || [])[1] || null, end: (b.match(/(?:endDate|instant)>\s*([^<\s]+)/) || [])[1] || null, dims: [...b.matchAll(/dimension="([^"]+)"[^>]*>\s*([^<\s]+)/g)].map((x) => x[1] + '=' + x[2]) });
    }
    const facts = [];
    for (const f of html.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gi)) {
        const name = (f[1].match(/\bname="([^"]+)"/) || [])[1], c = ctx.get((f[1].match(/contextRef="([^"]+)"/i) || [])[1]);
        if (!name || !c) continue;
        const scale = Number((f[1].match(/\bscale="(-?\d+)"/) || [])[1] || 0), neg = /\bsign="-"/.test(f[1]);
        const text = f[2].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
        // A nil fact (GLSI's revenue, an empty cell) states no amount; it is not a zero.
        const nil = /\b[\w-]*:nil="true"/.test(f[1]) || (!text && !/fixed-zero/.test(f[1]));
        const v = /fixed-zero/.test(f[1]) ? 0 : Number(text);
        facts.push({ name, ...c, nil, value: !nil && Number.isFinite(v) ? (neg ? -1 : 1) * v * 10 ** scale : null });
    }
    return facts;
}

function explainGap(facts, field, periodEnd, basis, mapped) {
    const months = basis === 'annual' ? [11, 13] : [2, 4];
    const span = (f) => !f.start || STATEMENT[field] === 'balance' ? true : (() => { const mo = (Date.parse(f.end) - Date.parse(f.start)) / (30.44 * DAY); return mo >= months[0] && mo <= months[1]; })();
    const at = facts.filter((f) => f.end === periodEnd && span(f) && (STATEMENT[field] === 'balance' ? !f.start : !!f.start));
    const mappedPlain = at.find((f) => mapped.has(f.name) && !f.dims.length);
    if (mappedPlain?.nil) return { cause: 'filed_blank', tag: mappedPlain.name, value: null };
    if (mappedPlain) return { cause: 'extraction_dropped', tag: mappedPlain.name, value: mappedPlain.value };
    // A company's own line counts only when its name says it is the headline figure itself: on
    // 2026-10-31 most of 116 matches were parts or movements of it (proceeds, payments, deferred
    // revenue, segment sales, gains), not a total the extractor missed.
    const custom = at.filter((f) => { const local = f.name.split(':')[1] || ''; return !STANDARD.test(f.name.split(':')[0]) && !f.dims.length && KEYWORD[field].test(local) && !NOT_HEADLINE.test(local) && (field !== 'totalRevenue' || /(Revenues?|Sales)$/.test(local)); });
    if (custom.length) { const best = custom.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]; return { cause: 'company_tag', tag: best.name, value: best.value }; }
    const dimmed = at.find((f) => mapped.has(f.name));
    if (dimmed) return { cause: 'only_by_member', tag: dimmed.name, value: dimmed.value, member: dimmed.dims.join(' ') };
    // A 10-Q states cash flow year to date only; the quarter is that less the previous filing's.
    if (basis === 'quarterly' && STATEMENT[field] === 'cash') {
        const ytd = facts.find((f) => f.end === periodEnd && f.start && mapped.has(f.name) && !f.dims.length);
        // With discontinued operations the year to date is continuing operations only, and an
        // earlier filing's total is not the same figure, so there is nothing to subtract.
        const discontinued = facts.some((f) => f.end === periodEnd && /OperatingActivitiesDiscontinuedOperations$/.test(f.name) && !f.dims.length && f.value);
        if (ytd && (discontinued || /ContinuingOperations$/.test(ytd.name))) return { cause: 'discontinued_operations', tag: ytd.name, value: ytd.value };
        // Otherwise the earlier year to date is not on the same footing: amended, restated, a
        // different start date or a different line (scripts/refresh-sec-coverage.js already reads
        // the previous 10-Q when SEC's feed lacks it).
        if (ytd) return { cause: 'ytd_only_not_derived', tag: ytd.name, value: ytd.value };
    }
    return { cause: 'not_in_filing' };
}

async function explain(stocks) {
    const axios = require(require.resolve('axios', { paths: [BACKEND] }));
    const { HEADERS } = require(path.join(BACKEND, 'sec-reporting'));
    const { MAPS } = require(path.join(BACKEND, 'sec-facts'));
    const mappedFor = (field) => new Set(['us-gaap', 'ifrs-full'].flatMap((t) => (MAPS[STATEMENT[field]]?.[field]?.[t] || []).map((x) => t + ':' + x)));
    const cache = new Map();
    let fetched = 0;
    for (const s of stocks) for (const g of s.gaps) {
        if (g.check !== 'headline_missing' || !s.filings) continue;
        // Only the newest blank period can be checked against a filing we know: the latest 10-Q or 10-K.
        const end = g.periods[0], filing = [s.filings.periodic, s.filings.annual].find((f) => f?.reportDate === end && f.primaryDocument);
        if (!filing) { g.cause = 'older_filing_not_checked'; continue; }
        const url = `https://www.sec.gov/Archives/edgar/data/${Number(s.cik)}/${filing.accessionNumber.replace(/-/g, '')}/${filing.primaryDocument}`;
        if (!cache.has(url)) {
            await new Promise((r) => setTimeout(r, 150)); // under SEC's 10 requests a second
            try { cache.set(url, scanFiling(String((await axios.get(url, { headers: HEADERS, timeout: 30000, responseType: 'text', maxContentLength: 60 * 1024 * 1024 })).data))); fetched++; }
            catch (e) { cache.set(url, null); }
            if (fetched % 50 === 0) process.stderr.write(`  explain: ${fetched} filings read\n`);
        }
        const facts = cache.get(url);
        if (!facts) { g.cause = 'filing_unreadable'; continue; }
        Object.assign(g, explainGap(facts, g.field, end, g.basis, mappedFor(g.field)), { url });
        if (cache.size > 400) cache.delete(cache.keys().next().value);
    }
}

// ---------- funds ----------
function fundUniverse() {
    const top = JSON.parse(fs.readFileSync(path.join(DATA, 'top-funds.json'), 'utf8'));
    const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'public-stock-index.json'), 'utf8'));
    const list = [...(Array.isArray(top) ? top : top.funds || []).map((f) => f.symbol), ...idx.securities.filter((s) => s.securityType === 'closed_end_fund').map((s) => s.symbol)];
    return [...new Set(list)].filter((s) => !only || only.has(s));
}

async function auditFund(symbol) {
    const assets = require(path.join(BACKEND, 'asset-profile'));
    const fees = require(path.join(BACKEND, 'fund-fees'));
    let p;
    try { p = await assets.fetchAssetProfile(symbol); } catch (e) { return { symbol, cap: 0, gaps: [{ check: 'page_error', detail: e.message }] }; }
    const gaps = [], add = (check, detail) => gaps.push({ check, detail });
    const years = p.inceptionDate ? ageDays(p.inceptionDate) / 365.25 : null;
    const num = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
    if (!num(p.price)) add('no_price', 'no quote');
    else if (ageDays(p.asOf) > 7) add('stale_price', `quote as of ${String(p.asOf).slice(0, 10)}`);
    if (!num(p.totalAssets)) add('no_net_assets', 'net assets blank');
    if (!num(p.expenseRatio) || !/^SEC/.test(p.expenseRatioSource || '')) {
        // The page races the filed fee table against 2.5s; ask it directly, with no race.
        const filed = await fees.fetchFundFees(symbol).then((f) => f && fees.effectiveRatio(f)).catch(() => null);
        // A filed figure the page raced out is cached (memory, then Mongo for 30 days) once the
        // fetch lands, so only the first visit in a month misses it.
        if (!num(p.expenseRatio)) add(num(filed) ? 'expense_ratio_first_visit_only' : 'no_expense_ratio', num(filed) ? `filed figure ${filed}; blank only until the first lookup is cached` : 'no filed fee table and no provider figure');
        else if (num(filed) && Math.abs(filed - p.expenseRatio) > 0.00005) add('expense_ratio_provider_differs', `page can show provider ${p.expenseRatio} before the filed ${filed} is cached`);
    }
    if (!num(p.yield)) add('no_yield', 'yield blank');
    if (!num(p.ytdReturn)) add('no_ytd_return', 'YTD return blank');
    if (!num(p.returns?.threeYear) && !(years !== null && years < 3)) add('no_3y_return', '3-year return blank');
    if (!num(p.returns?.fiveYear) && !(years !== null && years < 5)) add('no_5y_return', '5-year return blank');
    const alloc = p.allocations || {};
    if (!['stock', 'bond', 'cash', 'other'].some((k) => num(alloc[k]))) add('no_allocation', 'asset allocation blank');
    if (!(p.topHoldings || []).length) {
        const full = await require(path.join(BACKEND, 'fund-holdings')).fetchFundHoldings(symbol).catch(() => null);
        if (!(full?.holdings || []).length) add('no_holdings', 'no holdings from the provider or a filed N-PORT');
    }
    if (!p.category) add('no_category', 'category blank');
    return { symbol, name: p.name || '', type: p.assetType, cap: Number(p.totalAssets) || 0, gaps };
}

async function pool(items, n, fn) {
    const out = [], queue = items.slice();
    let done = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (queue.length) { const it = queue.shift(); out.push(await fn(it)); if (++done % 50 === 0) process.stderr.write(`  funds: ${done}/${items.length}\n`); }
    }));
    return out;
}

// ---------- reports ----------
const csvCell = (v) => { const s = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function writeCsv(file, rows, cols) {
    fs.writeFileSync(file, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
}
function flatten(results) {
    return results.sort((a, b) => b.cap - a.cap).flatMap((r) => r.gaps.map((g) => ({ symbol: r.symbol, name: r.name, type: r.type || 'stock', sector: r.sector || '', market_cap: r.cap || '', check: g.check, detail: g.detail, periods: g.periods || '', cause: g.cause || '', tag: g.tag || '', value: g.value ?? '', member: g.member || '', url: g.url || '' })));
}
function tally(results, title, total) {
    const by = new Map(), causes = new Map();
    for (const r of results) for (const g of r.gaps) {
        const k = g.check + (g.field ? ` (${g.basis} ${g.field})` : '');
        (by.get(k) || by.set(k, []).get(k)).push(r);
        if (g.cause) causes.set(g.cause, (causes.get(g.cause) || 0) + 1);
    }
    const lines = [`## ${title}: ${results.filter((r) => r.gaps.length).length} of ${total} pages have a gap`, '', '| Gap | Pages | Largest first |', '|---|---:|---|'];
    for (const [k, rs] of [...by].sort((a, b) => b[1].length - a[1].length)) lines.push(`| ${k} | ${rs.length} | ${rs.sort((a, b) => b.cap - a.cap).slice(0, 8).map((r) => r.symbol).join(', ')} |`);
    if (causes.size) { lines.push('', '| Cause (from the filing) | Gaps |', '|---|---:|'); for (const [c, n] of [...causes].sort((a, b) => b[1] - a[1])) lines.push(`| ${c} | ${n} |`); }
    return lines.join('\n');
}

async function main() {
    if (args[0] === '--shard') {
        fs.writeFileSync(args[2], JSON.stringify(await runStockShard(JSON.parse(fs.readFileSync(args[1], 'utf8')))));
        process.exit(0);
    }
    fs.mkdirSync(OUT, { recursive: true });
    const cols = ['symbol', 'name', 'type', 'sector', 'market_cap', 'check', 'detail', 'periods', 'cause', 'tag', 'value', 'member', 'url'];
    const summary = [`# Page data gaps, ${today}`, '', 'Written by `node scripts/audit-page-gaps.js`. Rows in the CSVs are sorted by market cap (net assets for funds).', ''];
    if (doStocks) {
        const symbols = stockUniverse(), jobs = Math.max(1, Math.min(Number(opt('--jobs', 4)), symbols.length));
        process.stderr.write(`stocks: ${symbols.length} with ${jobs} workers\n`);
        const stocks = jobs > 1 ? await shardProcesses(symbols, jobs) : await runStockShard(symbols);
        if (args.includes('--explain')) await explain(stocks);
        writeCsv(path.join(OUT, 'stocks.csv'), flatten(stocks), cols);
        summary.push(tally(stocks, 'Stocks', symbols.length), '');
    }
    if (doFunds) {
        const funds = fundUniverse();
        process.stderr.write(`funds: ${funds.length}\n`);
        const log = console.log; // the quote library prints schema warnings for every fund
        console.log = () => {};
        const results = await pool(funds, Number(opt('--fund-jobs', 4)), auditFund);
        console.log = log;
        writeCsv(path.join(OUT, 'funds.csv'), flatten(results), cols);
        summary.push(tally(results, 'Funds', funds.length), '');
    }
    fs.writeFileSync(path.join(OUT, 'summary.md'), summary.join('\n'));
    console.log(summary.join('\n'));
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
