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
const filingSections = require('./filing-sections');

// Bumped when extraction changes in a way that makes older cached payloads
// worse than a rebuild. Without this, entries built by the previous extractor
// would keep serving until each company's NEXT annual filing — up to a year of
// thin dossiers — because the cache is keyed on the accession alone.
const KEYPOINTS_VERSION = 2;

// Section extraction moved to filing-sections.js. The old local windowing fed
// the model 7-23% of a filing's core narrative (measured across 18 real 10-Ks,
// median ~12%) and never looked at Item 1A Risk Factors at all; the shared
// extractor now delivers 41-100%, median ~80%, with Risk Factors first-class.

// One pass per topic group rather than one pass over the whole filing: keeps
// each prompt in a range the model actually attends to, lets a failed group
// retry alone, and guarantees risk material is read rather than crowded out by
// whatever happened to come first in the document.
const PASSES = [
    {
        id: 'business',
        keys: ['1', '2'],
        focus: 'what the company sells, its products/platforms, customers, segments, geographic mix, competition and workforce'
    },
    {
        id: 'risk',
        keys: ['1A', '3'],
        focus: 'the risks and legal exposures THIS company actually discloses — concentration, dependency, regulatory, litigation, supply, leverage. Prefer specific, company-particular risks over generic boilerplate'
    },
    {
        id: 'performance',
        keys: ['7', '7A'],
        focus: 'financial performance and its drivers — revenue/margin movement and WHY, segment results, liquidity, capital allocation, and management’s stated outlook'
    }
];

const EXTRACT_SYSTEM = [
    'You build a compact company dossier from SEC 10-K text. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"sections": [{"heading": str, "points": [str]}]}',
    'Choose 2-4 section headings that fit THIS company and THIS material (e.g. "Revenue breakup", "Geographic mix", "Products & platforms", "Customers", "Competition", "Workforce", "Customer concentration", "Regulatory exposure", "Litigation", "Margin drivers", "Liquidity", "Outlook") — only sections the supplied text actually supports.',
    'Each point is one tight factual sentence (max ~35 words). Include concrete numbers (revenue shares, counts, percentages, dollar amounts) whenever they appear in the text.',
    'STRICT GROUNDING: use ONLY facts and figures present in the supplied text. Never invent, estimate, or recall from memory. If the text supports fewer sections, return fewer.',
    'Max 8 points per section. Plain factual register — no marketing language, no advice.'
].join('\n');

async function extractKeyPoints(symbol, { allowAi = true } = {}) {
    const filings = await watchdog.fetchRecentFilings(symbol);
    if (!filings) return { error: 'No SEC filings found for this company.' };
    const tenK = filings.find((f) => f.form === '10-K');
    if (!tenK || !tenK.url || !/\.htm/i.test(tenK.url)) return { error: 'No 10-K found for this company.' };

    const col = mongoose.connection.collection('company_keypoints');
    try {
        const hit = await col.findOne({ symbol, accession: tenK.accession });
        // A payload from an older extractor is treated as a miss, so the
        // richer extraction reaches users without waiting a filing cycle.
        if (hit && hit.payload && Number(hit.payload.version) === KEYPOINTS_VERSION) {
            return { ...hit.payload, cached: true };
        }
    } catch (_) { /* cache is best-effort */ }

    if (!allowAi || !aiClient.isConfigured()) {
        return { error: 'Key points are available to signed-in paid users after generation.' };
    }

    const r = await axios.get(tenK.url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 60e6 });
    const extracted = filingSections.extractSections(r.data);
    if (!Object.keys(extracted.sections).length) return { error: 'Could not read the 10-K text.' };

    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return Array.isArray(p.sections) ? p : null;
        } catch (_) { return null; }
    };

    const runPass = async (pass) => {
        const body = filingSections.sectionsAsText(extracted.sections, pass.keys);
        if (body.length < 800) return [];
        const call = (extra) => aiClient.chatRaw([
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: `Company: ${symbol}. 10-K filed ${tenK.date}.\nFocus on ${pass.focus}.${extra}\n\n${body}` }
        ], { purpose: 'summary', temperature: 0, maxTokens: 4000 });
        let parsed = tryParse(await call(''));
        if (!parsed) parsed = tryParse(await call(' REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON.'));
        return parsed ? parsed.sections : [];
    };

    // One slow pass per group, run concurrently; a failing group yields nothing
    // rather than sinking the whole extraction.
    const results = await Promise.all(PASSES.map((p) => runPass(p).catch(() => [])));

    const seen = new Set();
    const sections = [];
    for (const group of results) {
        for (const s of Array.isArray(group) ? group : []) {
            const heading = String(s.heading || '').slice(0, 60).trim();
            const key = heading.toLowerCase();
            if (!heading || seen.has(key)) continue;
            const points = (Array.isArray(s.points) ? s.points : [])
                .slice(0, 8).map((p) => String(p).slice(0, 320)).filter(Boolean);
            if (!points.length) continue;
            seen.add(key);
            sections.push({ heading, points });
        }
    }

    const payload = {
        symbol,
        version: KEYPOINTS_VERSION,
        sections: sections.slice(0, 12),
        filing: { form: '10-K', date: tenK.date, url: tenK.url },
        coverage: {
            sections: Object.keys(extracted.sections),
            chars: Object.values(extracted.sections).reduce((a, s) => a + s.chars, 0)
        },
        extractedAt: new Date().toISOString()
    };
    if (!payload.sections.length) return { error: 'Nothing extractable from this filing.' };
    try {
        await col.updateOne({ symbol, accession: tenK.accession }, { $set: { payload, at: new Date() } }, { upsert: true });
    } catch (_) { /* cache is best-effort */ }
    return payload;
}

module.exports = { extractKeyPoints };
