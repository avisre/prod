#!/usr/bin/env node
'use strict';
// The quarter an issuer has announced but not yet filed, read from its earnings release.
//
// Why this exists: quarterly statements come from 10-Q XBRL, which lands days or weeks after the earnings
// release (8-K item 2.02, exhibit 99.1). NVIDIA released Q3 FY2027 on 2026-11-17 with the 10-Q still to come.
// This reads the release's printed statements (extract-html-statements.js) and keeps the new quarter only.
//
// Nothing is estimated, and nothing is kept on the release's word alone. A release prints each line for the new
// quarter beside the same line for an earlier period the issuer has already filed in XBRL. A line is kept only when
// its printed comparison figure matches that filed figure to the printed rounding. Each statement also needs its
// anchor total (revenue or net income, total assets, operating cash flow) to match, or none of it is kept.
// The matched comparison goes into each observation's receipt. When the 10-Q is filed and the XBRL refresh
// (refresh-sec-coverage.js) covers the quarter, verified-fundamentals stops using these rows. A later --write
// also prunes them.
//
//   node scripts/fill-release-quarter.js NVDA            # dry run: prints every line, kept or not, and why
//   node scripts/fill-release-quarter.js NVDA --write    # merges the kept lines into supplemental-financials
//   options: --cache DIR

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const BACKEND = path.join(__dirname, '..', 'backend');
const p = require(path.join(BACKEND, 'sec-coverage'));
const obsApi = require(path.join(BACKEND, 'company-observations'));
const ex = require('./extract-html-statements');

const UA = 'StockPortfolio research support@stockportfolio.pro';
const DATA = p.DATA_DIR;
const METHOD = 'release_table_checked';
const ANCHORS = { income: ['totalRevenue', 'netIncome'], balance: ['totalAssets'], cash: ['operatingCashflow'] };
const DAY = 864e5;

function issuerFor(symbol) {
    const companies = JSON.parse(fs.readFileSync(path.join(DATA, 'us-companies.json'), 'utf8')).companies;
    const c = companies.find((x) => x.symbol === symbol && x.cik);
    return c ? { symbol: c.symbol, cik: String(c.cik).padStart(10, '0'), domestic: true } : null;
}

// Every period the issuer has filed in XBRL, by statement, and the newest quarter end among them.
function filedState(data) {
    const rows = (st) => [...(data[st]?.annualReports || []), ...(data[st]?.quarterlyReports || [])];
    const quarterEnds = [...new Set(['income', 'cash', 'balance'].flatMap((st) => (data[st]?.quarterlyReports || []).map((r) => r.fiscalDateEnding)))].sort();
    const annualEnds = (data.income?.annualReports || []).map((r) => r.fiscalDateEnding);
    const taxonomy = Object.values(data.sources || {}).find((s) => s && s.taxonomy)?.taxonomy;
    return { rows, quarterEnds, latest: [...quarterEnds, ...annualEnds].sort().pop() || '', accountingBasis: taxonomy === 'ifrs-full' ? 'IFRS' : 'US GAAP' };
}

// The comparison check. `fresh` holds the new quarter's lines, and `prior` the same document's lines for earlier
// periods. Each fresh line is paired with the latest earlier line of the same field, statement and basis, and that
// earlier printed figure is compared with what the issuer filed for that period.
function check(fresh, prior, filed, scaleOf) {
    const verdicts = fresh.map((f) => {
        const twin = prior.filter((q) => q.field === f.field && q.statement === f.statement && q.basis === f.basis && q.scope === f.scope && q.periodEnd < f.periodEnd).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
        if (!twin) return { f, ok: false, why: 'no comparison column printed' };
        const row = filed.rows(f.statement).find((r) => r.fiscalDateEnding === twin.periodEnd && (f.statement === 'balance' || (r.periodStart && twin.periodStart && Math.abs(Date.parse(r.periodStart) - Date.parse(twin.periodStart)) <= 7 * DAY)));
        const filedValue = row ? p.number(row[f.field]) : null;
        if (filedValue === null) return { f, ok: false, why: `nothing filed for ${twin.periodEnd} to compare` };
        const perShare = /\/shares$/.test(f.unit);
        const derived = !!row._derivations?.[f.field];
        const unit = perShare ? 0.01 : scaleOf(f.statement);
        const tolerance = unit * (derived ? 1.5 : 0.5) + (perShare ? 1e-9 : 0);
        const diff = Math.abs(twin.value - filedValue);
        const comparison = { periodEnd: twin.periodEnd, printed: twin.value, printedText: twin.receipt?.cellText || null, filed: filedValue, filedSourceIds: row._sources?.[f.field] || [], derived, tolerance };
        return diff <= tolerance ? { f, ok: true, comparison } : { f, ok: false, why: `printed ${twin.periodEnd} ${twin.value} vs filed ${filedValue}`, comparison };
    });
    // A statement whose anchor total does not reconcile is not trusted line by line either.
    for (const [st, anchors] of Object.entries(ANCHORS)) {
        const anchored = verdicts.some((v) => v.ok && v.f.statement === st && anchors.includes(v.f.field));
        if (!anchored) for (const v of verdicts) if (v.f.statement === st && v.ok) Object.assign(v, { ok: false, why: `${st} anchor (${anchors.join(' or ')}) did not reconcile` });
    }
    return verdicts;
}

async function get(url, cacheDir) {
    const file = path.join(cacheDir, url.replace(/^https:\/\/[^/]+\//, '').replace(/[^\w.-]+/g, '_'));
    if (fs.existsSync(file) && !/submissions/.test(url)) return { text: fs.readFileSync(file, 'utf8'), retrievedAt: fs.statSync(file).mtime.toISOString() };
    const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'text/html,application/json' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const text = await res.text();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, text);
    return { text, retrievedAt: new Date().toISOString() };
}

// The newest earnings release (8-K item 2.02) filed after the latest filed quarter, and its exhibit 99.
async function findRelease(issuer, latest, cacheDir) {
    const subs = JSON.parse((await get(`https://data.sec.gov/submissions/CIK${issuer.cik}.json`, cacheDir)).text);
    const r = subs.filings.recent;
    const filings = r.form.map((form, i) => ({ form, items: r.items[i] || '', filingDate: r.filingDate[i], reportDate: r.reportDate[i], accession: r.accessionNumber[i] }));
    const periodic = filings.find((f) => /^10-[QK](\/A)?$/.test(f.form) && f.reportDate > latest);
    if (periodic) return { subs, periodic };
    const release = filings.filter((f) => /^8-K$/.test(f.form) && /(?:^|,)\s*2\.02(?:,|$)/.test(f.items) && f.filingDate > latest).sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
    if (!release) return { subs };
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${release.accession.replace(/-/g, '')}/`;
    const index = (await get(base + release.accession + '-index.htm', cacheDir)).text;
    let document = null;
    for (const row of index.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
        const href = (row.match(/href="([^"]+\.html?)"/i) || [])[1];
        if (href && /<td[^>]*>\s*EX-99(?:\.1)?\s*<\/td>/i.test(row)) { document = href.split('/').pop(); break; }
    }
    if (!document || !/^[\w.-]+$/.test(document)) throw new Error('no EX-99.1 in ' + release.accession);
    return { subs, release: { ...release, document, documentUrl: base + document } };
}

function readQuarter(html, { issuer, subs, release, filed, retrievedAt }) {
    const ctx = {
        cik: issuer.cik, symbol: issuer.symbol, registrantName: subs.name, formerNames: (subs.formerNames || []).map((n) => n.name),
        form: release.form, filingDate: release.filingDate, accession: release.accession, document: release.document,
        documentUrl: release.documentUrl, retrievedAt, fiscalYearEnd: subs.fiscalYearEnd, domestic: issuer.domestic,
        // A release states no accounting basis; the issuer's own filed statements do.
        accountingBasis: filed.accountingBasis,
        // 52/53-week quarters: the new quarter's start comes from the quarter the issuer filed before it.
        knownQuarterEnds: filed.quarterEnds,
    };
    const doc = ex.extractDocument(html, ctx);
    const { observations, skipped } = ex.observationsFor(doc, ctx);
    const scales = Object.fromEntries(doc.statements.map((s) => [s.type, s.scale]));
    const isNew = (f) => f.periodEnd > filed.latest && (f.basis === 'quarterly' || f.basis === 'instant');
    const fresh = observations.filter(isNew), prior = observations.filter((f) => !isNew(f));
    // Contiguous with the filed history: the new quarter starts the day after the last filed quarter ends.
    const lastEnd = filed.quarterEnds[filed.quarterEnds.length - 1];
    const startOk = (f) => f.basis === 'instant' || (lastEnd && f.periodStart === new Date(Date.parse(lastEnd) + DAY).toISOString().slice(0, 10));
    const verdicts = check(fresh, prior, filed, (st) => scales[st] || 1).map((v) => (v.ok && !startOk(v.f) ? { ...v, ok: false, why: `period starts ${v.f.periodStart}, not the day after ${lastEnd}` } : v));
    const kept = verdicts.filter((v) => v.ok).map((v) => ({ ...v.f, verificationMethod: METHOD, receipt: { ...v.f.receipt, comparison: v.comparison } })).filter((f) => obsApi.validSupplement(f, issuer.cik));
    return { doc, verdicts, kept, skipped };
}

function writeQuarter(issuer, kept, latest) {
    const file = path.join(DATA, 'supplemental-financials', issuer.cik + '.json');
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const ends = new Set(kept.map((f) => f.periodEnd));
    // Replace this quarter's earlier read, and drop release quarters the filed XBRL now covers.
    const others = (doc?.observations || []).filter((f) => !(f.verificationMethod === METHOD && (ends.has(f.periodEnd) || f.periodEnd <= latest)));
    const merged = obsApi.reconcile([], [...others, ...kept]);
    p.atomicWrite(file, { ...(doc || {}), schemaVersion: 1, issuer: issuer.cik, cik: issuer.cik, symbol: doc?.symbol || issuer.symbol, checkedAt: new Date().toISOString(), refreshStatus: 'success', observations: merged });
    return merged.length;
}

async function main() {
    const args = process.argv.slice(2);
    const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
    const cacheDir = path.resolve(opt('--cache', path.join(os.tmpdir(), 'release-quarter')));
    const symbols = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--cache').map((s) => s.toUpperCase());
    if (!symbols.length) { console.error('usage: fill-release-quarter.js SYMBOL... [--write] [--cache DIR]'); process.exit(2); }
    for (const symbol of symbols) {
        const issuer = issuerFor(symbol);
        if (!issuer) { console.log(`${symbol}: not a listed issuer with a CIK`); continue; }
        const data = JSON.parse(fs.readFileSync(path.join(DATA, 'sec-financials', issuer.cik + '.json'), 'utf8'));
        const filed = filedState(data);
        const found = await findRelease(issuer, filed.latest, cacheDir);
        if (found.periodic) { console.log(`${symbol}: ${found.periodic.form} for ${found.periodic.reportDate} is filed (${found.periodic.filingDate}); run refresh-sec-coverage.js --symbols ${symbol} instead`); continue; }
        if (!found.release) { console.log(`${symbol}: no earnings release after ${filed.latest}`); continue; }
        const got = await get(found.release.documentUrl, cacheDir);
        const read = readQuarter(got.text, { issuer, subs: found.subs, release: found.release, filed, retrievedAt: got.retrievedAt });
        console.log(`${symbol}: ${found.release.form} ${found.release.filingDate} ${found.release.documentUrl}`);
        for (const line of read.doc.log) if (!/9-month/.test(line)) console.log('  ' + line);
        for (const v of read.verdicts) console.log(`  ${v.ok ? 'kept   ' : 'dropped'} ${v.f.statement.padEnd(7)} ${v.f.field.padEnd(38)} ${v.f.periodEnd} ${String(v.f.value).padStart(16)}  ${v.ok ? `matches filed ${v.comparison.periodEnd}` : v.why}`);
        if (args.includes('--write') && read.kept.length) console.log(`  wrote ${read.kept.length} lines; ${writeQuarter(issuer, read.kept, filed.latest)} observations in supplemental-financials/${issuer.cik}.json`);
        else console.log(`  ${read.kept.length} lines would be kept (dry run)`);
    }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { filedState, check, readQuarter, writeQuarter, findRelease, METHOD };
