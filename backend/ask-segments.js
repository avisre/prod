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
    const anchor = proof.exactAnnualRevenue(filing, income, issuer);
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
    const failure = recent.get(cacheId + ':failure');
    if (failure && Date.now() - failure.at < RETRY_AFTER_MS) return { ...failure.payload, symbol: listing.symbol };
    const now = Date.now(); starts = starts.filter(time => now - time < 10 * 60 * 1000);
    if (starts.length >= 60) return { ...unavailable(listing.symbol, 'SEC segment research is busy. Retry shortly.'), retryable: true };
    starts.push(now);
    let full, inlineBindings;
    try {
        const response = await axios.get(filing.url, { headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 20 * 1024 * 1024 });
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
    if (pending.size >= MAX_ACTIVE || process.memoryUsage().rss > 320 * 1024 * 1024)
        return { ...unavailable(listing.symbol, 'SEC segment research is busy. Retry shortly.'), retryable: true };
    const work = extractWork(listing, income).catch(() => unavailable(listing.symbol, 'SEC segment research is temporarily unavailable.'));
    pending.set(issuer, work);
    try { return await work; } finally { pending.delete(issuer); }
}

module.exports = { CACHE_VERSION, COLLECTION, EXTRACT_SYSTEM, ...proof, extractAskSegments, unavailable };
