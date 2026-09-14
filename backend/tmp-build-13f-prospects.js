// Builds a B2B prospect list of institutional investment managers from SEC
// public data. Read-only against SEC; writes nothing to the repo.
//
// WHY 13F FILERS: every firm here files a 13F-HR, which means it manages over
// $100M in US equities and is legally obliged to report its holdings quarterly.
// Their entire job is analysing US-listed companies from filings — which is
// precisely what this product does. It is the closest thing to a register of
// the ICP that exists, and the SEC publishes it for public lookup.
//
// WHY NOT SCRAPED FROM SOCIAL: X and LinkedIn do not publish email addresses,
// prohibit automated collection, and harvesting personal data for unsolicited
// mail is a data-protection problem. SEC filer data is corporate contact
// information the filer submitted to a public register. Different thing.
//
// WHAT YOU GET: firm name, CIK, business address, business PHONE, SIC, state.
// NOT email — the SEC does not collect one. Email requires visiting each firm's
// own contact page, which is a separate, slower, per-firm step.
//
//   node tmp-build-13f-prospects.js <abs-out.csv> [maxFirms]
//
// Politeness: SEC asks for a declared User-Agent and <10 req/sec. This paces
// well under that and caches every fetch to <out>.cache.json so a re-run costs
// nothing.

const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
const MAX = Number(process.argv[3] || 200);
if (!OUT) { console.error('usage: node tmp-build-13f-prospects.js <abs-out.csv> [maxFirms]'); process.exit(1); }

const UA = 'StockPortfolio.pro research contact@stockportfolio.pro';
const CACHE = `${OUT}.cache.json`;
const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return {}; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { cacheKey } = {}) {
    if (cacheKey && cache[cacheKey]) return cache[cacheKey];
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const body = await res.json();
    if (cacheKey) { cache[cacheKey] = body; fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    await sleep(160);                     // ~6 req/sec, under SEC's limit
    return body;
}

// Firms whose 13F is incidental to a much bigger business, or who plainly are
// not buying a research tool. Banks and insurers file 13Fs for trust desks; the
// giant quant shops build everything in-house. Neither is the ICP, which is the
// small-to-mid adviser with no research team.
const EXCLUDE = /\b(BANK|BANCORP|TRUST CO|INSURANCE|LIFE INSURANCE|PENSION FUND|CITADEL|BLACKROCK|VANGUARD|STATE STREET|FIDELITY|GOLDMAN|MORGAN STANLEY|JPMORGAN|UBS|CREDIT SUISSE|DEUTSCHE|BARCLAYS|WELLS FARGO|NORTHERN TRUST|INVESCO|ALLIANZ|AMUNDI|SCHWAB)\b/i;

function cell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function cleanName(display) {
    // "Talon Private Wealth, LLC  (CIK 0001990467)" -> "Talon Private Wealth, LLC"
    return String(display || '').replace(/\s*\(CIK\s*\d+\)\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}

function formatPhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return String(raw || '').trim();
}

async function main() {
    // 1. Enumerate recent 13F-HR filers, newest first. efts caps at 10k results
    //    and pages 100 at a time; we only need enough distinct firms.
    const firms = new Map();
    for (let from = 0; from < 1000 && firms.size < MAX * 2; from += 100) {
        const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=13F-HR&from=${from}&hits=100`;
        let page;
        try { page = await getJson(url, { cacheKey: `efts:${from}` }); }
        catch (e) { console.error(`  page ${from} failed: ${e.message}`); break; }
        const hits = (page.hits && page.hits.hits) || [];
        if (!hits.length) break;
        for (const h of hits) {
            const src = h._source || {};
            const cik = (src.ciks || [])[0];
            const name = cleanName((src.display_names || [])[0]);
            if (!cik || !name || firms.has(cik)) continue;
            if (EXCLUDE.test(name)) continue;
            firms.set(cik, { cik, name, state: (src.biz_states || [])[0] || '', filed: src.file_date || '' });
        }
        process.stdout.write(`\r  enumerated ${firms.size} distinct firms...`);
    }
    console.log(`\n  ${firms.size} distinct 13F filers after excluding banks/insurers/mega-funds`);

    // 2. Pull the filer's own submitted contact details.
    const rows = [];
    const list = [...firms.values()].slice(0, MAX);
    for (let i = 0; i < list.length; i += 1) {
        const f = list[i];
        process.stdout.write(`\r  fetching contact details ${i + 1}/${list.length}...`);
        let sub;
        try { sub = await getJson(`https://data.sec.gov/submissions/CIK${f.cik}.json`, { cacheKey: `sub:${f.cik}` }); }
        catch (_) { continue; }
        const biz = (sub.addresses && sub.addresses.business) || {};
        // A firm with no phone and no street address is not contactable, and a
        // row you cannot act on is just noise in the list.
        if (!sub.phone && !biz.street1) continue;
        rows.push({
            firm: sub.name || f.name,
            cik: f.cik,
            // sicDescription is deliberately NOT carried: it is empty for every
            // 13F filer checked (they are advisers, not operating companies
            // with an assigned SIC), and an always-blank column is just noise
            // in a list someone has to work through by hand.
            phone: formatPhone(sub.phone),
            street: [biz.street1, biz.street2].filter(Boolean).join(', '),
            city: biz.city || '',
            state: biz.stateOrCountry || f.state,
            zip: biz.zipCode || '',
            country: biz.isForeignLocation ? (biz.countryCode || 'foreign') : 'US',
            lastFiled: f.filed,
            edgar: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${f.cik}&type=13F`
        });
    }

    // US firms first: the product is US-filing-only, so a US adviser is a
    // better fit and a foreign one may not even cover these companies.
    rows.sort((a, b) => (a.country === 'US' ? 0 : 1) - (b.country === 'US' ? 0 : 1) || a.firm.localeCompare(b.firm));

    const cols = ['firm', 'cik', 'phone', 'street', 'city', 'state', 'zip', 'country', 'lastFiled', 'edgar'];
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');

    console.log(`\n\nwrote ${rows.length} contactable firms to ${OUT}`);
    console.log(`  with a phone number: ${rows.filter((r) => r.phone).length}`);
    console.log(`  US-based: ${rows.filter((r) => r.country === 'US').length}`);
    const states = {};
    for (const r of rows) if (r.country === 'US' && r.state) states[r.state] = (states[r.state] || 0) + 1;
    console.log('  top states:', Object.entries(states).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s}:${n}`).join(' '));
    console.log('\nNOTE: SEC publishes no email address. These rows carry firm, phone and');
    console.log('postal address. Getting an email means visiting each firm\'s contact page.');
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
