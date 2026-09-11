// Shared 10-K/10-Q section extractor.
//
// Replaces two near-identical windowing implementations (keypoints.js
// dossierWindows, filing-diff.js narrativeWindows), both of which had the same
// three defects — measured against real filings, not assumed:
//
//   1. Tag stripping fused words. Replacing EVERY tag with a space shatters
//      text split across inline tags: Berkshire's real headings come out as
//      "Item 1. Busines s Description" / "Item 1A. Ris k Factors". Exact-phrase
//      anchors then miss the body and match the table of contents instead.
//   2. First-match anchoring. re.exec() returns the FIRST hit, which in a 10-K
//      is the table of contents — so windows were cut from the TOC, not the
//      section. Every Item is named at least twice, both runs in ascending
//      order, so a plain first-occurrence walk always lands on the TOC.
//   3. Front-loaded truncation. The old buffer filled front-to-back and broke
//      at a global cap, so later sections contributed ZERO bytes rather than
//      being trimmed. Whole topics vanished silently. Measured result: the
//      model saw 1.3%-11.5% of the filing (median ~5%).
//
// The fix: strip inline tags without a space, anchor on a whitespace-free
// projection of the text, walk twice to skip the TOC, and give every section
// its own budget so nothing can starve anything else.

// Inline tags carry styling/kerning and often split a single word across
// several elements — they must vanish WITHOUT leaving a space. SEC inline-XBRL
// (<ix:nonNumeric>, <ix:nonFraction>) is the worst offender.
const INLINE_TAGS = /<\/?(?:span|b|i|u|em|strong|font|a|sup|sub|small|nobr|ix:[a-z:-]+)\b[^>]*>/gi;

function htmlToText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(INLINE_TAGS, '')      // keeps words intact
        .replace(/<[^>]+>/g, ' ')      // block-level tags are real separators
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#8217;|&rsquo;|&#146;/g, '’')
        .replace(/&#8212;|&mdash;/g, '—')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// A whitespace-free, lowercased projection plus an index map back to the
// original. Headings are matched against this, so stray spaces inside a word
// ("Busines s Description") can never break an anchor.
function compactProjection(text) {
    let compact = '';
    const map = new Array(text.length);
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === ' ') continue;
        compact += c.toLowerCase();
        map[n++] = i;
    }
    map.length = n;
    return { compact, map };
}

// Patterns run against the compacted text, so they carry no whitespace.
// Ordered by position in a filing — the walk below depends on that order.
// Filings insert the registrant's own name between the item number and the
// section title ("Item 7. Bank of America Corporation and Subsidiaries
// Management's Discussion and Analysis"), and energy/REIT issuers routinely
// combine items ("Item 1 and 2. Business and Properties"). NAME allows for the
// former; it is bounded so it can never bridge two unrelated headings.
const NAME = "[a-z,'&.()]{0,90}";
const SECTIONS = [
    { key: '1',  label: 'Business',            re: new RegExp(`item1(?:and2)?[.:)\\-–—]{0,2}${NAME}business`, 'g') },
    { key: '1A', label: 'Risk Factors',        re: new RegExp(`item1a[.:)\\-–—]{0,2}${NAME}riskfactors`, 'g') },
    { key: '1B', label: 'Unresolved Comments', re: /item1b[.:)\-–—]{0,2}unresolved/g },
    { key: '2',  label: 'Properties',          re: /item2[.:)\-–—]{0,2}(?:descriptionof)?propert/g },
    { key: '3',  label: 'Legal Proceedings',   re: new RegExp(`item3[.:)\\-–—]{0,2}${NAME}legalproceedings`, 'g') },
    { key: '5',  label: 'Market for Equity',   re: /item5[.:)\-–—]{0,2}marketfor/g },
    { key: '7',  label: 'MD&A',                re: new RegExp(`item7[.:)\\-–—]{0,2}${NAME}management.{0,3}sdiscussion`, 'g') },
    { key: '7A', label: 'Quantitative Risk',   re: new RegExp(`item7a[.:)\\-–—]{0,2}${NAME}quantitative`, 'g') },
    { key: '8',  label: 'Financial Statements',re: new RegExp(`item8[.:)\\-–—]{0,2}${NAME}financialstatements`, 'g') },
    { key: '9A', label: 'Controls',            re: /item9a[.:)\-–—]{0,2}controls/g }
];

// Per-section budgets, sized from a survey of 18 real filings: core narrative
// (1+1A+3+7+7A) measured 111K-427K chars, median 223K. Risk Factors is the
// largest section in every filing sampled (68K-151K), which is why it gets the
// biggest allowance — and why the old code, which had no Risk Factors anchor
// at all, was missing the single densest part of the document.
const SECTION_BUDGETS = { '1': 60000, '1A': 100000, '3': 10000, '7': 60000, '7A': 10000 };
const CORE_KEYS = ['1', '1A', '3', '7', '7A'];

// A foreign private issuer files Form 20-F, whose item scheme is unrelated to a
// 10-K's: risk factors live at Item 3.D rather than 1A, the business description
// at Item 4 rather than 1, and MD&A at Item 5 rather than 7. Running the 10-K
// patterns over a 20-F therefore locates nothing at all, which is why every
// filing-derived feature came back empty for NetEase and Alibaba.
// Ordered by position in the document, as greedyWalk requires.
const SECTIONS_20F = [
    // Risk factors sit under "Item 3. Key Information" as a lettered subsection,
    // and the heading in the body is the bare "D. Risk Factors" — the "Item 3"
    // prefix appears only in cross-references ("see Item 3.D. 'Key Information —
    // Risk Factors'"), which this cannot match because the quote entity and
    // em-dash between them fall outside NAME. Requiring a separator after the "d"
    // keeps it from matching a word that merely ends in one.
    // A 20-F cross-references its own risk factors constantly ("see Item 3.D
    // 'Key Information — Risk Factors — Risks Related to…'"), and those citations
    // are textually identical to the heading, so no anchor pattern can separate
    // them. Size does: the real section runs to tens of thousands of characters
    // (NTES 100K+) while a citation spans a few thousand before the next heading.
    // minChars makes repairShortPicks walk past them to the body.
    { key: '3D', label: 'Risk Factors', minChars: 20000, re: /d[.:)\-–—]{1,2}riskfactors/g },
    // Same citation problem as 3D, same size-based remedy: the business
    // description and MD&A both run to tens of thousands of characters, while a
    // "see Item 4 …" reference spans only as far as the next heading.
    { key: '4',  label: 'Information on the Company', minChars: 15000, re: new RegExp(`item4[.:)\\-–—]{0,2}${NAME}informationonthecompany`, 'g') },
    { key: '4A', label: 'Unresolved Comments',     re: /item4a[.:)\-–—]{0,2}unresolved/g },
    { key: '5',  label: 'Operating and Financial Review', minChars: 15000, re: new RegExp(`item5[.:)\\-–—]{0,2}${NAME}operating(?:and)?financialreview`, 'g') },
    { key: '8',  label: 'Financial Information',   re: new RegExp(`item8[.:)\\-–—]{0,2}${NAME}financialinformation`, 'g') },
    { key: '11', label: 'Quantitative Risk',       re: new RegExp(`item11[.:)\\-–—]{0,2}${NAME}quantitative`, 'g') },
    { key: '15', label: 'Controls',                re: /item15[.:)\-–—]{0,2}controls/g }
];

// Same sizing logic as the 10-K budgets: risk factors dominate, so 3.D gets the
// largest allowance, with the business description and MD&A next.
const SECTION_BUDGETS_20F = { '3D': 100000, '4': 60000, '5': 60000, '11': 10000 };
const CORE_KEYS_20F = ['3D', '4', '5', '11'];

// 40-F (Canadian MJDS) deliberately falls through to the 10-K profile: its
// narrative lives in an attached Canadian AIF with no SEC item numbering at all,
// so neither table fits and pretending otherwise would invent sections.
function profileFor(form) {
    return String(form || '').toUpperCase().startsWith('20-F')
        ? { sections: SECTIONS_20F, keys: CORE_KEYS_20F, budgets: SECTION_BUDGETS_20F }
        : { sections: SECTIONS, keys: CORE_KEYS, budgets: SECTION_BUDGETS };
}

// Walk sections in document order, each pick strictly after the previous one.
function greedyWalk(hits, from) {
    let prev = from;
    const out = [];
    for (const h of hits) {
        const at = h.positions.find((p) => p > prev);
        if (at === undefined) { out.push({ ...h, start: null }); continue; }
        out.push({ ...h, start: at });
        prev = at;
    }
    return out;
}

// A section shorter than this is a table-of-contents line or a bare
// cross-reference ("See Litigation in Note 30"), not the section itself.
const MIN_SECTION_CHARS = 200;

// A walk can still mix a TOC pick with a body pick when an item appears in one
// but not the other. Any pick whose span comes out implausibly short is
// therefore re-anchored to that item's next occurrence, until it either looks
// like a real section or runs out of candidates.
function repairShortPicks(picked, hits, total) {
    const positionsFor = new Map(hits.map((h) => [h.key, h.positions]));
    // Guard raised from 4: a 20-F can cite its own risk-factors section many
    // times before the body heading, and each citation costs one iteration.
    for (let guard = 0; guard < 12; guard++) {
        const located = picked.filter((s) => s.start !== null).sort((a, b) => a.start - b.start);
        let changed = false;
        for (let i = 0; i < located.length; i++) {
            const cur = located[i];
            const end = i + 1 < located.length ? located[i + 1].start : total;
            if (end - cur.start >= (cur.minChars || MIN_SECTION_CHARS)) continue;
            const later = (positionsFor.get(cur.key) || []).find((p) => p > cur.start);
            if (later === undefined) continue;
            picked.find((s) => s.key === cur.key).start = later;
            changed = true;
        }
        if (!changed) break;
    }
    return picked;
}

// Locate every section start. The first walk lands on the table of contents
// (all Items listed within a few hundred chars of each other); the second,
// starting past it, lands on the body. Filings with no TOC resolve on the
// first walk, so keep whichever pass found more.
function locateSections(compact, sectionTable = SECTIONS) {
    const hits = sectionTable.map((s) => {
        const re = new RegExp(s.re.source, 'g');
        const positions = [];
        let m;
        while ((m = re.exec(compact)) !== null) positions.push(m.index);
        return { key: s.key, label: s.label, positions, minChars: s.minChars };
    });

    const first = greedyWalk(hits, -1);
    const lastOfFirst = Math.max(...first.map((s) => (s.start === null ? -1 : s.start)));
    const second = greedyWalk(hits, lastOfFirst);

    const found = (pass) => pass.filter((s) => s.start !== null).length;
    const picked = (found(second) >= 3 && found(second) >= found(first) - 1) ? second : first;
    return repairShortPicks(picked, hits, compact.length);
}

// Head-biased trim with a tail sample. Risk factors and MD&A are ordered by
// materiality, so the head matters most — but the tail carries recent
// developments and conclusions, which a pure head slice would drop.
function fitToBudget(text, budget) {
    if (text.length <= budget) return text;
    const head = Math.floor(budget * 0.75);
    const tail = budget - head;
    return `${text.slice(0, head)}\n…[section trimmed]…\n${text.slice(text.length - tail)}`;
}

// Extract the narrative sections of a filing.
//   extractSections(html)                     -> core 10-K sections, budgeted
//   extractSections(html, { form: '20-F' })   -> the 20-F item scheme instead
//   extractSections(html, { keys, budgets })  -> override which/how much
// Returns { text, sections: { KEY: {label, text, chars, trimmed} }, located, coverage }
function extractSections(html, { keys, budgets, form } = {}) {
    const profile = profileFor(form);
    const useKeys = keys || profile.keys;
    const useBudgets = budgets || profile.budgets;
    const text = typeof html === 'string' && /<[a-z!/]/i.test(html.slice(0, 4000))
        ? htmlToText(html)
        : String(html || '').replace(/\s+/g, ' ').trim();
    const { compact, map } = compactProjection(text);
    const located = locateSections(compact, profile.sections).filter((s) => s.start !== null)
        .sort((a, b) => a.start - b.start);

    const sections = {};
    let rawTotal = 0;
    let keptTotal = 0;
    for (let i = 0; i < located.length; i++) {
        const cur = located[i];
        if (!useKeys.includes(cur.key)) continue;
        const startC = cur.start;
        const endC = i + 1 < located.length ? located[i + 1].start : compact.length;
        // map compact offsets back onto the original spaced text
        const start = map[startC];
        const end = endC < map.length ? map[endC] : text.length;
        const body = text.slice(start, end).trim();
        if (body.length < MIN_SECTION_CHARS) continue;   // a cross-reference, not a section
        const budget = useBudgets[cur.key] || 20000;
        const kept = fitToBudget(body, budget);
        rawTotal += body.length;
        keptTotal += kept.length;
        sections[cur.key] = {
            label: cur.label,
            text: kept,
            chars: kept.length,
            trimmed: kept.length < body.length
        };
    }

    return {
        text,
        sections,
        located: located.map((s) => s.key),
        coverage: rawTotal ? keptTotal / rawTotal : 0
    };
}

// Single concatenated block, for callers that want one prompt instead of one
// call per section. Sections are labelled so the model knows what it is reading.
function sectionsAsText(sections, keys = CORE_KEYS) {
    return keys
        .filter((k) => sections[k])
        .map((k) => `## Item ${k} — ${sections[k].label}\n${sections[k].text}`)
        .join('\n\n');
}

module.exports = {
    htmlToText,
    extractSections,
    sectionsAsText,
    compactProjection,
    profileFor,
    CORE_KEYS,
    SECTION_BUDGETS,
    CORE_KEYS_20F,
    SECTION_BUDGETS_20F
};
