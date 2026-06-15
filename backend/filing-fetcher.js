// Shared filing fetcher — fetch a SEC filing once, convert to plain text, cache
// it, and slice windows around topic anchors. Used by industry-overview,
// governance and esg so a 10-K is fetched and de-tagged a single time even
// though three sections read different parts of it.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const watchdog = require('./watchdog');
const aiClient = require('./ai-client');

const MAX_FETCH_BYTES = 40e6;

// Crude but effective HTML→text (same approach as segments.js/filing-diff.js).
function htmlToText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function col() { return mongoose.connection.collection('filing_text'); }

// Fetch the latest filing of `form` (e.g. '10-K', 'DEF 14A'), return plain text.
// Cached in Mongo per (symbol, accession). `form` accepts the EDGAR form label.
async function getFilingText(symbol, form, { maxChars = 220000 } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) return null;
    let filings = null;
    try { filings = await watchdog.fetchFilingsDeep(sym, new Set([form]), { [form]: 1 }); } catch (_) { filings = null; }
    if (!filings || !filings.length) {
        // some forms (DEF 14A) aren't in the recent window fetchRecentFilings scans;
        // fetchFilingsDeep covers the archive, so a null here means truly none.
        return { error: `No ${form} found for ${sym}.` };
    }
    const f = filings.find((x) => x.form === form) || filings[0];
    if (!f || !f.url || !/\.htm/i.test(f.url)) return { error: `${form} for ${sym} is not in a readable format.` };

    try {
        const hit = await col().findOne({ symbol: sym, accession: f.accession, form });
        if (hit && hit.text) return { symbol: sym, form, date: f.date, url: f.url, accession: f.accession, text: hit.text, cached: true };
    } catch (_) { /* cache best-effort */ }

    let text;
    try {
        const r = await axios.get(f.url, { headers: secSource.SEC_HEADERS, timeout: 35000, maxContentLength: MAX_FETCH_BYTES });
        text = htmlToText(r.data).slice(0, maxChars);
    } catch (_) { return { error: `Couldn't fetch the ${form} for ${sym} right now.` }; }
    if (!text || text.length < 500) return { error: `Couldn't read the ${form} text for ${sym}.` };

    try {
        await col().updateOne({ symbol: sym, accession: f.accession, form }, { $set: { symbol: sym, accession: f.accession, form, date: f.date, url: f.url, text, at: new Date() } }, { upsert: true });
    } catch (_) { /* best-effort */ }
    return { symbol: sym, form, date: f.date, url: f.url, accession: f.accession, text, cached: false };
}

// Slice windows of text around anchor regexes (first match each), merged.
// Returns a single string capped at `maxChars`. Falls back to the head of the
// document if no anchors match.
function windows(text, anchors, { before = 600, after = 7000, maxChars = 24000 } = {}) {
    if (!text) return '';
    const spans = [];
    for (const re of anchors) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) spans.push([Math.max(0, m.index - before), Math.min(text.length, m.index + after)]);
    }
    if (!spans.length) return text.slice(0, maxChars);
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0]];
    for (const [s, e] of spans.slice(1)) {
        const last = merged[merged.length - 1];
        if (s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]);
    }
    let out = '';
    for (const [s, e] of merged) { if (out.length >= maxChars) break; out += text.slice(s, e) + '\n…\n'; }
    return out.slice(0, maxChars);
}

// Strict-JSON extraction over filing text — temp 0, one retry, returns the
// parsed object or null. Shared by industry/governance/esg so the grounding
// discipline (model narrates over filed text, never invents) is identical.
async function extractJson(system, user, guard, { maxTokens = 1800, retryHint = ' REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON.' } = {}) {
    const call = (extra) => aiClient.chatRaw(
        [{ role: 'system', content: system }, { role: 'user', content: user + extra }],
        { purpose: 'summary', temperature: 0, maxTokens, timeoutMs: 45000 }
    );
    const parse = (msg) => {
        try {
            const raw = String((msg && msg.content) || '').replace(/```json|```/g, '').trim();
            const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return guard(obj) ? obj : null;
        } catch (_) { return null; }
    };
    let out = null;
    try { out = parse(await call('')); } catch (_) { out = null; }
    if (!out) { try { out = parse(await call('\n' + retryHint)); } catch (_) { out = null; } }
    return out;
}

// True if `quote` is a near-verbatim substring of `text` (loose whitespace),
// used to reject hallucinated evidence quotes.
function isGrounded(quote, text) {
    if (!quote || !text) return false;
    const norm = (s) => String(s).toLowerCase().replace(/[\s ]+/g, ' ').replace(/[^a-z0-9 .,%$-]/g, '').trim();
    const q = norm(quote), t = norm(text);
    if (q.length < 12) return false;
    if (t.includes(q)) return true;
    // tolerate truncation/ellipsis: check the first solid chunk
    const head = q.split(' ').slice(0, 8).join(' ');
    return head.length >= 12 && t.includes(head);
}

module.exports = { getFilingText, windows, htmlToText, extractJson, isGrounded };
