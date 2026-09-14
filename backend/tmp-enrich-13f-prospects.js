// Stage 2 of the prospect build: for each firm from tmp-build-13f-prospects.js,
// read its latest 13F holdings and find the highest-materiality brief we hold
// on a stock THAT FIRM ACTUALLY OWNS.
//
// This is the part that makes the outreach defensible. A generic pitch to 160
// advisers is spam whatever the sending domain. "Here is what changed in the
// latest 10-K of a company you hold $90M of, with the filing link" is a
// research note — it is useful to them even if they never reply, and it is
// checkable against their own public filing.
//
// Also yields portfolio value, which is the ranking signal the raw list lacked:
// a $3.5B adviser is a Desk prospect, a $120M one is Pro.
//
//   node tmp-enrich-13f-prospects.js <in.csv> <out.csv> [maxFirms]
//
// Read-only. SEC requests are paced and cached to <out>.cache.json.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const IN = process.argv[2];
const OUT = process.argv[3];
const MAX = Number(process.argv[4] || 100);
if (!IN || !OUT) { console.error('usage: node tmp-enrich-13f-prospects.js <in.csv> <out.csv> [maxFirms]'); process.exit(1); }

const UA = 'StockPortfolio.pro research contact@stockportfolio.pro';
const CACHE = `${OUT}.cache.json`;
const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return {}; } })();
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, key, json) {
    if (key && cache[key] !== undefined) return cache[key];
    let out = null;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
        if (res.ok) out = json ? await res.json() : await res.text();
    } catch (_) { /* leave null */ }
    if (key) { cache[key] = out; saveCache(); }
    await sleep(160);
    return out;
}

function parseCsv(text) {
    const rows = [];
    for (const line of text.trim().split('\n')) {
        const out = []; let cur = ''; let q = false;
        for (let i = 0; i < line.length; i += 1) {
            const c = line[i];
            if (q) {
                if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
                else if (c === '"') q = false;
                else cur += c;
            } else if (c === '"') q = true;
            else if (c === ',') { out.push(cur); cur = ''; }
            else cur += c;
        }
        out.push(cur); rows.push(out);
    }
    const hdr = rows[0];
    return rows.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i]])));
}

function cell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 13F issuer names are terse and inconsistent ("M & T BK CORP", "BERKLEY W R
// CORP"), so matching is done on a normalised key with the corporate suffixes
// and punctuation stripped. Deliberately conservative: a wrong match would put
// the wrong company in a research note sent to someone who owns the real one,
// which is worse than no match at all.
function normName(s) {
    return String(s || '')
        .toUpperCase()
        .replace(/&AMP;/g, '&')
        .replace(/[^A-Z0-9 ]/g, ' ')
        .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LP|HOLDINGS?|GROUP|CLASS [A-C]|COM|NEW|THE)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function main() {
    const firms = parseCsv(fs.readFileSync(IN, 'utf8'));
    console.log(`input: ${firms.length} firms`);

    // Name -> ticker, from our own company universe.
    const companiesFile = require(path.join(__dirname, '..', 'frontend', 'data', 'us-companies.json'));
    // The file is {generatedAt, source, count, companies:[...]}, not a bare array.
    const companies = Array.isArray(companiesFile) ? companiesFile : (companiesFile.companies || []);
    if (!companies.length) throw new Error('us-companies.json has no companies array');
    const byName = new Map();
    for (const c of companies) {
        const k = normName(c.name);
        if (k && !byName.has(k)) byName.set(k, c.symbol);
    }
    console.log(`company name index: ${byName.size} entries`);

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    const reports = mongoose.connection.collection('filing_reports');
    // Best brief per symbol: highest materiality, then most recent.
    const best = new Map();
    for (const d of await reports.find({ 'payload.materiality': { $gte: 50 } })
        .project({ symbol: 1, filedDate: 1, 'payload.materiality': 1, 'payload.materialityBucket': 1, 'payload.latestFiling': 1, 'payload.summary': 1 })
        .toArray()) {
        const cur = best.get(d.symbol);
        const m = d.payload.materiality;
        if (!cur || m > cur.materiality) {
            best.set(d.symbol, {
                materiality: m,
                bucket: d.payload.materialityBucket,
                form: (d.payload.latestFiling || {}).form,
                filed: (d.payload.latestFiling || {}).date,
                summary: String(d.payload.summary || '').slice(0, 160)
            });
        }
    }
    console.log(`briefs available: ${best.size} symbols at materiality >= 50`);

    const rows = [];
    const list = firms.slice(0, MAX);
    for (let i = 0; i < list.length; i += 1) {
        const f = list[i];
        process.stdout.write(`\r  ${i + 1}/${list.length} ${f.firm.slice(0, 40).padEnd(40)}`);

        const sub = await get(`https://data.sec.gov/submissions/CIK${f.cik}.json`, `sub:${f.cik}`, true);
        const recent = sub && sub.filings && sub.filings.recent;
        if (!recent) continue;
        const idx = recent.form.findIndex((x) => x === '13F-HR');
        if (idx < 0) continue;
        const accession = recent.accessionNumber[idx];
        const rawCik = String(Number(f.cik));
        const dir = `https://www.sec.gov/Archives/edgar/data/${rawCik}/${accession.replace(/-/g, '')}`;

        // Find the info table. Its filename varies, so read the directory.
        const listing = await get(`${dir}/`, `dir:${accession}`, false);
        if (!listing) continue;
        const xmls = [...new Set([...String(listing).matchAll(/([a-zA-Z0-9_.\-]+\.xml)/g)].map((m) => m[1]))]
            .filter((n) => !/primary_doc/i.test(n));
        if (!xmls.length) continue;
        const xml = await get(`${dir}/${xmls[0]}`, `info:${accession}`, false);
        if (!xml || !/infoTable/i.test(xml)) continue;

        const names = [...xml.matchAll(/<(?:\w+:)?nameOfIssuer>([^<]+)</gi)].map((m) => m[1]);
        const values = [...xml.matchAll(/<(?:\w+:)?value>([^<]+)</gi)].map((m) => Number(m[1]) || 0);
        if (!names.length) continue;

        const portfolio = values.reduce((a, b) => a + b, 0);
        // Pick the match by MATERIALITY, not by position size.
        //
        // Ranking by largest position was the obvious choice and it was wrong:
        // measured over 143 firms it returned AAPL for 44 of them and NVDA for
        // 29, because every adviser holds the mega-caps. "Here is a brief about
        // Apple" is the generic pitch this whole exercise exists to avoid — it
        // tells the recipient nothing they could not get anywhere, and it is
        // indistinguishable from a mail merge.
        //
        // The interesting row is the firm holding something less obvious whose
        // latest filing genuinely moved: a $90M ADI position against a
        // materiality-98 brief is a conversation, a $3.3B AAPL position against
        // a 66 is not. Mega-caps are demoted rather than excluded, so they can
        // still match a firm that holds nothing else we cover.
        const MEGA = new Set(['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA']);
        let match = null;
        for (let h = 0; h < names.length; h += 1) {
            const sym = byName.get(normName(names[h]));
            if (!sym) continue;
            const brief = best.get(sym);
            if (!brief) continue;
            const position = values[h] || 0;
            const score = brief.materiality - (MEGA.has(sym) ? 40 : 0);
            if (!match || score > match.score || (score === match.score && position > match.position)) {
                match = { symbol: sym, position, score, issuer: names[h].trim(), ...brief };
            }
        }
        if (!match) continue;

        rows.push({
            firm: f.firm, phone: f.phone, city: f.city, state: f.state, country: f.country, cik: f.cik,
            portfolioUsd: portfolio,
            holdings: names.length,
            tier: portfolio >= 1e9 ? 'Desk' : portfolio >= 2e8 ? 'Pro' : 'Core',
            briefSymbol: match.symbol,
            briefPosition: match.position,
            briefMateriality: match.materiality,
            briefForm: `${match.form} ${match.filed}`,
            briefHook: match.summary,
            edgar: f.edgar
        });
    }

    rows.sort((a, b) => b.portfolioUsd - a.portfolioUsd);
    const cols = ['firm', 'phone', 'city', 'state', 'country', 'tier', 'portfolioUsd', 'holdings', 'briefSymbol', 'briefPosition', 'briefMateriality', 'briefForm', 'briefHook', 'cik', 'edgar'];
    fs.writeFileSync(OUT, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');

    console.log(`\n\nwrote ${rows.length} matched prospects to ${OUT}`);
    const byTier = {};
    for (const r of rows) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    console.log('by suggested tier:', JSON.stringify(byTier));
    console.log('\ntop 10 by portfolio size:');
    for (const r of rows.slice(0, 10)) {
        console.log(`  ${r.firm.slice(0, 34).padEnd(34)} $${(r.portfolioUsd / 1e9).toFixed(2)}B  ${r.state.padEnd(3)} -> ${r.briefSymbol} (holds $${(r.briefPosition / 1e6).toFixed(0)}M, materiality ${r.briefMateriality})`);
    }
    await mongoose.disconnect();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
