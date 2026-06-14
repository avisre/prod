// Guru portfolio tracker — famous investors' 13F-HR holdings from SEC EDGAR.
// Cached in MongoDB for 24 h; stale-while-revalidate on first hit after expiry.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const guruAnalysis = require('./guru-analysis');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const GURU_LIST = [
    // ── Legendary value / concentrated investors ──────────────────────────────
    { id: 'berkshire',    name: 'Warren Buffett',         fund: 'Berkshire Hathaway',           cik: '0001067983' },
    { id: 'pershing',     name: 'Bill Ackman',            fund: 'Pershing Square Capital',      cik: '0001336528' },
    { id: 'baupost',      name: 'Seth Klarman',           fund: 'Baupost Group',                cik: '0001061768' },
    { id: 'scion',        name: 'Michael Burry',          fund: 'Scion Asset Management',       cik: '0001649339' },
    { id: 'duquesne',     name: 'Stanley Druckenmiller',  fund: 'Duquesne Family Office',       cik: '0001536411' },
    { id: 'soros',        name: 'George Soros',           fund: 'Soros Fund Management',        cik: '0001029160' },
    { id: 'himalaya',     name: 'Li Lu',                  fund: 'Himalaya Capital Management',  cik: '0001709323' },
    { id: 'southeastern', name: 'Mason Hawkins',          fund: 'Southeastern Asset Management',cik: '0000807985' },
    { id: 'abrams',       name: 'David Abrams',           fund: 'Abrams Capital Management',    cik: '0001358706' },
    { id: 'yacktman',     name: 'Donald Yacktman',        fund: 'Yacktman Asset Management',    cik: '0000905567' },
    { id: 'tweedy',       name: 'Tweedy Browne',          fund: 'Tweedy Browne Company',        cik: '0000732905' },
    { id: 'akre',         name: 'Chuck Akre',             fund: 'Akre Capital Management',      cik: '0001112520' },
    { id: 'davis',        name: 'Christopher Davis',      fund: 'Davis Advisors',               cik: '0001036325' },
    // ── Macro & quant ────────────────────────────────────────────────────────
    { id: 'renaissance',  name: 'Jim Simons',             fund: 'Renaissance Technologies',     cik: '0001037389' },
    { id: 'bridgewater',  name: 'Ray Dalio',              fund: 'Bridgewater Associates',       cik: '0001350694' },
    // ── Event-driven / activist ───────────────────────────────────────────────
    { id: 'thirdpoint',   name: 'Dan Loeb',               fund: 'Third Point',                  cik: '0001040273' },
    { id: 'appaloosa',    name: 'David Tepper',           fund: 'Appaloosa Management',         cik: '0001656456' },
    { id: 'greenlight',   name: 'David Einhorn',          fund: 'Greenlight Capital',           cik: '0001489933' },
    { id: 'tci',          name: 'Chris Hohn',             fund: 'TCI Fund Management',          cik: '0001647251' },
    { id: 'valueact',     name: 'Mason Morfit',           fund: 'ValueAct Capital',             cik: '0001418814' },
    { id: 'cooperman',    name: 'Leon Cooperman',         fund: 'Omega Advisors',               cik: '0000898382' },
    // ── Long-biased fundamental hedge funds ──────────────────────────────────
    { id: 'viking',       name: 'Andreas Halvorsen',      fund: 'Viking Global Investors',      cik: '0001103804' },
    { id: 'tigerglob',    name: 'Chase Coleman',          fund: 'Tiger Global Management',      cik: '0001167483' },
    { id: 'lonepine',     name: 'Stephen Mandel',         fund: 'Lone Pine Capital',            cik: '0001061165' },
    { id: 'maverick',     name: 'Lee Ainslie',            fund: 'Maverick Capital',             cik: '0000934639' },
    { id: 'durable',      name: 'Henry Ellenbogen',       fund: 'Durable Capital Partners',     cik: '0001798849' },
    // ── Diversified / institutional ───────────────────────────────────────────
    { id: 'ariel',        name: 'John Rogers',            fund: 'Ariel Investments',            cik: '0000936753' },
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

// ─── Portfolio performance computation ────────────────────────────────────────
// "Performance" here = if you bought the CURRENT 13F portfolio at a past date,
// what would your return be today? Computed from current Yahoo Finance prices
// vs historical monthly closes. NOT the fund's actual realised returns.

const PERF_PERIODS = [
    { key: '3m', months: 3 },
    { key: '6m', months: 6 },
    { key: '1y', months: 12 },
    { key: '5y', months: 60 },
    { key: '10y', months: 120 },
    { key: '15y', months: 180 },
];

// Shared across all guru builds in this process lifetime.
let _nameTickerMap = null;
const _monthlyCache = new Map(); // ticker → Map<'YYYY-MM', adjClose>

// Normalize a company name for matching: uppercase, strip common suffixes + punctuation.
function normName(s) {
    return s.toUpperCase()
        .replace(/[.,&''']/g, ' ')
        .replace(/\b(THE|INC|CORP|CORPORATION|CO|LTD|LIMITED|LLC|PLC|HOLDINGS|HLDGS|HOLDING|GROUP|GRP|INTL|INTERNATIONAL|TECHNOLOGIES|TECHNOLOGY|TECH|SYSTEMS|INDUSTRIES|INDUSTRY|ENTERPRISES|SERVICES|SOLUTIONS|PARTNERS|CAPITAL|MGMT|MANAGEMENT|COMMON|STOCK|SHS|SHARES|CLASS [AB]|CL [AB]|ADR|ORD|CVR|DEL|NEW|A|B)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

async function loadNameTickerMap() {
    if (_nameTickerMap) return _nameTickerMap;
    const r = await axios.get('https://www.sec.gov/files/company_tickers.json', {
        headers: secSource.SEC_HEADERS, timeout: 15000,
    });
    _nameTickerMap = new Map();
    for (const v of Object.values(r.data || {})) {
        if (!v.ticker || !v.title) continue;
        const norm = normName(v.title);
        if (norm && !_nameTickerMap.has(norm)) _nameTickerMap.set(norm, v.ticker.toUpperCase());
    }
    return _nameTickerMap;
}

function matchTicker(holdingName, nameMap) {
    const norm = normName(holdingName);
    if (nameMap.has(norm)) return nameMap.get(norm);
    // Progressive word-drop from the right (handles "BERKSHIRE HATHAWAY B" → "BERKSHIRE HATHAWAY")
    const words = norm.split(' ').filter(Boolean);
    for (let len = words.length - 1; len >= 2; len--) {
        const k = words.slice(0, len).join(' ');
        if (nameMap.has(k)) return nameMap.get(k);
    }
    return null;
}

// Fetch 16 years of monthly history for one ticker, cache it.
async function getMonthlyHistory(ticker) {
    const yt = ticker.replace(/\./g, '-');
    if (_monthlyCache.has(yt)) return _monthlyCache.get(yt);
    const now = new Date();
    const from = new Date(now); from.setFullYear(from.getFullYear() - 16);
    const empty = new Map();
    try {
        const rows = await yf.historical(yt, {
            period1: from.toISOString().slice(0, 10),
            period2: now.toISOString().slice(0, 10),
            interval: '1mo',
        });
        const byMonth = new Map(rows.filter(r => r.adjClose).map(r => [r.date.toISOString().slice(0, 7), r.adjClose]));
        _monthlyCache.set(yt, byMonth);
        return byMonth;
    } catch (_) {
        _monthlyCache.set(yt, empty);
        return empty;
    }
}

// Get the closest available monthly close to N months ago.
function priceNMonthsAgo(history, months) {
    const d = new Date(); d.setMonth(d.getMonth() - months);
    for (let delta = 0; delta <= 3; delta++) {
        const try1 = new Date(d); try1.setMonth(try1.getMonth() - delta);
        const k1 = try1.toISOString().slice(0, 7);
        if (history.has(k1)) return history.get(k1);
        if (delta > 0) {
            const try2 = new Date(d); try2.setMonth(try2.getMonth() + delta);
            const k2 = try2.toISOString().slice(0, 7);
            if (history.has(k2)) return history.get(k2);
        }
    }
    return null;
}

// Compute hypothetical performance for each period given the top holdings.
async function computePerformance(holdings) {
    const nameMap = await loadNameTickerMap().catch(() => null);
    if (!nameMap) return null;

    // Match top-30 holdings to tickers (top 30 typically covers 70-90%+ of value)
    const candidates = holdings.slice(0, 30).filter(h => h.shareType !== 'PRN' && h.weight > 0);
    const matched = [];
    for (const h of candidates) {
        const ticker = matchTicker(h.name, nameMap);
        if (ticker) matched.push({ ticker, weight: h.weight });
    }
    if (!matched.length) return null;

    // Fetch monthly history for each unique ticker (shared across gurus via _monthlyCache)
    const uniqueTickers = [...new Set(matched.map(m => m.ticker))];
    for (const ticker of uniqueTickers) {
        await getMonthlyHistory(ticker);
        await sleep(80);
    }

    // Current price = latest entry in the monthly history
    const curPrice = new Map();
    for (const ticker of uniqueTickers) {
        const h = _monthlyCache.get(ticker.replace(/\./g, '-')) || new Map();
        if (!h.size) continue;
        const latest = [...h.entries()].sort((a, b) => b[0].localeCompare(a[0]))[0];
        if (latest) curPrice.set(ticker, latest[1]);
    }

    // Compute weighted return for each period
    const result = {};
    const coverage = matched.filter(m => curPrice.has(m.ticker)).reduce((s, m) => s + m.weight, 0);
    if (coverage < 10) return null; // can't compute meaningfully

    for (const { key, months } of PERF_PERIODS) {
        let weightedRet = 0, covW = 0;
        for (const { ticker, weight } of matched) {
            const cur = curPrice.get(ticker);
            if (!cur) continue;
            const hist = _monthlyCache.get(ticker.replace(/\./g, '-'));
            const past = hist ? priceNMonthsAgo(hist, months) : null;
            if (!past) continue;
            const ret = (cur - past) / past;
            weightedRet += weight * ret;
            covW += weight;
        }
        if (covW >= 10) {
            // Scale to full portfolio (assumes unmatched holdings performed similarly)
            result[key] = parseFloat(((weightedRet / covW) * 100).toFixed(2));
        }
    }
    return Object.keys(result).length ? { periods: result, coverage: parseFloat(coverage.toFixed(1)) } : null;
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

        // Compute hypothetical performance from current holdings × Yahoo Finance history
        const performance = await computePerformance(top50).catch(() => null);

        // AI analysis (Pro feature) — numbers computed in code, model writes prose.
        const analysis = await guruAnalysis.generate({
            name: guru.name, fund: guru.fund,
            reportingPeriod: filings[0].period,
            prevPeriod: filings[1] ? filings[1].period : null,
            totalValue, holdingsTotal: all.length,
            holdings: top50, sells, performance, hasActivity,
        }).catch((e) => { console.warn(`[gurus] analysis failed for ${guru.id}:`, e.message); return null; });

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
            performance,
            analysis,
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

// ─── Cache pre-warming ────────────────────────────────────────────────────────
// The lazy stale-while-revalidate path in holdings() means the very first
// visitor to a cold guru is served an empty "building" page while the 30-60s
// EDGAR+Yahoo build runs. 13F data only changes quarterly (and the perf strip is
// re-priced against today's close), so we proactively (re)build every guru into
// MongoDB on a daily cycle. After the first warm pass every page is instant.
const REFRESH_INTERVAL_MS = 24 * 3600 * 1000;

async function refreshAll() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    const col = mongoose.connection.collection('guru_portfolios');
    const existing = await col.find({}, { projection: { id: 1, builtAt: 1 } }).toArray();
    const builtAt = new Map(existing.map((d) => [d.id, new Date(d.builtAt).getTime()]));
    let built = 0, fresh = 0;
    for (const guru of GURU_LIST) {
        const ts = builtAt.get(guru.id);
        if (ts && Date.now() - ts < CACHE_TTL_MS) { fresh++; continue; }
        await buildGuru(guru); // builds sequentially — buildGuru self-rate-limits + logs its own errors
        built++;
        await sleep(STEP_MS); // breathing room between gurus
    }
    return { built, fresh, total: GURU_LIST.length };
}

// Kick off the prewarm scheduler (called once from app.js after the server boots).
function start() {
    if (String(process.env.GURU_PREWARM || '1') === '0') {
        console.log('[gurus] prewarm disabled via GURU_PREWARM=0');
        return;
    }
    // Delay the first sweep so it doesn't fight boot/Mongo-connect; staggered
    // 30s past the watchdog's 90s initial sweep to avoid a cold-start spike.
    setTimeout(() => {
        refreshAll().then((r) => console.log('[gurus] initial prewarm', JSON.stringify(r))).catch((e) => console.error('[gurus] prewarm error', e.message));
    }, 120 * 1000);
    setInterval(() => {
        refreshAll().then((r) => console.log('[gurus] refresh', JSON.stringify(r))).catch(() => {});
    }, REFRESH_INTERVAL_MS);
    console.log(`[gurus] prewarm scheduled every ${Math.round(REFRESH_INTERVAL_MS / 60000)} min`);
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

module.exports = { list, holdings, buildGuru, refreshAll, start, GURU_LIST };
