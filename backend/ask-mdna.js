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
// 12000 each lets two recent quarters share the 28000-char total with room
// left over for the Part II risk-factor excerpt.
const SECTION_CAPS = { 'MD&A — Item 2': 12000, 'Risk Factors (Part II, Item 1A)': 6000 };
const TOTAL_BUDGET = 28000;

// A pure head slice of MD&A stops before "Results of Operations" — the exact
// subsection carrying the period-over-period reasons ("net revenues increased
// $… primarily driven by…") — whenever the overview runs long. Keep the head
// of the overview, then a window anchored on Results of Operations.
function capMdna(text, cap) {
    if (text.length <= cap) return text;
    const head = Math.floor(cap * 0.3);
    const rest = cap - head;
    // The Item 2 heading itself ends in "…Results of Operations", so the
    // subsection search must start past the heading.
    const roPos = text.slice(500).search(/results\s+of\s+operations/i);
    if (roPos > head + 500) {
        const start = 500 + Math.max(head - 200, roPos - Math.floor(rest * 0.1));
        return `${text.slice(0, head)}\n…[trimmed]…\n${text.slice(start, start + rest)}`;
    }
    return text.slice(0, cap);
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

module.exports = { extractMdna, mdnaFromHtml, SECTION_CAPS, TOTAL_BUDGET };
