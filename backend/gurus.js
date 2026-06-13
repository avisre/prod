// Guru portfolio tracker — famous investors' 13F-HR holdings from SEC EDGAR.
// Cached in MongoDB for 24 h; stale-while-revalidate on first hit after expiry.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');

const GURU_LIST = [
    { id: 'berkshire',   name: 'Warren Buffett',         fund: 'Berkshire Hathaway',        cik: '0001067983' },
    { id: 'pershing',    name: 'Bill Ackman',             fund: 'Pershing Square Capital',   cik: '0001336528' },
    { id: 'baupost',     name: 'Seth Klarman',            fund: 'Baupost Group',             cik: '0001061768' },
    { id: 'thirdpoint',  name: 'Dan Loeb',                fund: 'Third Point',               cik: '0001040273' },
    { id: 'appaloosa',   name: 'David Tepper',            fund: 'Appaloosa Management',      cik: '0001656456' },
    { id: 'greenlight',  name: 'David Einhorn',           fund: 'Greenlight Capital',        cik: '0001489933' },
    { id: 'viking',      name: 'Andreas Halvorsen',       fund: 'Viking Global Investors',   cik: '0001103804' },
    { id: 'scion',       name: 'Michael Burry',           fund: 'Scion Asset Management',    cik: '0001649339' },
    { id: 'duquesne',    name: 'Stanley Druckenmiller',   fund: 'Duquesne Family Office',    cik: '0001536411' },
    { id: 'renaissance', name: 'Jim Simons',              fund: 'Renaissance Technologies',  cik: '0001037389' },
];

const CACHE_TTL_MS = 24 * 3600 * 1000;
const STEP_MS = 200; // stay inside SEC fair-use
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Pad CIK to 10 digits for data.sec.gov URLs
function pad(cik) {
    return String(cik).replace(/^0+/, '').padStart(10, '0');
}

// Find the most recent 13F-HR filings (one per reporting period, amendments
// supersede the original) → array sorted newest-period-first, capped at `limit`.
// We need two: the latest for current holdings, the prior for the activity diff.
async function recentFilings(cik, limit = 2) {
    const url = `https://data.sec.gov/submissions/CIK${pad(cik)}.json`;
    const r = await axios.get(url, { headers: secSource.SEC_HEADERS, timeout: 20000 });
    const f = r.data?.filings?.recent;
    if (!f || !Array.isArray(f.form)) return [];
    const byPeriod = new Map();
    for (let i = 0; i < f.form.length; i++) {
        if (f.form[i] !== '13F-HR' && f.form[i] !== '13F-HR/A') continue;
        const filingDate = String(f.filingDate?.[i] || '');
        const period = String(f.reportDate?.[i] || filingDate);
        const entry = {
            accession: String(f.accessionNumber[i]),
            primaryDocument: String(f.primaryDocument?.[i] || ''),
            date: filingDate,
            period,
        };
        const prev = byPeriod.get(period);
        if (!prev || filingDate > prev.date) byPeriod.set(period, entry); // amendment wins
    }
    return [...byPeriod.values()]
        .sort((a, b) => (a.period < b.period ? 1 : -1))
        .slice(0, limit);
}

// Locate the InfoTable XML for a given accession. Tries the primary document
// first; if that's the cover page, falls back to parsing the EDGAR index HTML.
async function findInfoTable(rawCik, accession, primaryDoc) {
    const clean = accession.replace(/-/g, '');
    const base = `https://www.sec.gov/Archives/edgar/data/${rawCik}/${clean}`;

    // 1. If the primary doc looks like an XML file, try it first
    if (primaryDoc && /\.xml$/i.test(primaryDoc)) {
        try {
            const doc = primaryDoc.replace(/^xsl[^/]*\//, '');
            const r = await axios.get(`${base}/${doc}`, {
                headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 30e6,
            });
            const xml = String(r.data);
            if (/<(?:[\w-]+:)?infoTable/i.test(xml)) return xml;
        } catch (_) { /* fall through */ }
        await sleep(STEP_MS);
    }

    // 2. Fetch the EDGAR filing index HTML and find the InfoTable document
    let idxHtml = '';
    try {
        const idxUrl = `${base}/${accession}-index.htm`;
        const idxR = await axios.get(idxUrl, { headers: secSource.SEC_HEADERS, timeout: 15000 });
        idxHtml = String(idxR.data);
    } catch (_) { /* no index */ }
    await sleep(STEP_MS);

    // Extract XML filename from index: look for rows mentioning "INFORMATION TABLE"
    let xmlFile = null;
    if (idxHtml) {
        const infoRow = idxHtml.match(/INFORMATION TABLE[\s\S]{0,400}?href="([^"?#]+\.xml)"/i);
        if (infoRow) {
            xmlFile = infoRow[1].split('/').pop();
        } else {
            // Grab all .xml hrefs and pick the last one (typically the infotable)
            const allXml = [...idxHtml.matchAll(/href="([^"?#]+\.xml)"/gi)].map((m) => m[1].split('/').pop());
            // Prefer filenames that hint at holdings; otherwise take the last .xml
            xmlFile = allXml.find((f) => /info|table|holding|13f/i.test(f)) || allXml[allXml.length - 1] || null;
        }
    }

    // 3. Try common fallback filenames
    const candidates = [
        xmlFile,
        'infotable.xml',
        'form13fInfoTable.xml',
        'INFORMATION_TABLE.xml',
        `${clean}.xml`,
    ].filter(Boolean);

    for (const fname of candidates) {
        try {
            const r = await axios.get(`${base}/${fname}`, {
                headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 30e6,
            });
            const xml = String(r.data);
            if (/<(?:[\w-]+:)?infoTable/i.test(xml)) return xml;
        } catch (_) { /* try next */ }
        await sleep(STEP_MS);
    }
    return null;
}

// Parse InfoTable XML → array of raw holding rows (one per <infoTable> block).
// Value is returned exactly as filed; unit scaling happens in `scaleValues`.
function parseInfoTable(xml) {
    const pick = (block, tag) => {
        const re = new RegExp(`<(?:[\\w-]*:)?${tag}[^>]*>(.*?)<\\/(?:[\\w-]*:)?${tag}>`, 'i');
        const m = re.exec(block);
        return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
    };
    const blocks = xml.match(/<(?:[\w-]+:)?infoTable>[\s\S]*?<\/(?:[\w-]+:)?infoTable>/gi) || [];
    const out = [];
    for (const b of blocks) {
        const name = pick(b, 'nameOfIssuer');
        const cusip = pick(b, 'cusip');
        const value = num(pick(b, 'value'));
        const shares = num(pick(b, 'sshPrnamt'));
        const shareType = pick(b, 'sshPrnamtType');
        if (!name || value === null) continue;
        out.push({
            name: name.replace(/\s+/g, ' '),
            cusip: cusip || null,
            value,
            shares,
            shareType: shareType || 'SH',
        });
    }
    return out;
}

// The SEC's Jan 3 2023 amendment switched Value from thousands to whole dollars,
// but some filers still report in thousands. Detect units by implied share price
// (value/shares): a portfolio whose median implied price is under $1 is filed in
// thousands and gets scaled ×1000. Falls back to the filing date when too few
// share-priced rows exist (e.g. an all-bond portfolio). Mutates rows in place.
function scaleValues(rows, filingDate) {
    const prices = [];
    for (const r of rows) {
        if (r.shareType === 'SH' && r.shares > 0 && r.value > 0) prices.push(r.value / r.shares);
    }
    let thousands;
    if (prices.length >= 3) {
        prices.sort((a, b) => a - b);
        thousands = prices[Math.floor(prices.length / 2)] < 1;
    } else {
        thousands = filingDate < '2023-01-03';
    }
    if (thousands) for (const r of rows) r.value *= 1000;
    return rows;
}

// A single 13F lists a position once per investment-discretion bucket, so a
// stock can appear many times (Berkshire's Apple spans several rows). Collapse
// to one row per issuer (keyed by CUSIP, falling back to name), summing value
// and shares — this is what guru-tracker sites display as "holdings".
function aggregate(rows) {
    const byKey = new Map();
    for (const r of rows) {
        const key = (r.cusip || r.name).toUpperCase();
        const cur = byKey.get(key);
        if (cur) {
            cur.value += r.value || 0;
            cur.shares = (cur.shares || 0) + (r.shares || 0);
        } else {
            byKey.set(key, { name: r.name, cusip: r.cusip, value: r.value || 0, shares: r.shares || 0, shareType: r.shareType });
        }
    }
    return [...byKey.values()].sort((a, b) => (b.value || 0) - (a.value || 0));
}

// Fetch + aggregate the holdings for one filing → unique-issuer rows.
async function holdingsForFiling(rawCik, filing) {
    const xml = await findInfoTable(rawCik, filing.accession, filing.primaryDocument);
    if (!xml) return null;
    return aggregate(scaleValues(parseInfoTable(xml), filing.date));
}

// Classify a current holding against the prior quarter's position.
function classify(cur, prevMap, hasPrev) {
    const key = (cur.cusip || cur.name).toUpperCase();
    const p = prevMap.get(key);
    if (!hasPrev) return { activity: null, shareChangePct: null, prevShares: null };
    if (!p) return { activity: 'new', shareChangePct: null, prevShares: 0 };
    const prevShares = p.shares || 0;
    const cs = cur.shares || 0;
    if (prevShares <= 0) return { activity: 'hold', shareChangePct: null, prevShares };
    const d = (cs - prevShares) / prevShares;
    if (d > 0.005) return { activity: 'add', shareChangePct: d * 100, prevShares };
    if (d < -0.005) return { activity: 'reduce', shareChangePct: d * 100, prevShares };
    return { activity: 'hold', shareChangePct: null, prevShares };
}

// Build one guru's portfolio (current holdings + activity diff) and save to MongoDB
const _building = new Set();
async function buildGuru(guru) {
    if (_building.has(guru.id)) return;
    _building.add(guru.id);
    try {
        const filings = await recentFilings(guru.cik, 2);
        if (!filings.length) return;
        const rawCik = String(guru.cik).replace(/^0+/, '');
        await sleep(STEP_MS);

        const all = await holdingsForFiling(rawCik, filings[0]);
        if (!all || !all.length) return;

        // Prior quarter for the activity diff (best-effort — page still works without it)
        const prevMap = new Map();
        if (filings[1]) {
            await sleep(STEP_MS);
            const prevRows = await holdingsForFiling(rawCik, filings[1]).catch(() => null);
            if (prevRows) for (const h of prevRows) prevMap.set((h.cusip || h.name).toUpperCase(), h);
        }
        const hasActivity = prevMap.size > 0;

        const totalValue = all.reduce((s, h) => s + (h.value || 0), 0);
        const top50 = all.slice(0, 50).map((h) => {
            const c = classify(h, prevMap, hasActivity);
            return {
                ...h,
                weight: totalValue > 0 ? (h.value / totalValue) * 100 : 0,
                reportedPrice: h.shareType !== 'PRN' && h.shares > 0 ? h.value / h.shares : null,
                ...c,
            };
        });

        // Sold-out positions: held last quarter, gone this quarter.
        let sells = [];
        if (hasActivity) {
            const curKeys = new Set(all.map((h) => (h.cusip || h.name).toUpperCase()));
            for (const [k, p] of prevMap) {
                if (!curKeys.has(k)) sells.push({ name: p.name, cusip: p.cusip, prevShares: p.shares, prevValue: p.value });
            }
            sells.sort((a, b) => (b.prevValue || 0) - (a.prevValue || 0));
            sells = sells.slice(0, 25);
        }

        const doc = {
            id: guru.id,
            name: guru.name,
            fund: guru.fund,
            cik: guru.cik,
            filingDate: filings[0].date,
            reportingPeriod: filings[0].period,
            prevPeriod: filings[1] ? filings[1].period : null,
            accession: filings[0].accession,
            totalValue,
            holdingsTotal: all.length,
            holdings: top50,
            sells,
            hasActivity,
            builtAt: new Date(),
        };

        const col = mongoose.connection.collection('guru_portfolios');
        await col.updateOne({ id: guru.id }, { $set: doc }, { upsert: true });
    } catch (err) {
        console.error(`[gurus] build failed for ${guru.id}:`, err.message);
    } finally {
        _building.delete(guru.id);
    }
}

function list() {
    return GURU_LIST.map(({ id, name, fund }) => ({ id, name, fund }));
}

async function holdings(id) {
    const guru = GURU_LIST.find((g) => g.id === id);
    if (!guru) return null;
    const col = mongoose.connection.collection('guru_portfolios');
    const cached = await col.findOne({ id }, { projection: { _id: 0 } });
    const stale = !cached || Date.now() - new Date(cached.builtAt).getTime() > CACHE_TTL_MS;
    if (stale && !_building.has(id)) buildGuru(guru).catch(() => {});
    if (cached) return cached;
    return { id, name: guru.name, fund: guru.fund, holdings: [], building: true };
}

module.exports = { list, holdings, buildGuru, GURU_LIST };
