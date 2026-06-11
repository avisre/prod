// Business-segment extraction — the "Insights" feature.
//
// On demand, per company: fetch the latest 10-K from EDGAR, carve out the
// segment-related text, and have the summary model extract a small, strictly
// JSON segments table (name, revenue, % of revenue, one-line description).
// Results are cached in Mongo per (symbol, accession) so each filing is paid
// for once, ever. Grounding rule: the model may only use numbers present in
// the supplied text; anything else must be omitted.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const watchdog = require('./watchdog');
const aiClient = require('./ai-client');

const FUND_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');

// Filed total revenue from our own cache — the anchor for unit repair.
function filedRevenue(symbol) {
    try {
        const f = path.join(FUND_DIR, `${String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`);
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        const v = Number((((d.income || {}).annualReports || [])[0] || {}).totalRevenue);
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch (_) { return null; }
}

// Models sometimes return millions/thousands despite instructions. Compare
// the segment sum against the company's filed revenue and rescale when the
// ratio matches a unit error almost exactly. Deterministic — no AI judgement.
function repairUnits(segments, symbol) {
    const total = segments.reduce((a, s) => a + (s.revenueUsd || 0), 0);
    const filed = filedRevenue(symbol);
    if (!total || !filed) return segments;
    for (const scale of [1e6, 1e3]) {
        const ratio = filed / (total * scale);
        if (ratio > 0.5 && ratio < 2) {
            return segments.map((s) => ({
                ...s,
                revenueUsd: s.revenueUsd === null ? null : s.revenueUsd * scale
            }));
        }
    }
    return segments;
}

const MAX_EXTRACT_CHARS = 28000; // keep the prompt well inside context

async function latestTenK(symbol) {
    const filings = await watchdog.fetchRecentFilings(symbol);
    if (!filings) return null;
    return filings.find((f) => f.form === '10-K') || null;
}

// Strip tags/entities crudely but effectively — 10-K HTML is enormous and we
// only need readable text for the model.
function htmlToText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ');
}

// Take windows of text around segment-related anchors. The segment note and
// the business-section breakdown are what we're after.
function segmentWindows(text) {
    // Most specific anchors first — banks (JPM/BAC/WFC) never say
    // "reportable segment"; they say "segment results" / "business segment".
    const anchors = [
        /segment results/gi, /reportable segments?/gi, /segment information/gi,
        /operating segments?/gi, /business segments?/gi, /line of business/gi
    ];
    const spans = [];
    for (const re of anchors) {
        let m;
        while ((m = re.exec(text)) !== null && spans.length < 14) {
            spans.push([Math.max(0, m.index - 1500), Math.min(text.length, m.index + 6500)]);
        }
        if (spans.length >= 14) break;
    }
    if (!spans.length) return text.slice(0, MAX_EXTRACT_CHARS);
    spans.sort((a, b) => a[0] - b[0]);
    // merge overlaps
    const merged = [spans[0]];
    for (const [s, e] of spans.slice(1)) {
        const last = merged[merged.length - 1];
        if (s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }
    let out = '';
    for (const [s, e] of merged) {
        if (out.length >= MAX_EXTRACT_CHARS) break;
        out += text.slice(s, e) + '\n…\n';
    }
    return out.slice(0, MAX_EXTRACT_CHARS);
}

const EXTRACT_SYSTEM = [
    'You extract business-segment data from SEC 10-K text. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"fiscalYear": "FY2025", "segments": [{"name": str, "revenueUsd": number|null, "revenuePct": number|null, "description": str}], "basis": str}',
    '"revenueUsd" is the segment\'s annual revenue in plain US dollars (convert from millions/thousands as stated). "revenuePct" is its share of total revenue (0-100). "description" is one factual sentence from the text.',
    'STRICT GROUNDING: only use numbers that appear in the supplied text. If a number is not stated, use null. If the company reports one segment or no segment data is present, return {"segments": []}.',
    'Never invent, estimate or recall figures from memory. "basis" briefly states where the numbers came from (e.g. "segment note, FY2025 10-K").'
].join('\n');

async function extractSegments(symbol) {
    const tenK = await latestTenK(symbol);
    if (!tenK || !tenK.url || !/\.htm/i.test(tenK.url)) return { error: 'No 10-K found for this company.' };

    // cache check (per filing — a new 10-K invalidates naturally)
    const col = mongoose.connection.collection('company_segments');
    try {
        const hit = await col.findOne({ symbol, accession: tenK.accession });
        if (hit) return { ...hit.payload, cached: true };
    } catch (_) { /* cache is best-effort */ }

    const r = await axios.get(tenK.url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 40e6 });
    const text = segmentWindows(htmlToText(r.data));
    if (text.length < 500) return { error: 'Could not read the 10-K text.' };

    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `Company: ${symbol}. 10-K filed ${tenK.date}. Extract the business segments.${extra}\n\n${text}` }
    ], { purpose: 'summary', temperature: 0, maxTokens: 6000 });

    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return Array.isArray(p.segments) ? p : null;
        } catch (_) { return null; }
    };

    let parsed = tryParse(await callModel(''));
    if (!parsed) {
        // One retry — replies occasionally truncate or drift into prose.
        parsed = tryParse(await callModel(' Keep descriptions under 15 words. REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON.'));
    }
    if (!parsed) return { error: 'Extraction failed — try again later.' };

    const payload = {
        symbol,
        fiscalYear: typeof parsed.fiscalYear === 'string' ? parsed.fiscalYear.slice(0, 12) : null,
        basis: typeof parsed.basis === 'string' ? parsed.basis.slice(0, 120) : null,
        segments: repairUnits(parsed.segments.slice(0, 10).map((s) => ({
            name: String(s.name || '').slice(0, 80),
            revenueUsd: Number.isFinite(s.revenueUsd) ? s.revenueUsd : null,
            revenuePct: Number.isFinite(s.revenuePct) ? Math.round(s.revenuePct * 10) / 10 : null,
            description: String(s.description || '').slice(0, 240)
        })).filter((s) => s.name), symbol),
        filing: { form: '10-K', date: tenK.date, url: tenK.url },
        extractedAt: new Date().toISOString()
    };
    // Honesty check: if the extracted segments cover well under the filed
    // total revenue, say so rather than presenting a partial list as whole.
    const covered = payload.segments.reduce((a, s) => a + (s.revenueUsd || 0), 0);
    const filedTotal = filedRevenue(symbol);
    if (filedTotal && covered > 0 && covered / filedTotal < 0.7) {
        payload.note = `These segments cover ~${Math.round(covered / filedTotal * 100)}% of filed revenue — the filing reports more than could be extracted.`;
    }
    try {
        await col.updateOne(
            { symbol, accession: tenK.accession },
            { $set: { payload, at: new Date() } },
            { upsert: true }
        );
    } catch (_) { /* cache is best-effort */ }
    return payload;
}

module.exports = { extractSegments };
