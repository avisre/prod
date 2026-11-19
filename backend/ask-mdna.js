'use strict';

// Quarterly MD&A reader for the Ask tools. A "why did revenue/profit/margins
// change" question is answered by Part I Item 2 of the 10-Q — management's own
// period-over-period comparison ("the increase was primarily due to…") — but
// every narrative tool was 10-K-only, so the model could only grope at the
// 10-Q through search_filings + fetch_page passages inside small budgets, and
// causal questions on recent quarters degraded to bare figures (Sandisk,
// 2026-11). This reads the latest 10-Qs directly and returns the MD&A (and
// Part II risk factors, the forward change signal) as attributed excerpts.
//
// Deterministic and read-only: plain SEC fetches with no cache writes, the
// same review-visible path as the 10-K context read in keypoints.js
// (ASK_REVIEW_LIVE_FILING_CONTEXT governs nothing here — get_key_points never
// offered a quarterly variant, so there is no cached equivalent to serve).

const axios = require('axios');
const filingSections = require('./filing-sections');
const secSource = require('./sec-source');

// MD&A gets the bulk of the budget; it is the section the tool exists for.
// The caps are deliberately small: ask-report-evidence.boundNarrative trims
// every text slot to its FIRST allocation of bytes across the whole result
// (8192 by default), so a long excerpt loses its tail. A 12000-char MD&A was
// cut to ~2978 chars — ending before "Results of Operations" — and the model
// never saw a single "primarily due to" sentence, which is why a causal
// question still fell back to the receipt with the tool installed (measured on
// SNDK, 2026-11-19). Keeping the whole payload inside that allowance means the
// driver sentences survive transport intact.
const SECTION_CAPS = { 'MD&A — Item 2': 2600, 'Risk Factors (Part II, Item 1A)': 700 };
const TOTAL_BUDGET = 7000;

// Management's own cause sentences, in document order and VERBATIM. Truncation
// keeps the head, so the excerpt has to lead with the reasons rather than with
// whatever the overview happens to say first. Nothing is paraphrased: every
// kept sentence is copied exactly, so the audit can match its figures and
// percents against this same text.
const CAUSE = /\b(?:primarily due to|due to|driven by|as a result of|attributable to|reflect(?:s|ed|ing)? (?:higher|lower|stronger|weaker|the)|because of|offset by)\b/i;
const MOVE = /\b(?:increased|decreased|grew|grow|declined|rose|fell|higher|lower)\b/i;
const AMOUNT = /(?:\d[\d,.]*\s?%|\$\s?\d|[€£¥]\s?\d)/;
function driverExcerpt(text, budget) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= budget) return clean;
    const sentences = clean.match(/[^.!?]+[.!?]+|.+$/g) || [];
    const scored = sentences.map((sentence, index) => {
        const cause = CAUSE.test(sentence) && AMOUNT.test(sentence) ? 3 : CAUSE.test(sentence) ? 2 : 0;
        const move = !cause && MOVE.test(sentence) && AMOUNT.test(sentence) ? 1 : 0;
        return { sentence: sentence.trim(), index, score: cause || move };
    });
    const lead = clean.slice(0, Math.min(300, Math.floor(budget * 0.15)));
    let used = lead.length;
    const kept = [];
    for (const s of scored.filter(s => s.score >= 2).sort((a, b) => b.score - a.score || a.index - b.index)) {
        if (used + s.sentence.length + 1 > budget) continue;
        kept.push(s);
        used += s.sentence.length + 1;
    }
    // Second pass: with the reasons secured, add the plain moves that put them
    // in context, still in document order.
    for (const s of scored.filter(s => s.score === 1).sort((a, b) => a.index - b.index)) {
        if (used + s.sentence.length + 1 > budget) break;
        kept.push(s);
        used += s.sentence.length + 1;
    }
    if (!kept.length) return clean.slice(0, budget);
    return `${lead} … ${kept.sort((a, b) => a.index - b.index).map(s => s.sentence).join(' ')}`;
}

// Kept for callers that want the old head+window shape; the driver excerpt
// above is what mdnaFromHtml uses because it survives the transport trim.
function capMdna(text, cap) {
    if (text.length <= cap) return text;
    return driverExcerpt(text, cap);
}

// Pure part, unit-testable: one fetched filing's HTML in, excerpt blocks out.
function mdnaFromHtml(html, filing) {
    const extracted = filingSections.extractSections(html, { form: '10-Q' });
    const blocks = [];
    if ((extracted.sections['2']?.text || '').length >= 1500) {
        blocks.push({ heading: 'MD&A — Item 2', text: extracted.sections['2'].text });
    }
    if ((extracted.sections['P2-1A']?.text || '').length >= 1500) {
        blocks.push({ heading: 'Risk Factors (Part II, Item 1A)', text: extracted.sections['P2-1A'].text });
    }
    if (!blocks.length) return null;
    let budget = TOTAL_BUDGET;
    const sections = [];
    for (const block of blocks) {
        if (!budget) break;
        const cap = Math.min(SECTION_CAPS[block.heading] || 6000, budget);
        const text = block.heading === 'MD&A — Item 2' ? capMdna(block.text, cap) : block.text.slice(0, cap);
        budget -= text.length;
        sections.push({ heading: block.heading, text, trimmed: block.text.length > text.length + 16 });
    }
    return { form: filing.form || '10-Q', date: filing.date || '', url: filing.url || '', accession: filing.accession || '', sections };
}

// The most recent 10-Qs for a symbol, with MD&A excerpts. `quarters` caps how
// many reports are read; _deps injects fetches for tests.
async function extractMdna(symbol, { quarters = 2, _deps } = {}) {
    const key = String(symbol || '').toUpperCase().trim();
    if (!key) return { error: 'No symbol given.' };
    const deps = _deps || {};
    const fetchFilings = deps.fetchFilings || ((sym) => require('./watchdog').fetchRecentFilings(sym, new Set(['10-Q', '10-Q/A']), 12));
    const get = deps.get || (async (url) => {
        await require('./sec-throttle').take();
        return axios.get(url, { headers: secSource.SEC_HEADERS, timeout: 20000, maxContentLength: 15e6 });
    });

    const filings = await fetchFilings(key);
    if (!filings || !filings.length) return { error: 'No quarterly report (10-Q) found for this company.' };

    const read = [];
    for (const filing of filings.slice(0, Math.max(1, Math.min(4, quarters)))) {
        if (!filing.url || !/\.htm/i.test(filing.url)) continue;
        try {
            const r = await get(filing.url);
            const entry = mdnaFromHtml(r.data, filing);
            // A 10-Q/A restating the original accession can repeat MD&A:
            // identical head AND tail is one excerpt twice, not two quarters.
            // (Tail-only matching merged two different quarters whose boilerplate
            // ended alike.)
            if (entry) {
                const sig = (t) => `${t.length}|${t.slice(0, 300)}|${t.slice(-300)}`;
                const mine = sig(entry.sections[0].text);
                if (!read.some(existing => sig(existing.sections[0]?.text || '') === mine)) read.push(entry);
            }
        } catch (_) { /* an unfetchable filing is skipped, not fatal */ }
    }
    if (!read.length) return { error: 'Could not read MD&A text from this company’s 10-Q filings.' };

    return {
        symbol: key,
        sourceType: 'sec_mdna',
        filings: read,
        retrievedAt: new Date().toISOString(),
        note: 'Management’s Discussion and Analysis excerpts from the issuer’s own quarterly reports — management’s stated reasons for period-over-period changes. Driver and reason statements may be attributed to the specific 10-Q with its filed date; figures quoted from MD&A narrative still need a supplied observation or the exact quoted wording. This is narrative evidence, not a substitute for the statement tables.'
    };
}

module.exports = { extractMdna, mdnaFromHtml, driverExcerpt, SECTION_CAPS, TOTAL_BUDGET };
