'use strict';

// Ask uses a distinct cache contract; company pages retain revenueUsd.
const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const aiClient = require('./ai-client');
const legacySegments = require('./segments');
const coverage = require('./sec-coverage');
const proof = require('./ask-segment-evidence');
const inline = require('./ask-inline-segments');

const CACHE_VERSION = proof.VERSION;
const COLLECTION = `ask_segments_v${CACHE_VERSION}`;
const MAX_ACTIVE = 2, MAX_HISTORY = 256, RETRY_AFTER_MS = 5 * 60 * 1000;
// A filing is read as one string; refuse new reads only when memory is genuinely short.
const RSS_LIMIT_MB = Number(process.env.ASK_SEGMENT_RSS_LIMIT_MB) || 400;
const pending = new Map(), recent = new Map();
let recentBytes = 0, starts = [];
const EXTRACT_SYSTEM = [
    'Extract operating-segment revenue only from supplied SEC annual filing text. Reply with one JSON object and no prose.',
    'Schema: {"periodEnd":"YYYY-MM-DD","basisExcerpt":"exact quote establishing table currency and scale","periodExcerpt":"exact quote containing the selected year/date","segments":[{"name":"exact segment name","reportedValue":number,"scale":1|1000|1000000|1000000000,"currency":"ISO-4217","value":number,"sourceExcerpt":"exact contiguous quote containing segment name and printed amount"}]}',
    'Copy excerpts literally from the supplied text. Do not combine separated cells into an invented quote. For columnar segment tables, sourceExcerpt must include the contiguous segment headers through the revenue row; a revenue row without segment names is insufficient. reportedValue is the printed amount, scale is the explicitly stated table scale, and value is reportedValue multiplied by scale.',
    'Use only the requested fiscal period and native reporting currency. Exclude comparative columns, percentages, assets, profit and non-revenue amounts. Do not estimate, convert, rescale by comparison or use memory.',
    'If no complete multi-segment revenue table with literal quotes and explicit currency/scale is present, return {"segments":[]}.'
].join('\n');

function unavailable(symbol, error) {
    return { code: 'VERIFIED_FINANCIALS_UNAVAILABLE', symbol, coverage: 'unavailable', error };
}
function remember(key, payload) {
    const existing = recent.get(key);
    if (existing) recentBytes -= existing.bytes;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    recent.delete(key); recent.set(key, { payload, at: Date.now() });
    recent.get(key).bytes = bytes; recentBytes += bytes;
    while (recent.size > MAX_HISTORY || recentBytes > 4 * 1024 * 1024) {
        const oldest = recent.keys().next().value; recentBytes -= recent.get(oldest).bytes; recent.delete(oldest);
    }
}
function readable(html) {
    return legacySegments.htmlToText(String(html || '')
        .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
        .replace(/<(div|span)[^>]*style="[^"]*display:\s*none[^"]*"[\s\S]*?<\/\1>/gi, ' ')
        .replace(/&#(\d+);/g, (_, n) => Number(n) > 31 && Number(n) < 65536 ? String.fromCharCode(Number(n)) : ' ')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")).trim();
}

async function extractWork(listing, income) {
    const issuer = coverage.cik(listing.cik);
    const annual = income.coverage?.latestAnnual;
    let filing;
    if (income.coverage?.annualReportingStatus === 'recent_annual' && /^[\w.-]+\.html?$/i.test(annual?.primaryDocument || '')) {
        const selected = { form: annual.form, date: annual.filingDate, reportDate: annual.reportDate, accession: annual.accessionNumber,
            url: String(annual.filingUrl || '').replace(/[^/]*$/, '') + annual.primaryDocument };
        if (proof.filingMatches(selected, issuer)) filing = selected;
    }
    if (!filing) filing = await legacySegments.latestTenK(listing.symbol);
    let anchor = proof.exactAnnualRevenue(filing, income, issuer);
    // Revenue restated in an amended filing carries the amendment's accession
    // number, not the original report's. The tagged figures read below are
    // matched to this issuer, period and currency inside the filing itself, so
    // the period's filed revenue is enough to size them against; the model
    // path keeps its exact-accession requirement.
    let taggedOnly = false;
    if (!anchor && proof.filingMatches(filing, issuer)) {
        const full = require('./ask-report-evidence').expand(income);
        const row = (full?.observations || []).find(o => (!filing.reportDate || o.periodEnd === filing.reportDate) && o.fields?.totalRevenue?.value > 0 && /^[A-Z]{3}$/.test(o.currency || ''));
        const source = row && (row.fields.totalRevenue.sourceIds || []).map(id => full.provenance?.sources?.[id]).find(x => x?.periodStart && x.periodEnd === row.periodEnd);
        if (source) { anchor = { value: row.fields.totalRevenue.value, currency: row.currency, periodEnd: row.periodEnd, periodStart: source.periodStart }; taggedOnly = true; }
    }
    if (!anchor) return unavailable(listing.symbol, 'No unique verified annual revenue fact matches this issuer’s exact SEC annual filing, period and currency.');
    const cacheId = `askseg:v${CACHE_VERSION}:${issuer}:${proof.accession(filing.accession)}`;
    const cached = recent.get(cacheId);
    if (cached && proof.validCachedPayload(cached.payload, issuer, filing, anchor)) return { ...cached.payload, symbol: listing.symbol, cached: true };
    let col = null;
    if (mongoose.connection.readyState === 1) col = mongoose.connection.collection(COLLECTION);
    if (col) {
        try {
            const hit = await col.findOne({ _id: cacheId }, { maxTimeMS: 1500 });
            if (proof.validCachedPayload(hit?.payload, issuer, filing, anchor)) {
                remember(cacheId, hit.payload); return { ...hit.payload, symbol: listing.symbol, cached: true };
            }
        } catch (_) { /* source extraction remains available during a cache outage */ }
    }
    const inlineId = `askseg-inline:v1:${issuer}:${proof.accession(filing.accession)}`;
    const inlineHit = recent.get(inlineId);
    if (inlineHit) return { ...inlineHit.payload, symbol: listing.symbol, cached: true };
    if (col) {
        try { const hit = await col.findOne({ _id: inlineId }, { maxTimeMS: 1500 }); if (hit?.payload?.segments?.length) { remember(inlineId, hit.payload); return { ...hit.payload, symbol: listing.symbol, cached: true }; } }
        catch (_) { /* read the filing instead */ }
    }
    const failure = recent.get(cacheId + ':failure');
    if (failure && Date.now() - failure.at < RETRY_AFTER_MS) return { ...failure.payload, symbol: listing.symbol };
    const now = Date.now(); starts = starts.filter(time => now - time < 10 * 60 * 1000);
    if (starts.length >= 60) return { ...unavailable(listing.symbol, 'SEC segment research is busy. Retry shortly.'), retryable: true };
    starts.push(now);
    let full, inlineBindings;
    try {
        // Read as bytes and scan as a one-byte string: the tags and figures are
        // ASCII, and a 13 MB bank filing then costs 13 MB instead of 26.
        const response = await axios.get(filing.url, { headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 20 * 1024 * 1024, responseType: 'arraybuffer' });
        const bytes = Buffer.isBuffer(response.data) ? response.data : null;
        // The filing's own tagged breakdown needs no model at all. Most
        // companies are answered here; only an untagged filing goes on to the
        // extraction model below.
        const tagged = inline.groups(bytes ? bytes.toString('latin1') : String(response.data || ''), anchor, issuer);
        const primary = tagged.segments || tagged.products;
        if (primary) {
            const rows = g => g.rows.map(r => ({ name: r.name, member: r.member, value: r.value, reportedRevenue: r.value, revenueUsd: anchor.currency === 'USD' ? r.value : null, revenuePct: r.value / anchor.value * 100 }));
            const observation = (r, kind) => ({ name: r.name, periodEnd: anchor.periodEnd, currency: anchor.currency, fields: { segmentRevenue: { value: r.value, unit: anchor.currency, currency: anchor.currency, scope: kind,
                sourceIds: [`sec-inline-segment:${issuer}:${proof.accession(filing.accession)}:${r.member}`] } } });
            const extra = k => tagged[k] && tagged[k] !== primary ? { [k === 'products' ? 'productLines' : 'regions']: rows(tagged[k]) } : {};
            const payload = { schemaVersion: CACHE_VERSION, symbol: listing.symbol, cik: issuer, basis: 'annual segment disclosures', periodEnd: anchor.periodEnd, currency: anchor.currency, fiscalYear: 'FY' + anchor.periodEnd.slice(0, 4),
                breakdown: primary === tagged.segments ? 'operating segments' : 'product and service lines', measure: primary.measure, totalRevenue: anchor.value, segments: rows(primary), ...extra('products'), ...extra('regions'),
                observations: ['segments', 'products', 'regions'].flatMap(k => tagged[k] ? tagged[k].rows.map(r => observation(r, k === 'segments' ? 'segment' : k)) : []),
                filing: { form: filing.form, date: filing.date, accessionNumber: filing.accession, url: filing.url },
                verificationStatus: primary.reconciled ? 'reconciled' : 'partial', taggedBreakdown: true,
                ...(primary.reconciled ? {} : { note: primary.measure !== 'revenue' ? `Rows are ${primary.measure} by segment, not total revenue.`
                    : primary.share > 1.005 ? 'Segment figures are as filed, before intersegment eliminations, so they add up to more than consolidated revenue.'
                    : 'The filed rows cover part of consolidated revenue; the remainder is corporate, other or eliminations.' }),
                source: 'Revenue breakdown read directly from the tagged figures in the SEC annual report; amounts are in filing currency.' };
            response.data = null; remember(inlineId, payload);
            if (col) { try { await col.updateOne({ _id: inlineId }, { $set: { payload, at: new Date() } }, { upsert: true, maxTimeMS: 1500 }); } catch (_) { /* best effort */ } }
            return payload;
        }
        if (taggedOnly) { response.data = null; return unavailable(listing.symbol, 'The annual report does not tag a revenue breakdown.'); }
        if (bytes) response.data = bytes.toString('utf8');
        inlineBindings = inline.bindings(String(response.data || ''), anchor, issuer);
        full = readable(response.data); response.data = null;
    } catch (_) { const result = unavailable(listing.symbol, 'SEC annual report text could not be retrieved.'); remember(cacheId + ':failure', result); return result; }
    const text = legacySegments.segmentWindows(full);
    if (text.length < 500) return unavailable(listing.symbol, 'SEC annual report did not contain readable segment text.');
    const run = async extra => aiClient.chatRaw([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `Issuer: ${listing.symbol}, CIK ${issuer}. Form ${filing.form}, accession ${filing.accession}, filed ${filing.date}. Extract only revenue for annual period ended ${anchor.periodEnd} in ${anchor.currency}. ${extra}\n\n${text}` }
    ], { purpose: 'summary', temperature: 0, maxTokens: 5000 });
    const parse = result => {
        try { const content = String(result.content || '').replace(/```json|```/g, '').trim(); return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); }
        catch (_) { return null; }
    };
    let payload;
    try {
        payload = proof.normalizeResult(parse(await run('')), listing.symbol, issuer, filing, { text: full, anchor, inlineBindings });
        if (!payload) payload = proof.normalizeResult(parse(await run('Return strict JSON with literal excerpts and the filing’s explicit table scale. For columnar tables, quote the contiguous header through the revenue row so every segment name occurs literally alongside the amounts.')), listing.symbol, issuer, filing, { text: full, anchor, inlineBindings });
    } catch (_) {
        const result = unavailable(listing.symbol, 'SEC segment extraction is temporarily unavailable.');
        remember(cacheId + ':failure', result); return result;
    }
    full = null;
    if (!payload) {
        const result = { schemaVersion: CACHE_VERSION, symbol: listing.symbol, cik: issuer, periodEnd: anchor.periodEnd, currency: anchor.currency, segments: [],
            filing: { form: filing.form, date: filing.date, accessionNumber: filing.accession, url: filing.url }, verificationStatus: 'incomplete',
            note: 'No complete multi-segment revenue table could be matched to literal filing text with its reporting basis.' };
        remember(cacheId + ':failure', result); return result;
    }
    remember(cacheId, payload);
    if (col) { try { await col.updateOne({ _id: cacheId }, { $set: { payload, at: new Date() } }, { upsert: true, maxTimeMS: 1500 }); } catch (_) { /* best effort */ } }
    return payload;
}

async function extractAskSegments(symbol, income) {
    const listing = require('./stock-universe').lookup(symbol);
    if (!listing) return { error: 'Unknown stock symbol.' };
    if (listing.securityType !== 'stock') return { code: 'UNSUPPORTED_SECURITY_TYPE', symbol: listing.symbol, securityType: listing.securityType, error: 'Company segment analysis is unavailable for this security type.' };
    const issuer = coverage.cik(listing.cik);
    if (!issuer) return unavailable(listing.symbol, 'A validated SEC issuer identity is unavailable for segment research.');
    if (pending.has(issuer)) return { ...await pending.get(issuer), symbol: listing.symbol };
    if (pending.size >= MAX_ACTIVE || process.memoryUsage().rss > RSS_LIMIT_MB * 1024 * 1024)
        return { ...unavailable(listing.symbol, 'SEC segment research is busy. Retry shortly.'), retryable: true };
    const work = extractWork(listing, income).catch(() => unavailable(listing.symbol, 'SEC segment research is temporarily unavailable.'));
    pending.set(issuer, work);
    try { return await work; } finally { pending.delete(issuer); }
}

module.exports = { CACHE_VERSION, COLLECTION, EXTRACT_SYSTEM, ...proof, extractAskSegments, unavailable };
