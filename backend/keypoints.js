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
// keys20F maps each pass onto Form 20-F's unrelated item scheme: the business
// description is Item 4 rather than 1/2, risk factors are Item 3.D rather than
// 1A, and MD&A is Item 5 (with market risk at 11) rather than 7/7A.
const PASSES = [
    {
        id: 'business',
        keys: ['1', '2'],
        keys20F: ['4'],
        focus: 'what the company sells, its products/platforms, customers, segments, geographic mix, competition and workforce'
    },
    {
        id: 'risk',
        keys: ['1A', '3'],
        keys20F: ['3D'],
        focus: 'the risks and legal exposures THIS company actually discloses — concentration, dependency, regulatory, litigation, supply, leverage. Prefer specific, company-particular risks over generic boilerplate'
    },
    {
        id: 'performance',
        keys: ['7', '7A'],
        keys20F: ['5', '11'],
        focus: 'financial performance and its drivers — revenue/margin movement and WHY, segment results, liquidity, capital allocation, and management’s stated outlook'
    }
];

const isForeignAnnual = (form) => String(form || '').toUpperCase().startsWith('20-F');
const passKeys = (pass, form) => (isForeignAnnual(form) && pass.keys20F ? pass.keys20F : pass.keys);

const EXTRACT_SYSTEM = [
    'You build a compact company dossier from SEC 10-K text. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"sections": [{"heading": str, "points": [str]}]}',
    'Choose 2-4 section headings that fit THIS company and THIS material (e.g. "Revenue breakup", "Geographic mix", "Products & platforms", "Customers", "Competition", "Workforce", "Customer concentration", "Regulatory exposure", "Litigation", "Margin drivers", "Liquidity", "Outlook") — only sections the supplied text actually supports.',
    'Each point is one tight factual sentence (max ~35 words). Include concrete numbers (revenue shares, counts, percentages, dollar amounts) whenever they appear in the text.',
    'STRICT GROUNDING: use ONLY facts and figures present in the supplied text. Never invent, estimate, or recall from memory. If the text supports fewer sections, return fewer.',
    'Max 8 points per section. Plain factual register — no marketing language, no advice.'
].join('\n');

// Compares a company against its OWN prior filings. A newly added risk factor,
// or a quietly dropped one, is a leading indicator an annual snapshot cannot
// show — this is the reason Deep exists, not merely "more text".
const TREND_SYSTEM = [
    'You compare one company’s own disclosures across three consecutive annual reports (10-K). Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"sections": [{"heading": str, "points": [str]}]}',
    'Use headings drawn from what the material supports, e.g. "Newly disclosed risks", "Risks no longer disclosed", "Shift in strategy", "Changed segment reporting", "Changing emphasis".',
    'Report only DIFFERENCES between the years, never a restatement of the latest year. Attribute each point to its year(s), e.g. "First disclosed in FY2025:".',
    'STRICT GROUNDING: compare only what appears in the supplied per-year summaries. Never infer a change from absence of detail in a summary, and never recall from memory.',
    'Max 6 points per section, one tight sentence each. If the years look materially the same, say so in a single point and return nothing else.'
].join('\n');

const cacheCol = () => mongoose.connection.collection('company_keypoints');

function readCache(query) {
    return cacheCol().findOne(query)
        .then((hit) => (hit && hit.payload && Number(hit.payload.version) === KEYPOINTS_VERSION
            ? { ...hit.payload, cached: true }
            : null))
        .catch(() => null); // cache is best-effort
}

function writeCache(query, payload) {
    return cacheCol()
        .updateOne(query, { $set: { payload, at: new Date() } }, { upsert: true })
        .catch(() => {}); // cache is best-effort
}

// Extract one filing. Keyed on the accession alone, so a Deep run reuses any
// year already extracted — and next year's Deep run reuses two of three.
async function extractOneFiling(symbol, tenK, { allowAi = true } = {}) {
    const key = { symbol, accession: tenK.accession, depth: 'standard' };
    const cached = await readCache(key);
    if (cached) return cached;

    if (!allowAi || !aiClient.isConfigured()) {
        return { error: 'Key points are available to signed-in paid users after generation.' };
    }

    const r = await axios.get(tenK.url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 60e6 });
    const extracted = filingSections.extractSections(r.data, { form: tenK.form });
    if (!Object.keys(extracted.sections).length) return { error: `Could not read the ${tenK.form || '10-K'} text.` };

    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return Array.isArray(p.sections) ? p : null;
        } catch (_) { return null; }
    };

    const runPass = async (pass) => {
        const body = filingSections.sectionsAsText(extracted.sections, passKeys(pass, tenK.form));
        if (body.length < 800) return [];
        const call = (extra) => aiClient.chatRaw([
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: `Company: ${symbol}. ${tenK.form || '10-K'} filed ${tenK.date}.\nFocus on ${pass.focus}.${extra}\n\n${body}` }
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
        depth: 'standard',
        sections: sections.slice(0, 12),
        filing: { form: tenK.form || '10-K', date: tenK.date, url: tenK.url },
        coverage: {
            sections: Object.keys(extracted.sections),
            chars: Object.values(extracted.sections).reduce((a, s) => a + s.chars, 0)
        },
        extractedAt: new Date().toISOString()
    };
    if (!payload.sections.length) return { error: 'Nothing extractable from this filing.' };
    await writeCache(key, payload);
    return payload;
}

// Three years of the company's own filings, plus what changed between them.
async function extractDeep(symbol, tenKs, { allowAi = true } = {}) {
    const latest = tenKs[0];
    const key = { symbol, accession: latest.accession, depth: 'deep' };
    const cached = await readCache(key);
    if (cached) return cached;

    if (!allowAi || !aiClient.isConfigured()) {
        return { error: 'Key points are available to signed-in paid users after generation.' };
    }

    // Sequential, not concurrent: each year is itself three model calls, and a
    // Deep request should not fan nine of them at a provider at once.
    const years = [];
    for (const filing of tenKs) {
        const one = await extractOneFiling(symbol, filing, { allowAi }).catch(() => null);
        if (one && !one.error) years.push(one);
    }
    if (!years.length) return { error: 'Could not read this company’s filings.' };
    // Only the latest year resolved — nothing to compare against, so this is a
    // standard dossier and must not be cached or billed as a deep one.
    if (years.length < 2) return years[0];

    const digest = years.map((y) => [
        `### Fiscal year ending ${(y.filing || {}).date || 'unknown'}`,
        ...y.sections.map((s) => `${s.heading}: ${s.points.join(' ')}`)
    ].join('\n')).join('\n\n');

    let trends = [];
    try {
        const msg = await aiClient.chatRaw([
            { role: 'system', content: TREND_SYSTEM },
            { role: 'user', content: `Company: ${symbol}. Newest year first.\n\n${digest}` }
        ], { purpose: 'summary', temperature: 0, maxTokens: 3000 });
        const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        trends = Array.isArray(parsed.sections) ? parsed.sections : [];
    } catch (_) { trends = []; } // a failed comparison still leaves three good years

    const trendSections = trends.map((s) => ({
        heading: String(s.heading || '').slice(0, 60).trim(),
        points: (Array.isArray(s.points) ? s.points : [])
            .slice(0, 6).map((p) => String(p).slice(0, 320)).filter(Boolean)
    })).filter((s) => s.heading && s.points.length);

    const payload = {
        symbol,
        version: KEYPOINTS_VERSION,
        depth: 'deep',
        // Year-over-year change leads: it is what the extra years bought.
        sections: [...trendSections, ...years[0].sections].slice(0, 16),
        // Same content as the trend-tagged entries above, kept separately so a
        // caller that wants ONLY the change signal (not latest-year facts it
        // may already have from elsewhere) doesn't have to guess by position.
        yearOverYear: trendSections,
        filing: years[0].filing,
        history: years.map((y) => y.filing),
        coverage: years[0].coverage,
        extractedAt: new Date().toISOString()
    };
    await writeCache(key, payload);
    return payload;
}

async function extractKeyPoints(symbol, { allowAi = true, depth = 'standard' } = {}) {
    const filings = await watchdog.fetchRecentFilings(symbol);
    if (!filings) return { error: 'No SEC filings found for this company.' };
    // Any annual report, not literally a 10-K: a foreign private issuer files
    // 20-F (40-F under the Canadian MJDS) and never a 10-K, so a literal match
    // returned "No 10-K found" for every ADR.
    const tenKs = filings.filter((f) => secSource.ANNUAL_FORMS.includes(f.form) && f.url && /\.htm/i.test(f.url));
    if (!tenKs.length) return { error: 'No annual report (10-K or 20-F) found for this company.' };

    return depth === 'deep'
        ? extractDeep(symbol, tenKs.slice(0, 3), { allowAi })
        : extractOneFiling(symbol, tenKs[0], { allowAi });
}

module.exports = { extractKeyPoints, DEPTHS: ['standard', 'deep'], KEYPOINTS_VERSION };
