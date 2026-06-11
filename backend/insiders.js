// Insider history — the real Form 4 trail, parsed from EDGAR.
//
// Every insider trade is a filed Form 4. We list a company's Form 4s for the
// last ~3 years (recent window + archive files), fetch each raw XML once,
// classify transactions by SEC transaction code (P = open-market purchase,
// S = open-market sale; everything else — awards, exercises, gifts, tax
// withholding — is 'other' and excluded from the buy/sell signal), and cache
// the parsed filing in Mongo permanently. First build for a company takes
// ~1-2 minutes (SEC fair-use pacing), so it runs in the background; the
// route answers immediately with whatever is already built.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');

const YEARS_BACK = 3;
const MAX_FILINGS = 400;
const FETCH_GAP_MS = 130; // ~7 req/s, inside SEC fair-use

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- list Form 4 filings (recent + archives) back to the cutoff ----
async function listForm4(symbol) {
    const cik = await secSource.cikFor(symbol);
    if (!cik) return null;
    const cutoff = new Date(Date.now() - YEARS_BACK * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const out = [];
    const scan = (cols) => {
        if (!cols || !Array.isArray(cols.accessionNumber)) return false;
        let reachedCutoff = false;
        for (let i = 0; i < cols.accessionNumber.length && out.length < MAX_FILINGS; i++) {
            if (String(cols.form?.[i] || '') !== '4') continue;
            const date = String(cols.filingDate?.[i] || '');
            if (date && date < cutoff) { reachedCutoff = true; continue; }
            const accession = String(cols.accessionNumber[i]);
            const doc = String(cols.primaryDocument?.[i] || '');
            if (!doc) continue;
            out.push({
                accession,
                date,
                // primaryDocument is often the XSL-rendered view; the raw XML
                // lives at the same path without the xsl prefix
                xmlUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${doc.replace(/^xsl[^/]*\//, '')}`
            });
        }
        return reachedCutoff;
    };
    const base = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        headers: secSource.SEC_HEADERS, timeout: 20000
    });
    let done = scan(base.data?.filings?.recent);
    for (const f of (base.data?.filings?.files || []).slice(0, 4)) {
        if (done || out.length >= MAX_FILINGS) break;
        if (f.filingTo && f.filingTo < cutoff) break; // archives are older-only
        try {
            const r2 = await axios.get(`https://data.sec.gov/submissions/${f.name}`, {
                headers: secSource.SEC_HEADERS, timeout: 20000
            });
            done = scan(r2.data?.filings?.recent || r2.data);
        } catch (_) { /* best-effort */ }
    }
    return out;
}

// ---- parse one Form 4 XML (regex over the fixed ownershipDocument schema) ----
function pick(xml, re) { const m = re.exec(xml); return m ? m[1].trim() : null; }
function parseForm4(xml) {
    const owner = pick(xml, /<rptOwnerName>([^<]+)/);
    let relation = pick(xml, /<officerTitle>([^<]+)/);
    if (!relation && /<isDirector>\s*(1|true)/.test(xml)) relation = 'Director';
    if (!relation && /<isTenPercentOwner>\s*(1|true)/.test(xml)) relation = '10% owner';
    if (!relation) relation = 'Insider';
    const txns = [];
    const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
    for (const b of blocks) {
        const code = pick(b, /<transactionCode>([A-Z])</);
        const shares = num(pick(b, /<transactionShares>\s*<value>([\d.]+)/));
        const price = num(pick(b, /<transactionPricePerShare>\s*<value>([\d.]+)/));
        const date = pick(b, /<transactionDate>\s*<value>([\d-]+)/);
        if (!code || shares === null) continue;
        const side = code === 'P' ? 'buy' : code === 'S' ? 'sell' : 'other';
        txns.push({ code, side, shares, price, value: price !== null ? shares * price : null, date });
    }
    return { owner: owner || '', relation, txns };
}

// ---- build (idempotent; cached per accession) ----
const _building = new Set();
async function buildHistory(symbol) {
    if (_building.has(symbol)) return;
    _building.add(symbol);
    try {
        const col = mongoose.connection.collection('insider_form4');
        const meta = mongoose.connection.collection('insider_form4_meta');
        const filings = await listForm4(symbol);
        if (!filings) return;
        const have = new Set((await col.find({ symbol }).project({ accession: 1 }).toArray()).map((d) => d.accession));
        const todo = filings.filter((f) => !have.has(f.accession));
        for (const f of todo) {
            try {
                if (!/\.xml$/i.test(f.xmlUrl)) { have.add(f.accession); continue; }
                const r = await axios.get(f.xmlUrl, { headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 5e6 });
                const parsed = parseForm4(String(r.data));
                await col.updateOne(
                    { symbol, accession: f.accession },
                    { $set: { symbol, accession: f.accession, date: f.date, ...parsed } },
                    { upsert: true }
                );
            } catch (_) { /* skip unparseable filing */ }
            await sleep(FETCH_GAP_MS);
        }
        await meta.updateOne(
            { symbol },
            { $set: { symbol, builtAt: new Date(), filings: filings.length } },
            { upsert: true }
        );
    } finally {
        _building.delete(symbol);
    }
}

// ---- aggregate for the page ----
async function history(symbol) {
    const col = mongoose.connection.collection('insider_form4');
    const meta = mongoose.connection.collection('insider_form4_meta');
    const m = await meta.findOne({ symbol });
    const stale = !m || Date.now() - new Date(m.builtAt).getTime() > 24 * 3600 * 1000;
    if (stale) buildHistory(symbol).catch(() => {}); // fire-and-forget
    const docs = await col.find({ symbol }).toArray();
    const buckets = new Map();
    const recent = [];
    for (const d of docs) {
        for (const t of d.txns || []) {
            const date = t.date || d.date;
            if (!date || t.side === 'other') continue;
            const q = date.slice(0, 4) + ' Q' + (Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1);
            if (!buckets.has(q)) buckets.set(q, { buys: 0, sells: 0, buySh: 0, sellSh: 0, buyVal: 0, sellVal: 0 });
            const b = buckets.get(q);
            if (t.side === 'buy') { b.buys++; b.buySh += t.shares; b.buyVal += t.value || 0; }
            else { b.sells++; b.sellSh += t.shares; b.sellVal += t.value || 0; }
            recent.push({ date, owner: d.owner, relation: d.relation, side: t.side, shares: t.shares, value: t.value });
        }
    }
    recent.sort((a, b) => b.date.localeCompare(a.date));
    const quarters = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, v]) => ({ key, ...v }));
    return {
        symbol,
        building: !m || _building.has(symbol),
        builtAt: m ? m.builtAt : null,
        filingsParsed: docs.length,
        quarters,
        recent: recent.slice(0, 25),
        source: 'SEC Form 4 filings, parsed directly from EDGAR'
    };
}

module.exports = { history, buildHistory };
