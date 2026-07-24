// Key Points — the company dossier (screener.in-style), extracted from the
// company's own latest 10-K. Sections like revenue breakup, customers,
// products & platforms, recent developments — whatever the filing actually
// discusses, never a fixed template. Same grounding rule as segments.js:
// only facts present in the supplied text; cached in Mongo per filing.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const watchdog = require('./watchdog');
const aiClient = require('./ai-client');

const MAX_EXTRACT_CHARS = 30000;

function htmlToText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#8217;|&rsquo;/g, '’')
        .replace(/\s+/g, ' ');
}

// The dossier lives in Item 1 (Business) and the front of MD&A — take the
// business-section head plus windows around the most informative anchors.
function dossierWindows(text) {
    const out = [];
    const anchors = [
        /item\s*1\s*[.:]?\s*business/i,
        /management.s discussion and analysis/i,
        /our products/i, /our customers/i, /our segments?/i,
        /human capital/i, /competition/i, /acquisitions?/i
    ];
    for (const re of anchors) {
        const m = re.exec(text);
        if (m) out.push([Math.max(0, m.index - 200), Math.min(text.length, m.index + 9000)]);
    }
    if (!out.length) return text.slice(0, MAX_EXTRACT_CHARS);
    out.sort((a, b) => a[0] - b[0]);
    const merged = [out[0]];
    for (const [s, e] of out.slice(1)) {
        const last = merged[merged.length - 1];
        if (s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }
    let buf = '';
    for (const [s, e] of merged) {
        if (buf.length >= MAX_EXTRACT_CHARS) break;
        buf += text.slice(s, e) + '\n…\n';
    }
    return buf.slice(0, MAX_EXTRACT_CHARS);
}

const EXTRACT_SYSTEM = [
    'You build a compact company dossier from SEC 10-K text. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"sections": [{"heading": str, "points": [str]}]}',
    'Choose 4-7 section headings that fit THIS company (e.g. "Revenue breakup", "Geographic mix", "Products & platforms", "Customers", "Recent developments", "Competition", "Workforce") — only sections the text actually supports.',
    'Each point is one tight factual sentence (max ~30 words). Include concrete numbers (revenue shares, counts, percentages) whenever they appear in the text.',
    'STRICT GROUNDING: use ONLY facts and figures present in the supplied text. Never invent, estimate, or recall from memory. If the text supports fewer sections, return fewer.',
    'Max 6 points per section. Plain factual register — no marketing language, no advice.'
].join('\n');

async function extractKeyPoints(symbol, { allowAi = true } = {}) {
    const filings = await watchdog.fetchRecentFilings(symbol);
    if (!filings) return { error: 'No SEC filings found for this company.' };
    const tenK = filings.find((f) => f.form === '10-K');
    if (!tenK || !tenK.url || !/\.htm/i.test(tenK.url)) return { error: 'No 10-K found for this company.' };

    const col = mongoose.connection.collection('company_keypoints');
    try {
        const hit = await col.findOne({ symbol, accession: tenK.accession });
        if (hit) return { ...hit.payload, cached: true };
    } catch (_) { /* cache is best-effort */ }

    if (!allowAi || !aiClient.isConfigured()) {
        return { error: 'Key points are available to signed-in paid users after generation.' };
    }

    const r = await axios.get(tenK.url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 60e6 });
    const text = dossierWindows(htmlToText(r.data));
    if (text.length < 800) return { error: 'Could not read the 10-K text.' };

    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `Company: ${symbol}. 10-K filed ${tenK.date}. Build the dossier.${extra}\n\n${text}` }
    ], { purpose: 'summary', temperature: 0, maxTokens: 6000 });

    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return Array.isArray(p.sections) ? p : null;
        } catch (_) { return null; }
    };

    let parsed = tryParse(await callModel(''));
    if (!parsed) parsed = tryParse(await callModel(' REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON.'));
    if (!parsed) return { error: 'Extraction failed — try again later.' };

    const payload = {
        symbol,
        sections: parsed.sections.slice(0, 7).map((s) => ({
            heading: String(s.heading || '').slice(0, 60),
            points: (Array.isArray(s.points) ? s.points : []).slice(0, 6).map((p) => String(p).slice(0, 280)).filter(Boolean)
        })).filter((s) => s.heading && s.points.length),
        filing: { form: '10-K', date: tenK.date, url: tenK.url },
        extractedAt: new Date().toISOString()
    };
    if (!payload.sections.length) return { error: 'Nothing extractable from this filing.' };
    try {
        await col.updateOne({ symbol, accession: tenK.accession }, { $set: { payload, at: new Date() } }, { upsert: true });
    } catch (_) { /* cache is best-effort */ }
    return payload;
}

module.exports = { extractKeyPoints };
