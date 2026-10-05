'use strict';

// Deterministic checks of the generated presentation against supplied evidence.
// These checks do not claim to verify arbitrary narrative or outside research.
const { number: num, cik: validCik } = require('./sec-coverage');
const { capitalReturns } = require('./ask-evidence');
const segmentProof = require('./ask-segment-evidence');
const filingCurrency = require('./ask-filing-currency');
const unitName = unit => unit === '$' ? 'USD' : unit === '$ps' ? 'USD/share' : unit;
const unwrap = results => results.map(r => r.result || r).filter(r => !r.error);
const ENTITY_DISCLOSURE_TERMS = /\b(?:SPVs?|SPEs?|special purpose (?:vehicles?|entity|entities)|unconsolidated|variable interest (?:entity|entities)|VIEs?|off[- ]balance[- ]sheet|off[- ]book|securitiz\w*)\b/i;
const DISCLOSURE_TERMS = /\b(?:SPVs?|SPEs?|special purpose (?:vehicles?|entity|entities)|unconsolidated|variable interest (?:entity|entities)|VIEs?|off[- ]balance[- ]sheet|off[- ]book|guarantees?|leases?|commitments?|purchase obligations?|debt disclosures?|debt maturit\w*)\b/i;

function disclosureCategory(text, amountStart = null, amountEnd = amountStart) {
    const s = String(text || '');
    const categories = [
        ['lease_obligation', /\blease(?:s|d|ing)?\b/gi],
        ['guarantee', /\bguarantee(?:s|d)?\b/gi],
        ['commitment', /\b(?:purchase|contractual|capital) commitments?|purchase obligations?\b/gi],
        ['entity_or_securitization_exposure', /\b(?:SPV|SPE|special purpose|unconsolidated|variable interest|VIE|securitiz)\w*\b|\b(?:maximum )?exposure to loss\b/gi],
        ['reported_debt', /\b(?:debt|borrowings|notes payable)\b/gi]
    ];
    if (Number.isFinite(amountStart) && Number.isFinite(amountEnd)) {
        const matches = [];
        for (const [category, pattern] of categories) {
            pattern.lastIndex = 0;
            let m;
            while ((m = pattern.exec(s)) !== null) {
                const gap = m.index + m[0].length < amountStart ? amountStart - (m.index + m[0].length)
                    : m.index > amountEnd ? m.index - amountEnd : 0;
                // The obligation label must be attached to the amount. This
                // excludes nearby section headings and amounts from adjacent
                // disclosures, which are common in SEC filing excerpts.
                if (gap <= 48) matches.push({ category, gap });
            }
        }
        matches.sort((a, b) => a.gap - b.gap);
        if (!matches.length || (matches[1] && matches[0].gap === matches[1].gap && matches[0].category !== matches[1].category)) return null;
        return matches[0].category;
    }
    if (/\blease/i.test(s)) return 'lease_obligation';
    if (/\bguarantee/i.test(s)) return 'guarantee';
    if (/\b(?:purchase|contractual|capital) commitment|purchase obligation/i.test(s)) return 'commitment';
    if (/\b(?:SPV|SPE|special purpose|unconsolidated|variable interest|VIE|securitiz)/i.test(s)) return 'entity_or_securitization_exposure';
    if (/\b(?:debt|borrowings|notes payable)\b/i.test(s)) return 'reported_debt';
    return null;
}

function sentenceAround(text, index) {
    const s = String(text || '');
    const boundary = /[.!?](?:\s+|$)(?=[A-Z“"'(])/g;
    let start = 0, end = s.length, m;
    boundary.lastIndex = 0;
    while ((m = boundary.exec(s)) !== null) {
        if (m.index < index) start = boundary.lastIndex;
        else { end = m.index + 1; break; }
    }
    return { start, end, text: s.slice(start, end).trim() };
}

function clauseAround(sentence, amountStart) {
    const s = String(sentence || '');
    const delimiters = /[;,]/g;
    let start = 0, end = s.length, m;
    while ((m = delimiters.exec(s)) !== null) {
        if (m.index < amountStart) start = m.index + 1;
        else { end = m.index; break; }
    }
    const raw = s.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    return { text: raw.trim(), start: start + leading };
}

function disclosedPeriodEnd(context) {
    const s = String(context || '');
    const qualifier = /\b(?:as of|as at|at|period ended|year ended|for the year ended|ending)\s+/i;
    const tails = s.split(qualifier).slice(1);
    if (!tails.length) return null;
    const months = 'January February March April May June July August September October November December'.split(' ');
    const monthPattern = months.join('|');
    const dates = new Set();
    for (const tail of tails) {
        let ymd = tail.match(/^(\d{4})-(\d{2})-(\d{2})\b/);
        if (ymd && validCalendarDate(ymd[0])) { dates.add(ymd[0]); continue; }
        const monthFirst = tail.match(new RegExp(`^(${monthPattern})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
        const dayFirst = tail.match(new RegExp(`^(\\d{1,2})\\s+(${monthPattern})\\s+(\\d{4})`, 'i'));
        if (monthFirst) ymd = [null, monthFirst[3], String(months.findIndex(m => m.toLowerCase() === monthFirst[1].toLowerCase()) + 1).padStart(2, '0'), monthFirst[2].padStart(2, '0')];
        else if (dayFirst) ymd = [null, dayFirst[3], String(months.findIndex(m => m.toLowerCase() === dayFirst[2].toLowerCase()) + 1).padStart(2, '0'), dayFirst[1].padStart(2, '0')];
        if (ymd && validCalendarDate(`${ymd[1]}-${ymd[2]}-${ymd[3]}`)) dates.add(`${ymd[1]}-${ymd[2]}-${ymd[3]}`);
    }
    return dates.size === 1 ? [...dates][0] : null;
}

function validCalendarDate(value) {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function filingNarrativeEvidence(results) {
    const wrapped = results.map(r => ({ tool: r.tool, result: r.result || r }));
    const searched = wrapped.filter(r => r.tool === 'search_filings').flatMap(r => r.result.results || []);
    const out = [];
    const amount = /(?<![A-Za-z])((?:U\.S\.|US|HK|NZ|C|A|S)\$|USD|JPY|EUR|GBP|CAD|AUD|CHF|CNY|HKD|SGD|NZD|INR|KRW|RMB|\$|¥|€|£)\s*([−–-]?\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million|tn|bn|[TtBbMmKk]\b)?/g;
    for (const { tool, result } of wrapped) {
        if (tool !== 'fetch_page' || !/^https:\/\/([a-z0-9-]+\.)*sec\.gov\//i.test(String(result.url || '')) ||
            !searched.some(x => x.url === result.url) || /keyword\s+["“].*?["”]\s+not found/i.test(String(result.note || '')) || !result.text) continue;
        const hit = searched.find(x => x.url === result.url) || {};
        const currencyBasis = filingCurrency.filingBasis(results, result);
        let m;
        while ((m = amount.exec(String(result.text))) !== null) {
            // Unscaled figures in filing tables commonly use the page's
            // "in millions" heading. Do not turn those raw table cells into
            // narrative dollars from nearby text.
            if (!m[3]) continue;
            const currency = filingCurrency.code(m[1], currencyBasis);
            if (!currency) continue;
            const suffix = String(m[3] || '').toLowerCase();
            const scale = /^(?:trillion|tn|t)$/.test(suffix) ? 1e12 : /^(?:billion|bn|b)$/.test(suffix) ? 1e9
                : /^(?:million|m)$/.test(suffix) ? 1e6 : suffix === 'k' ? 1e3 : 1;
            const raw = m[2].replace(/,/g, '').replace(/[−–]/g, '-');
            const value = Number(raw);
            if (!Number.isFinite(value)) continue;
            const sentence = sentenceAround(String(result.text), m.index);
            const context = sentence.text;
            const amountStart = m.index - sentence.start;
            const clause = clauseAround(context, amountStart);
            const category = disclosureCategory(clause.text, amountStart - clause.start, amountStart - clause.start + m[0].length);
            if (!category) continue;
            const accession = String(result.url).match(/\/([0-9]{18})\//)?.[1] || null;
            out.push({ value: Math.round(value * scale), unit: currency, field: 'filingNarrativeAmount', periodEnd: disclosedPeriodEnd(context),
                sourceIds: [`sec-filing:${accession || result.url}`], sourceType: 'sec_filing_narrative',
                filingUrl: result.url, filingDate: hit.filed || null, form: hit.form || null, accessionNumber: accession,
                category, context });
        }
        amount.lastIndex = 0;
    }
    return out;
}

// Table rows are data, not prose — a metrics-over-periods table is the shape
// the answer prompt asks for, so charging its cells against the prose budget
// made the two rules unsatisfiable. Tables are bounded separately in audit().
function wordCount(text) {
    return String(text).replace(/```[\s\S]*?```/g, '')
        .replace(/^\s*\|.*$/gm, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim().split(/\s+/).filter(Boolean).length;
}
function wordLimit(question, mode) {
    return require('./ask-report-policy').select(question, mode).maxWords;
}

function chartEvidence(results) {
    const out = [];
    function visit(value, currency, field, periodEnd) {
        if (!value || typeof value !== 'object') return;
        currency = value.currency || currency;
        if(value.sourceType && value.field){if(value.sourceType==='calculation'?!require('./company-calculations').validCalculation(value):!require('./company-observations').validSupplement(value,value.issuer))return;field=value.field;}
        periodEnd = value.periodEnd || periodEnd;
        if (num(value.value) !== null && value.sourceIds?.length) {
            const name = value.formula === 'operatingCashflow - abs(capitalExpenditures)' ? 'freeCashflow' : field;
            const unit = value.unit || (/Pct$/.test(field || '') ? '%' : /^(currentRatio|debtToEquity|ocfToNetIncome)$/.test(field || '') ? 'x' : field === 'sharesOutM' ? 'million_shares' : currency);
            out.push({ value: num(value.value), unit: unitName(unit),
                field: name, periodEnd, sourceIds: value.sourceIds,sourceType:value.sourceOrigin || value.sourceType,sourceName:value.sourceName,sourceUrl:value.sourceUrl,accountingBasis:value.accountingBasis,basis:value.historyBasis || value.basis,publicationDate:require('./company-observations').sourceDate(value) });
        }
        if (num(value.changePct) !== null && value.sourceIds?.length) {
            out.push({ value: num(value.changePct), unit: '%', field, periodEnd: value.current?.periodEnd, sourceIds: value.sourceIds });
        }
        if (value.sourceIds?.length && value.currency) {
            for (const key of ['freeCashflow', 'totalDistributions', 'surplusAfterDistributions']) {
                if (num(value[key]) !== null) out.push({ value: num(value[key]), unit: value.currency, field: key, periodEnd, sourceIds: value.sourceIds });
            }
        }
        for (const [key, item] of Object.entries(value)) {
            if (['provenance', 'sources', 'coverage', 'inputs', 'sourceIds','reconciliation'].includes(key)) continue;
            const nextField = /^(current|previous)$/.test(key) ? field : key;
            if (Array.isArray(item)) for (const child of item) visit(child, currency, nextField, periodEnd);
            else if (item && typeof item === 'object') visit(item, currency, nextField, periodEnd);
        }
    }
    for (const result of unwrap(results)) visit(result, result.currency, null, null);
    out.push(...filingNarrativeEvidence(results));
    out.push(...filingQuoteEvidence(results));
    return out;
}

// The chart renderer only supports facet panels for grouped bars. The model has
// twice returned a valid financial time series with `facet: true` in a `viz`
// block; the validator correctly refused it, but the rewrite repeated the same
// invalid shape. Convert that explicit split-scale request to the renderer's
// supported bar shape while preserving every point verbatim.
function normalizeFacetedViz(text) {
    return String(text || '').replace(/```viz\s*\n([\s\S]*?)```/g, (fence, body) => {
        let spec;
        try { spec = JSON.parse(body); } catch (_) { return fence; }
        // The model sometimes labels a segment-flow payload as a line chart.
        // Correct only the fence; the full Sankey evidence audit still applies.
        if (!spec.series && !spec.rows && Array.isArray(spec.segments) && spec.segments.length &&
            spec.total !== undefined && spec.unallocated !== undefined && spec.periodEnd && spec.filingDate && spec.accessionNumber && spec.sourceUrl)
            return `\`\`\`sankey\n${JSON.stringify(spec)}\n\`\`\``;
        if (!Array.isArray(spec.series) || !spec.series.length || spec.series.length > 3 ||
            spec.series.some(series => !Array.isArray(series?.points) || series.points.length < 2 || series.points.length > 8))
            return fence;
        const values = spec.series.flatMap(series => series.points.map(point => num(point?.[1])))
            .filter(value => value !== null && value !== 0).map(Math.abs);
        const peak = values.length ? Math.max(...values) : 0;
        const base = values.length ? Math.min(...values) : 0;
        if (spec.facet !== true && !(spec.series.length > 1 && base > 0 && peak / base > 10)) return fence;
        const bars = { ...spec, orientation: 'vertical', facet: true };
        return `\`\`\`bars\n${JSON.stringify(bars)}\n\`\`\``;
    });
}

function metricForLabel(label) {
    const s = String(label || '');
    return /stock price|share price/i.test(s) ? 'price'
        : /share.?based compensation|\bSBC\b/i.test(s) ? 'shareBasedCompensation'
        : /free cash|\bFCF\b/i.test(s) ? 'freeCashflow'
        : /operating cash/i.test(s) ? 'operatingCashflow'
        : /capex|capital expend/i.test(s) ? 'capitalExpenditures'
        : /net income|net profit|earnings/i.test(s) ? 'netIncome'
        : /revenue|sales/i.test(s) ? 'totalRevenue'
        : /gross profit/i.test(s) ? 'grossProfit'
        : /operating income|EBIT/i.test(s) ? 'operatingIncome'
        : null;
}

// A segment chart is allowed only when its values can be tied to the same
// verified annual filing as consolidated revenue. The legacy segment parser
// can repair units against a cached provider value; this check makes that
// output ineligible unless it also reconciles to the SEC XBRL observation.
function segmentEvidence(segmentResult, incomeResult) {
    if(segmentResult?.storedSegmentsReceipt) {
        const g=segmentResult.storedSegmentsReceipt;
        if(!require('./sec-segment-observations').validGroup(g,segmentResult.financialWitness))return {status:'unverified',reason:'Stored segment context provenance is invalid.'};
        if(g.reconciliationStatus!=='reconciled' || g.entries.some(e=>!e.label || e.value<0) || g.sum>g.totalRevenue || g.totalRevenue<=0)return {status:'unverified',reason:'The original group requires signed entries, missing member labels or unresolved reconciliation; present its source table without a complete Sankey.'};
        return {status:'eligible',currency:g.currency,periodEnd:g.periodEnd,filingDate:g.publicationDate,form:segmentResult.filing.form,accessionNumber:g.sourceVersion,sourceUrl:g.sourceUrl,totalRevenue:g.totalRevenue,totalSourceIds:g.totalSourceIds,segmentTotal:g.sum,difference:g.difference,unallocated:g.difference,segments:g.entries.map(e=>({name:e.label,value:e.value}))};
    }
    const filing = segmentResult?.filing || {};
    const issuerCik = validCik(segmentResult.cik);
    const anchor = segmentProof.exactAnnualRevenue(filing, incomeResult || segmentResult.revenueEvidence, issuerCik);
    if (!anchor) return { status: 'unverified', reason: 'No unique verified annual revenue fact matches the issuer, exact filing, period and currency.' };
    if (!segmentProof.validCachedPayload(segmentResult, issuerCik, filing, anchor))
        return { status: 'unverified', reason: 'Segment amounts, currency and scale lack validated literal filing-text evidence.' };
    const segments = segmentResult.segments.map(({ name, value }) => ({ name, value }));
    const total = anchor.value, segmentTotal = segments.reduce((n, s) => n + s.value, 0);
    if (!(total > 0) || segmentTotal > total || segmentTotal / total < 0.98)
        return { status: 'unverified', reason: 'Segment values do not reconcile to at least 98% of filed revenue without exceeding it.' };
    const sourceIds = [anchor.sourceId];
    return {
        status: 'eligible',
        currency: anchor.currency,
        periodEnd: anchor.periodEnd,
        filingDate: filing.date,
        form: filing.form,
        accessionNumber: filing.accessionNumber,
        sourceUrl: filing.url,
        totalRevenue: total,
        totalSourceIds: sourceIds,
        segmentTotal,
        difference: total - segmentTotal,
        unallocated: total - segmentTotal,
        sourceReference: { type: 'sec_xbrl_fact', sourceIds, filingUrl: filing.url, accessionNumber: filing.accessionNumber },
        segments: segments.map(({ name, value }) => ({ name, value }))
    };
}

function verifiedSegmentEvidence(results) {
    const rows = results.map(r => ({ tool: r.tool, result: r.result || r }));
    const segment = rows.find(r => r.tool === 'get_segments')?.result;
    const income = rows.find(r => r.tool === 'get_financials' && r.result?.statement === 'income' && /^annual/.test(r.result?.basis || ''))?.result;
    if (segment?.error) return { status: 'unverified', reason: segment.error };
    return segment ? segmentEvidence(segment, segment.revenueEvidence || income) : { status: 'unverified', reason: 'Both segment extraction and annual verified statements are required.' };
}

function requestedDisclosureText(text, question = '') {
    if (ENTITY_DISCLOSURE_TERMS.test(text || '')) return true;
    if (!question) return false;
    // A request can ask about entities and several other obligation categories.
    // A retrieved lease disclosure is still useful even when no entity excerpt
    // was found; the missing entity evidence is explained separately.
    return [
        /\blease(?:s|d|ing)?\b/i,
        /\bguarantee(?:s|d)?\b/i,
        /\b(?:purchase|contractual|capital) commitments?|purchase obligations?|\bcommitments?\b/i,
        /\b(?:debt|borrowings|notes payable)\b/i
    ].some(pattern => pattern.test(question) && pattern.test(text || ''));
}

function issuerDisclosureEvidence(results, question = '') {
    const searchRows = results.filter(r => r.tool === 'search_filings').flatMap(r => (r.result || {}).results || []);
    return results.some(r => r.tool === 'fetch_page' && !r.result?.error &&
        /^https:\/\/([a-z0-9-]+\.)*sec\.gov\//i.test(String(r.result.url || '')) &&
        searchRows.some(hit => hit.url === r.result.url) &&
        !/keyword\s+["“].*?["”]\s+not found/i.test(String(r.result.note || '')) &&
        requestedDisclosureText(r.result.text, question));
}

// The MATHS rule tells the model to put every non-trivial calculation through the
// calculator, but nothing collected its output — so a sum the model was INSTRUCTED
// to compute could still be rejected as an unsourced claim. A result counts only
// when every number in its expression is itself a supplied fact or a bare
// unit/period constant (100 for a percentage, 1e9 for a scale): a remembered
// figure typed in as 999999999 is neither, so the calculator cannot launder one.
const BARE_CONSTANTS = new Set([0, 1, 2, 3, 4, 5, 7, 10, 12, 30, 52, 100, 365]);
const bareConstant = (v) => BARE_CONSTANTS.has(v) || (Number.isInteger(v) && Math.abs(v) <= 400) || /^10{1,15}$/.test(String(v));
function calculatorClaims(results, facts) {
    const near = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-9, 1e-9);
    const out = [];
    for (const r of results) {
        const result = r && r.result ? r.result : r;
        if (!result || typeof result !== 'object') continue;
        for (const item of (Array.isArray(result.results) ? result.results : [result])) {
            if (!item || typeof item.expression !== 'string' || num(item.result) === null) continue;
            const literals = (item.expression.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []).map(Number);
            if (!literals.length) continue;
            const matched = literals.map(n => bareConstant(n) ? null : facts.find(f => near(f.value, n)));
            if (literals.some((n, i) => !matched[i] && !bareConstant(n))) continue;
            const units = [...new Set(matched.filter(Boolean).map(f => f.unit))];
            out.push({ value: num(item.result), unit: units.length === 1 ? units[0] : null });
        }
    }
    return out;
}

// get_filing_diff quotes are checked character-for-character against the filing
// they name (the tool reports evidenceVerified), so a figure inside one is a filed
// figure — and the framework's "how it makes money" and "key risks" sections are
// written from them. Only the QUOTE fields qualify: the tool's headline and `what`
// commentary are prose written ABOUT the filing, and harvesting those would let a
// summary's number read as though the issuer itself had stated it.
const FILING_QUOTE_FIELDS = ['quote', 'newQuote', 'priorQuote'];
const QUOTE_CURRENCIES = { $: 'USD', '¥': 'JPY', '€': 'EUR', '£': 'GBP' };
function filingQuoteEvidence(results) {
    const out = [];
    const decline = /(?:decline[sd]?|decrease[sd]?|loss(?:es)?|fell|fall|drop(?:ped)?|lower|negative|outflow)\b/i;
    for (const r of unwrap(results)) {
        if (!Array.isArray(r.changes)) continue;
        for (const change of r.changes) {
            if (!change || typeof change !== 'object') continue;
            for (const key of FILING_QUOTE_FIELDS) {
                const text = String(change[key] || '');
                if (!text) continue;
                for (const m of text.matchAll(/(?<![A-Za-z])(USD|JPY|EUR|GBP|CAD|AUD|CHF|CNY|TWD|HKD|SGD|NZD|INR|KRW|\$|¥|€|£)\s*([−–-]?\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million|tn|bn|[TtBbMmKk]\b)?/g)) {
                    // An unscaled table cell is not a narrative figure; the quote
                    // must state the scale for it to mean anything on its own.
                    if (!m[3]) continue;
                    const suffix = String(m[3]).toLowerCase();
                    const scale = /^(?:trillion|tn|t)$/.test(suffix) ? 1e12 : /^(?:billion|bn|b)$/.test(suffix) ? 1e9
                        : /^(?:million|m)$/.test(suffix) ? 1e6 : suffix === 'k' ? 1e3 : 1;
                    const magnitude = Math.abs(Number(m[2].replace(/,/g, '').replace(/[−–]/g, '-')));
                    if (!Number.isFinite(magnitude)) continue;
                    // The quote's own wording carries the sign — but only when the
                    // amount is the object of it. "a net loss of $134 million" is
                    // negative; "declined 31% year-over-year to $779 million" is a
                    // level reached, and the decline word sits near it without
                    // applying to it.
                    const before = text.slice(Math.max(0, m.index - 26), m.index);
                    const signed = /[−–-]\s*$/.test(before) ||
                        /(?:loss(?:es)?|decline[sd]?|decrease[sd]?|drop(?:ped)?|outflow|negative)\s+(?:of\s+)?(?:approximately\s+|about\s+|nearly\s+)?$/i.test(before);
                    out.push({ value: signed ? -magnitude * scale : magnitude * scale, unit: QUOTE_CURRENCIES[m[1]] || m[1], field: 'filingQuoteAmount', sourceType: 'sec_filing_narrative' });
                }
                for (const m of text.matchAll(/([+−–-]?\d+(?:\.\d+)?)\s*%/g)) {
                    const size = Math.abs(Number(m[1].replace(/[−–]/g, '-')));
                    if (!Number.isFinite(size)) continue;
                    const around = text.slice(Math.max(0, m.index - 30), m.index + 40);
                    out.push({ value: /^[+−–-]/.test(m[1]) ? Number(m[1].replace(/[−–]/g, '-')) : size, unit: '%', field: 'filingQuotePercent', sourceType: 'sec_filing_narrative' });
                    // A quoted "31% decline" and a written "fell 31%" are one filed
                    // figure in the two directions it can be phrased, so when the
                    // quote's own words name a decline both readings are supplied —
                    // the claim-side rule only sees words placed before the number,
                    // and "a 31% decline" would otherwise be unclaimable. The cost
                    // is that a direction error in the prose can pass on this
                    // figure; the number itself still has to be the quoted one.
                    if (decline.test(around)) out.push({ value: -size, unit: '%', field: 'filingQuotePercent', sourceType: 'sec_filing_narrative' });
                }
            }
        }
    }
    return out;
}

function percentageEvidence(results, facts) {
    const percentages = (facts || chartEvidence(results)).filter(f => f.unit === '%').map(f => f.value);
    for (const r of unwrap(results)) {
        if(r.storedSegmentsReceipt && require('./sec-segment-observations').validGroup(r.storedSegmentsReceipt,r.financialWitness) && r.storedSegmentsReceipt.totalRevenue>0)for(const e of r.storedSegmentsReceipt.entries)percentages.push(e.value/r.storedSegmentsReceipt.totalRevenue*100);
        if (!r.storedSegmentsReceipt && r.segments?.length) {
            const income = unwrap(results).find(i => i.statement === 'income' && /^annual/.test(i.basis || '') && (!r.symbol || i.symbol === r.symbol));
            const verified = segmentEvidence(r, r.revenueEvidence || income);
            if (verified.status === 'eligible' && verified.totalRevenue > 0) for (const segment of verified.segments) percentages.push(segment.value / verified.totalRevenue * 100);
        }
        for (const c of r.capitalReturns || []) if (num(c.shortfallPctOfFreeCashflow) !== null)
            percentages.push(c.shortfallPctOfFreeCashflow);
        // Reverse-DCF outputs carry no sourceIds (they are the tool's own
        // calculation), so chartEvidence never sees them: the implied growth
        // rate and each scenario's growth and upside were unclaimable, which
        // failed the valuation paragraph of every analyst answer that used them.
        if (num(r.impliedGrowthPct) !== null) percentages.push(num(r.impliedGrowthPct));
        for (const scenario of Object.values(r.scenarios || {})) {
            if (!scenario || typeof scenario !== 'object') continue;
            for (const key of ['growthPct', 'upsidePct']) if (num(scenario[key]) !== null) percentages.push(num(scenario[key]));
        }
        // get_peer_context computes its positioning figures itself, so they carry
        // no sourceIds and no collector saw them — yet the framework REQUIRES the
        // peer medians, the ranks and the premium to the median in sections 5 and
        // 7. Measured: the tool returns multiples.premiumPct 293.9 and the model
        // quoted it verbatim, and the audit rejected its own tool's output.
        const pp = r.peerPositioning;
        if (pp && typeof pp === 'object') {
            for (const key of ['revCagr5Pct', 'netMarginPct', 'roePct', 'divYieldPct']) {
                if (num(pp.company?.[key]) !== null) percentages.push(num(pp.company[key]));
                if (num(pp.medians?.[key]) !== null) percentages.push(num(pp.medians[key]));
            }
            // The tool also returns a bounded comparison set with the same
            // percentage measures for named peers. These values are evidence
            // from get_peer_context just like its company values and medians;
            // omitting them made a correctly sourced peer comparison fail
            // validation (measured on AMD: Intel -7.5%, Palantir 32.6%).
            for (const comp of Array.isArray(pp.comps) ? pp.comps : []) {
                for (const key of ['revCagr5Pct', 'netMarginPct', 'roePct', 'divYieldPct']) {
                    if (num(comp?.[key]) !== null) percentages.push(num(comp[key]));
                }
            }
            for (const key of ['premiumPct', 'repriceToMedianPct'])
                if (num(pp.multiples?.[key]) !== null) percentages.push(num(pp.multiples[key]));
        }
        // ProviderValuation margins and the dividend yield are decimals, and the
        // model restates them in percent — the shape every reader expects. Each
        // is unitless, so no currency question arises; the priced-off-a-share
        // multiples beside them are stated as "x" and are not validated here.
        const pv = r.providerValuation;
        if (pv && pv.fields) for (const key of ['dividendYield', 'profitMarginTtm', 'operatingMarginTtm', 'returnOnEquityTtm'])
            if (num(pv.fields[key]) !== null) percentages.push(num(pv.fields[key]) * 100);
        const rows = r.observations || [];
        for (const o of rows) {
            const f = o.fields || {};
            // R&D over revenue is the same contract as the three margins — two
            // filed lines from one observation, same currency — and the Context
            // column expresses it as an intensity. Measured on the AMD analyst
            // answer: 8,091/34,639 → "23% of revenue" was rejected, and the whole
            // answer fell back over a figure the tool results fully supply.
            for (const [top, bottom] of [['netIncome', 'totalRevenue'], ['grossProfit', 'totalRevenue'], ['operatingIncome', 'totalRevenue'], ['researchAndDevelopment', 'totalRevenue']]) {
                if (f[top]?.value != null && f[bottom]?.value > 0 && f[top].currency === f[bottom].currency)
                    percentages.push(f[top].value / f[bottom].value * 100);
            }
            const fcf = r.calculations?.find(c => c.periodEnd === o.periodEnd);
            if (fcf?.value != null && f.operatingCashflow?.value > 0) percentages.push(fcf.value / f.operatingCashflow.value * 100);
        }
        if (!/^annual/.test(r.basis || '')) continue; // quarters use dated comparisons only
        const sorted = rows.slice().sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
        for (let i = 0; i + 1 < sorted.length; i++) {
            const a = sorted[i], b = sorted[i + 1];
            const gap = (Date.parse(a.periodEnd) - Date.parse(b.periodEnd)) / 86400000;
            if (gap < 340 || gap > 380 || a.currency !== b.currency) continue;
            for (const key of Object.keys(a.fields || {})) {
                const x = a.fields[key], y = b.fields?.[key];
                if (x?.value == null || y?.value == null || x.unit !== y.unit || x.scope !== y.scope) continue;
                const magnitude = /capitalExpenditures|dividend|Repurchase/.test(key);
                const prev = magnitude ? Math.abs(y.value) : y.value;
                if (prev > 0) percentages.push(((magnitude ? Math.abs(x.value) : x.value) / prev - 1) * 100);
            }
            const x = r.calculations?.find(c => c.periodEnd === a.periodEnd), y = r.calculations?.find(c => c.periodEnd === b.periodEnd);
            if (x?.value != null && y?.value > 0) percentages.push((x.value / y.value - 1) * 100);
        }
    }
    return percentages;
}

function numericClaims(text, results, question = '') {
    const data = unwrap(results);
    const hasFinancialObservations = data.some(r => r.observations?.some(o => o.fields || o.metrics) || r.marketObservations?.length || r.peerPositioning);
    const financialResearchAttempted = (results || []).some(r => ['get_financials','get_ratios_history','get_supplemental_context','get_quote','get_peer_context'].includes(r.tool));
    const filingFacts = filingNarrativeEvidence(results);
    if (!financialResearchAttempted && !hasFinancialObservations && !filingFacts.length && !data.some(r=>r.supplementalObservations?.length || r.industryObservations?.length)) return [];
    const facts = chartEvidence(results);
    // Changes are explicit calculations from comparable verified annual inputs,
    // rather than invented facts. Retain signs except when prose names a drop.
    for (const r of data) {
        if (!/^annual/.test(r.basis || '')) continue;
        const rows = (r.observations || []).slice().sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
        for (let i = 0; i + 1 < rows.length; i++) {
            const a = rows[i], b = rows[i + 1], gap = (Date.parse(a.periodEnd) - Date.parse(b.periodEnd)) / 86400000;
            if (gap < 340 || gap > 380 || a.currency !== b.currency) continue;
            for (const [field, x] of Object.entries(a.fields || {})) {
                const y = b.fields?.[field];
                if (x.value == null || y?.value == null || x.unit !== y.unit || x.scope !== y.scope) continue;
                const magnitude = /capitalExpenditures|dividend|Repurchase/.test(field);
                facts.push({ value: magnitude ? Math.abs(x.value) - Math.abs(y.value) : x.value - y.value,
                    unit: x.unit, field, difference: true });
            }
            const x = r.calculations?.find(c => c.periodEnd === a.periodEnd), y = r.calculations?.find(c => c.periodEnd === b.periodEnd);
            if (x?.value != null && y?.value != null && x.currency === y.currency)
                facts.push({ value: x.value - y.value, unit: x.currency, field: 'freeCashflow', difference: true });
        }
    }
    // Quotes keep market dates and sources; they are not SEC observations.
    // The 52-week keys are the names get_quote actually returns (week52High,
    // week52Low) — this list asked for high52Week/low52Week, which no tool
    // returns, so a cited 52-week range was unclaimable on every answer. Both
    // spellings are kept: the aliases cost nothing and a rename in either place
    // must not silently stop a supplied figure from being usable.
    for (const r of data) if (r.priceAsOf || r.asOf) {
        for (const key of ['price', 'previousClose', 'lastClose', 'marketCap', 'high52Week', 'low52Week', 'week52High', 'week52Low', 'eps']) {
            if (num(r[key]) !== null) facts.push({ value: num(r[key]), unit: r.currency });
        }
    }
    // Reverse-DCF outputs: the tool is the sanctioned source for "what growth is
    // priced in", and it states its basis (the company's own filed cash-flow
    // CAGR). Its money figures are claimable here; its growth and upside
    // percentages are collected by percentageEvidence().
    for (const r of data) {
        const currency = String(r.currency || 'USD').toUpperCase();
        for (const key of ['marketCap', 'fcfBase']) if (num(r[key]) !== null) facts.push({ value: num(r[key]), unit: currency });
        if (num(r.scenarios?.currentMarketCap) !== null) facts.push({ value: num(r.scenarios.currentMarketCap), unit: currency });
    }
    // Provider gap-fill: a line the issuer's own facts cannot carry is supplied
    // by the provider block, and it is a number the model was handed — without
    // this, citing it read as an unsourced claim and triggered the rewrite that
    // the block exists to avoid. The currency is the filed row's, and cash
    // outflows keep the magnitude convention the block labels.
    for (const r of data) {
        const gaps = r.alternativeSources;
        if (!gaps || !gaps.fields || typeof gaps.fields !== 'object') continue;
        for (const [field, entries] of Object.entries(gaps.fields)) {
            if (!Array.isArray(entries)) continue;
            for (const e of entries) if (e && num(e.value) !== null)
                facts.push({ value: num(e.value), unit: unitName(String(e.currency || 'USD').toUpperCase()), field });
        }
    }
    // Calculator results, once the supplied facts are all in place — a money
    // calculation keeps its currency only when every input shared one.
    for (const c of calculatorClaims(results, facts)) if (c.unit) facts.push({ value: c.value, unit: c.unit, calculated: true });
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const issues = [];
    const currencies = { '$': 'USD', '¥': 'JPY', '€': 'EUR', '£': 'GBP' };
    for (const m of prose.matchAll(/(USD|JPY|EUR|GBP|CAD|AUD|CHF|CNY|TWD|HKD|SGD|NZD|INR|KRW|\$|¥|€|£)\s*([−–-]?\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million|tn|bn|[TtBbMmKk]\b)?/g)) {
        const unit = currencies[m[1]] || m[1], suffix = (m[3] || '').toLowerCase();
        const scale = /^(trillion|tn|t)$/.test(suffix) ? 1e12 : /^(billion|bn|b)$/.test(suffix) ? 1e9 : /^(million|m)$/.test(suffix) ? 1e6 : suffix === 'k' ? 1e3 : 1;
        const raw = m[2].replace(/,/g, '').replace(/[−–]/g, '-');
        const before = prose.slice(Math.max(0, m.index - 45), m.index);
        const context = before + prose.slice(m.index, m.index + m[0].length + 45);
        const after = prose.slice(m.index + m[0].length, m.index + m[0].length + 20);
        // A loss is usually written after its amount — "operating income $1,990m
        // (vs a $134m loss)" — and the before-the-number test alone read that as a
        // positive, so a filed operating loss was unclaimable and every answer
        // that named one failed. The trailing form is anchored, so a neighbouring
        // figure ("revenue of $5bn and a loss of $134m") is not dragged into the sign.
        // A dash that follows another figure is a range separator, not a sign:
        // "52-week range $188.22–$645.46" was read as −645.46, so the one figure a
        // clean normal-mode answer cites — the 52-week high get_quote supplies —
        // was unclaimable and a correct answer fell back. A dash is a sign only
        // when no digit sits immediately before it.
        const signDash = /([−–-])(?:\*\*)?$/.exec(before);
        const negative = (!!signDash && !/\d$/.test(before.slice(0, signDash.index))) ||
            /(?:negative\s+|loss of\s+|consumed\s+|used\s+|spent\s+|outflow of\s+)(?:\*\*)?$/.test(before) ||
            /^\s*(?:\*\*)?\s*(?:(?:an?|net|operating|net operating)\s+){0,2}(?:loss|deficit|shortfall)\b/i.test(after) ||
            /^\s*(?:\*\*)?\s*(?:net )?outflow\b/i.test(after);
        const value = Number(raw) * scale * (!raw.startsWith('-') && negative ? -1 : 1);
        const precision = raw.split('.')[1]?.length || 0;
        const tolerance = scale * 0.5 * Math.pow(10, -precision) + 1e-6;
        if (value === 1 && scale === 1 && /(?:every|each|per)\s*$/.test(prose.slice(Math.max(0, m.index - 20), m.index))) continue;
        const claimCategory = disclosureCategory(context);
        const sensitiveDisclosure = DISCLOSURE_TERMS.test(question) && !!disclosureCategory(context) &&
            (DISCLOSURE_TERMS.test(context) || /\b(?:lease|guarantee|commitment|purchase obligation)/i.test(context));
        if (!facts.some(f => (f.unit === unit || f.unit === unit + '/share') &&
            (Math.abs(f.value - value) <= tolerance ||
            ((/capitalExpenditures|dividend|Repurchase/.test(f.field || '') ||
                (f.difference && /fell|fall|drop|declin|decreas|lower/i.test(context)) ||
                (f.field === 'surplusAfterDistributions' && /short|deficit|more than|exceed|gap/i.test(context))) && Math.abs(Math.abs(f.value) - Math.abs(value)) <= tolerance)) &&
            (f.sourceType !== 'sec_filing_narrative' || !claimCategory || claimCategory === f.category) &&
            (!sensitiveDisclosure || (f.sourceType === 'sec_filing_narrative' && f.category === claimCategory))))
            // Every wording that offered a second option was taken as licence to
            // invent precision: "use the exact verified value" produced $14,181
            // million for a rejected $14.2bn, and "state it exactly as the tool
            // results give it" produced $1,176,299,062,416 for a rejected $1.18tn.
            // Deletion of the figure and of the sentence carrying it is the only
            // fix offered, because it is the only one that is always available.
            issues.push(`Monetary claim ${m[0]} is not a figure any tool result supplies. Delete this figure, and the sentence that depends on it — do not restate it at another precision and do not substitute a figure from memory.`);
    }
    const percentages = percentageEvidence(results, facts);
    // A computed figure is as often a percentage as an amount — a share of
    // revenue, a premium to a peer median — so the same gated results are
    // claimable on this channel too.
    for (const c of calculatorClaims(results, facts)) percentages.push(c.value);
    for (const m of prose.matchAll(/([+−–-]?\d+(?:\.\d+)?)\s*%/g)) {
        const raw = m[1].replace(/[−–]/g, '-');
        const before = prose.slice(Math.max(0, m.index - 40), m.index);
        const value = Number(raw) * (!/^[+-]/.test(raw) && /(?:down|fell|declined|decreased|drop(?:ped)?|decline|decrease|fall|slipped|shrank|lower|contracted|reduced)\s+(?:(?:by|about|around|roughly|approximately|nearly)\s+)?[~≈]?\s*$/i.test(before) ? -1 : 1);
        const tolerance = 0.5 * Math.pow(10, -(raw.split('.')[1]?.length || 0)) + 1e-8;
        if (!percentages.some(p => Math.abs(p - value) <= tolerance))
            issues.push(`Percentage claim ${m[0]} is not a supplied dated comparison or a compatible calculation. Delete this figure, and the sentence that depends on it — do not restate it at another precision and do not substitute a figure from memory.`);
    }
    return [...new Set(issues)];
}

function audit(text, results, { question = '', mode = 'analyst', policy } = {}) {
    policy = policy || require('./ask-report-policy').select(question, mode);
    const issues = [], facts = chartEvidence(results), data = unwrap(results);
    issues.push(...require('./ask-report-policy').reportIssues(text, policy, results));
    if (!/\b(hypothetical|suppose|assume)\b/i.test(question)) issues.push(...numericClaims(text, results, question));
    for(const r of data)for(const f of r.supplementalObservations || []) {
        if(!require('./company-observations').validSupplement(f,f.issuer))continue;
        const lines=String(text).replace(/```[\s\S]*?```/g,'').split(/\n/);
        lines.forEach((line,i)=>{
            if(metricForLabel(line)!==f.field)return;
            const values=[...line.matchAll(/(?<![\w.-])[-−]?\d[\d,]*(?:\.\d+)?/g)].map(m=>Number(m[0].replace(/,/g,'').replace('−','-')));
            if(!values.some(n=>[1,1e3,1e6,1e9,1e12].some(scale=>Math.abs(n-f.value/scale)<=0.000001)))return;
            const context=line.startsWith('|')?lines.slice(Math.max(0,i-3),i+2).join('\n'):line;
            if(f.sourceType!=='sec_filing' && /\b(?:SEC[- ]verified|verified SEC|SEC[- ]reported)\b/i.test(line) && !/\b(?:not|never|isn.t)\s+(?:SEC[- ]verified|verified SEC|SEC[- ]reported)/i.test(line))issues.push('Attributed supplemental observations must not be described as SEC-verified.');
            if(!context.includes(f.sourceName) || !context.includes(require('./company-observations').sourceDate(f)))issues.push('Supplemental financial values require their source name and date on the displayed line or labelled table.');
        });
    }
    const financial = facts.some(f => f.sourceIds?.length);
    const metricQuestions = /revenue/i.test(question) && /net (?:income|profit)|net profit/i.test(question) && /share.?based compensation|\bSBC\b/i.test(question);
    const chartMatches = [...text.matchAll(/```(viz|bars|sankey)\s*\n([\s\S]*?)```/g)];
    for (const match of chartMatches) {
        let spec;
        try { spec = JSON.parse(match[2]); } catch (_) { issues.push('Chart JSON is invalid.'); continue; }
        const unit = unitName(spec.unit);
        if (!/^(?:[A-Z]{3}(?:\/share)?|%|x|shares)$/.test(unit || '')) issues.push('Chart unit is missing or unsupported.');
        if (match[1] === 'sankey') {
            const verified = verifiedSegmentEvidence(results);
            if (verified.status !== 'eligible') {
                issues.push(`Sankey chart is unsupported: ${verified.reason}`);
                continue;
            }
            const close = (a, b) => num(a) !== null && Math.abs(num(a) - b) <= Math.max(1e-8, Math.abs(b) * 1e-10);
            if (unit !== verified.currency || spec.periodEnd !== verified.periodEnd || spec.filingDate !== verified.filingDate ||
                String(spec.accessionNumber || '').replace(/[^0-9]/g, '') !== String(verified.accessionNumber).replace(/[^0-9]/g, '') ||
                !close(spec.total, verified.totalRevenue) || !close(spec.unallocated, verified.unallocated))
                issues.push('Sankey total, currency, period, accession and unallocated flow must match the verified segment evidence exactly.');
            const supplied = Array.isArray(spec.segments) ? spec.segments : [];
            if (supplied.length !== verified.segments.length || supplied.some(s => {
                const exact = verified.segments.find(v => v.name === s.name);
                return !exact || !close(s.value, exact.value);
            })) issues.push('Sankey segment names and values must match the retrieved SEC segment evidence exactly.');
            if (spec.sourceUrl !== verified.sourceUrl) issues.push('Sankey filing URL must match the retrieved annual SEC filing.');
            continue;
        }
        let series;
        if (match[1] === 'viz') series = spec.series;
        else if (Array.isArray(spec.series)) {
            if (spec.orientation !== 'vertical') issues.push('Grouped financial bars must use vertical orientation and aligned fiscal periods.');
            series = spec.series;
            const categorySets = series.map(s => (s.points || []).map(p => p?.[0]));
            if (categorySets.length > 1 && categorySets.some(labels => JSON.stringify(labels) !== JSON.stringify(categorySets[0])))
                issues.push('Grouped bars must use the same fiscal-period labels for every metric.');
            const dates = categorySets[0] || [];
            if (dates.length > 1 && dates.every(label => /^\d{4}-\d{2}-\d{2}$/.test(label)) &&
                dates.some((date, i) => i > 0 && date < dates[i - 1]))
                issues.push('Grouped fiscal-period bars must run from oldest to newest from left to right.');
        } else {
            if (spec.orientation && spec.orientation !== 'horizontal') issues.push('Single-series category comparisons must use horizontal bars.');
            series = [{ name: '', points: spec.rows }];
        }
        if (!Array.isArray(series) || !series.length || series.length > 3) { issues.push('Chart series structure is invalid.'); continue; }
        const disclosurePeriods = new Set(),chartSources=new Set(),chartAccounting=new Set(),chartPeriods=new Set();
        for (const s of series) {
            const singlePeriodGroup = match[1] === 'bars' && Array.isArray(spec.series);
            if (!Array.isArray(s.points) || s.points.length < (singlePeriodGroup ? 1 : 2) || s.points.length > (match[1] === 'bars' ? 8 : 20)) {
                issues.push('Chart needs 2–20 time points or 2–8 category rows; one fiscal period may have grouped metric bars.'); continue;
            }
            const labels = new Set();
            for (const p of s.points) {
                if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'string' || labels.has(p[0])) {
                    issues.push('Chart points must have unique text labels and values.'); continue;
                }
                labels.add(p[0]);
                if (p[1] === null) continue; // gaps remain gaps
                const v = num(p[1]);
                if (v === null) { issues.push('Chart value is invalid.'); continue; }
                // Company financial charts must match an observation or explicit
                // calculation with the SAME unit. Cash outflow magnitudes may be
                // positive when labelled as expenditure/dividends/buybacks.
                if (financial) {
                    const label = String(p[0]) + ' ' + String(s.name || '');
                    const metric = metricForLabel(label);
                    const category = disclosureCategory(label);
                    const narrativeCategory = DISCLOSURE_TERMS.test(question) || facts.some(f => f.sourceType === 'sec_filing_narrative' && f.category === category)
                        ? category : null;
                    const magnitude = /capex|capital expend|dividend|buyback|repurchas/i.test(label);
                    const date = String(p[0]).match(/\d{4}-\d{2}-\d{2}/)?.[0];
                    if (narrativeCategory && !date) issues.push('Filing disclosure bars require an explicit dated label for each amount.');
                    if (narrativeCategory && date) disclosurePeriods.add(date);
                    const fiscalYear = String(p[0]).match(/\bFY\s*['’]?(20\d{2}|\d{2})\b/i)?.[1];
                    const periodMatches = f => date ? f.periodEnd === date
                        : fiscalYear ? f.periodEnd?.startsWith(fiscalYear.length === 2 ? '20' + fiscalYear : fiscalYear) : true;
                    const amountMatches = facts.filter(f => f.unit === unit &&
                        (!narrativeCategory || (f.sourceType === 'sec_filing_narrative' && f.category === narrativeCategory)) &&
                        (Math.abs(f.value - v) <= Math.max(1e-8, Math.abs(f.value) * 1e-10) ||
                        (magnitude && Math.abs(Math.abs(f.value) - v) <= Math.max(1e-8, Math.abs(f.value) * 1e-10))));
                    const metricMatches = amountMatches.filter(f => !metric || f.field === metric);
                    const matches = metricMatches.filter(periodMatches);
                    const compatible=matches.filter(f=>String(spec.title || '').includes('Yahoo Finance')?f.sourceName==='Yahoo Finance':f.sourceType!=='provider');
                    const chosen=compatible[0] || matches[0];
                    if(chosen){chartSources.add(chosen.sourceType || 'sec_filing');if(chosen.accountingBasis)chartAccounting.add(chosen.accountingBasis);if(chosen.basis && chosen.basis!=='instant')chartPeriods.add(chosen.basis);
                        if(chosen.sourceType==='provider' && (!String(spec.title || '').includes(chosen.sourceName) || !String(spec.title || '').includes(require('./company-observations').sourceDate(chosen))))issues.push('A supplemental financial chart must name its provider and data date in the visible chart title.');}
                    if (!matches.length && date && metricMatches.length)
                        issues.push('Chart date does not match the sourced financial period.');
                    else if (!matches.length && metric && amountMatches.length)
                        issues.push('Chart metric label does not match its sourced field.');
                    else if (!matches.length)
                        issues.push('A financial chart value has no exact supplied source in its declared unit. Use raw unscaled observations/calculations; do not use the millions table.');
                    if (singlePeriodGroup && !date)
                        issues.push('Grouped financial bars must label each category with its actual fiscal period-end date.');
                }
            }
            // A connecting line implies chronological movement. Categories
            // such as OCF, capex and FCF must instead use horizontal bars.
            if (match[1] === 'viz' && s.points.some(p => /^(?:operating cash flow|capex|capital expenditure|free cash flow)$/i.test(p?.[0] || '')))
                issues.push('Use bars for categories such as operating cash flow, capex and FCF; a line chart implies a time sequence.');
        }
        if(chartSources.size>1 || chartAccounting.size>1 || chartPeriods.size>1)issues.push('Use one compatible source, accounting basis and period definition throughout a financial chart; do not splice provider and filed observations.');
        // One shared axis cannot show a metric a fraction of the largest one's
        // size: AMD's annual revenue is 21x its share-based compensation, and its
        // FY2023 net income renders a few pixels tall. The facet panels are the
        // remedy, so name the ratio and the fix rather than only flagging it.
        if (match[1] === 'bars' && Array.isArray(spec.series)) {
            if (spec.facet !== undefined && spec.facet !== true)
                issues.push('The bars "facet" field takes only true; leave it out for a shared-axis chart.');
            if (spec.facet !== true) {
                const magnitudes = series.flatMap(s => (Array.isArray(s?.points) ? s.points : []).map(p => num(p?.[1])))
                    .filter(v => v !== null && v !== 0).map(Math.abs);
                const peak = magnitudes.length ? Math.max(...magnitudes) : 0;
                const base = magnitudes.length ? Math.min(...magnitudes) : 0;
                if (series.length > 1 && base > 0 && peak / base > 10)
                    issues.push(`These grouped metrics span ${(peak / base).toFixed(0)}x from smallest to largest, so the smaller ones are unreadable on a shared axis. Add "facet": true to the bars block — each metric then gets its own panel with its value printed — or compare metrics of similar size.`);
            }
        }
        // A line chart cannot facet, so the same spread is worse there and the
        // "facet" field is silently ignored: measured live, the model wrote a viz
        // chart with "facet": true for AMD revenue against net income (40x apart)
        // and the phone render drew net income as a flat line at the baseline.
        // The remedy is the one fence that can facet.
        if (match[1] === 'viz' && Array.isArray(spec.series)) {
            const magnitudes = series.flatMap(s => (Array.isArray(s?.points) ? s.points : []).map(p => num(p?.[1])))
                .filter(v => v !== null && v !== 0).map(Math.abs);
            const peak = magnitudes.length ? Math.max(...magnitudes) : 0;
            const base = magnitudes.length ? Math.min(...magnitudes) : 0;
            if (spec.facet !== undefined)
                issues.push('A viz chart cannot facet — the "facet" field is ignored and every series shares one axis. Use a bars block with "facet": true instead.');
            else if (series.length > 1 && base > 0 && peak / base > 10)
                issues.push(`These charted metrics span ${(peak / base).toFixed(0)}x from smallest to largest, so the smaller ones are unreadable on a shared axis. Use a faceted bars block ("bars" with "facet": true) instead of a line chart, or plot metrics of similar size.`);
        }
        if (disclosurePeriods.size > 1) issues.push('Horizontal filing disclosure bars must compare amounts from the same disclosed date.');
    }
    if (String(text).length > require('./ask-report-policy').ANSWER_MAX_CHARS) issues.push('The answer exceeds the 32000-character storage and history ceiling. Remove repeated detail and duplicated chart metadata while preserving the supported report.');
    if (chartMatches.length && /```viz/.test(text) && !/```bars/.test(text) && /each bar|the bars|bar chart/i.test(text.replace(/```[\s\S]*?```/g, '')))
        issues.push('The supplied viz renders as a line chart. Describe its lines/points accurately, or use a bars block for a category comparison.');
    if (metricQuestions && groupedFinancialBars(data, question)) {
        const bar = chartMatches.find(m => m[1] === 'bars');
        if (!bar) issues.push('A revenue, net income and share-based compensation comparison needs a grouped bars chart when compatible annual observations are available.');
        else {
            try {
                const spec = JSON.parse(bar[2]);
                const metrics = new Set((spec.series || []).map(s => metricForLabel(s.name)).filter(Boolean));
                if (!['totalRevenue', 'netIncome', 'shareBasedCompensation'].every(field => metrics.has(field)))
                    issues.push('The grouped chart must include revenue, net income and share-based compensation as separately labelled series.');
                const oneYear = requestedPeriodCount(question) === 1 || /\b(?:FY\s*20\d{2}|20\d{2})\b/i.test(question);
                if (Array.isArray(spec.series) && !oneYear && spec.series.some(s => (s.points || []).length < 2))
                    issues.push('Show at least two compatible annual periods when no single fiscal year was requested.');
            } catch (_) { /* chart JSON error is already reported above */ }
        }
    }
    if (/```(?:viz|bars|sankey)[\s\S]*$/.test(text.replace(/```(?:viz|bars|sankey)\s*\n[\s\S]*?```/g, '')))
        issues.push('Chart fence is incomplete.');

    if (ENTITY_DISCLOSURE_TERMS.test(text)) {
        const filingPages = results.map(r => ({ tool: r.tool, result: r.result || r }))
            .filter(r => r.tool === 'fetch_page' && /sec\.gov/i.test(String(r.result.url || '')) && String(r.result.text || '').trim());
        const retrievedNarrative = filingPages.some(({ result }) => /(?:SPV|SPE|special purpose (?:vehicle|entity)|unconsolidated|variable interest|off[- ]balance[- ]sheet)/i.test(result.text));
        if (!retrievedNarrative) issues.push('Claims about SPVs, unconsolidated entities or off-balance-sheet treatment require retrieved text from the issuer’s SEC filing.');
        if (/\b(?:to (?:get|keep|move|hide)|in order to (?:get|keep|move|hide))\b.{0,55}\b(?:off (?:the )?books|off[- ]balance[- ]sheet)\b/i.test(text))
            issues.push('Do not infer an intent to move debt off the books; describe the filing’s accounting treatment and disclosed obligation precisely.');
    }
    if (DISCLOSURE_TERMS.test(text) && /\b(?:lease|commitment|guarantee|purchase obligation)s?\b/i.test(text) && /\bdebt\b/i.test(text) && !/distinct|separate|not (?:the same as|classified as)|not all debt/i.test(text))
        issues.push('Distinguish leases, commitments and guarantees from reported debt; do not add them together as debt without a filing-supported reconciliation.');
    if (DISCLOSURE_TERMS.test(question)) {
        if (!issuerDisclosureEvidence(results, question) && !/SEC filing research is unavailable for this request\./.test(text))
            issues.push('This SPV/off-balance-sheet question needs a searched SEC filing and fetched text from that exact filing before it can be answered as issuer-specific research.');
    }

    const paragraphs = text.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/);
    for (const r of data) {
        for (const p of paragraphs) {
            if (r.coverage?.perShareAllowed === false && /EPS|per.share/i.test(p) &&
                /(?:not populated|absent|not reported|not disclosed|missing).*(?:XBRL|filing)/i.test(p) &&
                !/basis|share.class|ADR/i.test(p))
                issues.push('Explain suppressed EPS using the unverified security/ADR basis, not absence from the issuer filing.');
        }
        const checks = r.capitalReturns || (r.statement === 'cash' ? (r.observations || []).map(o => {
            const row = { fiscalDateEnding: o.periodEnd, periodStart: o.periodStart, reportedCurrency: o.currency, _sources: {}, _scopes: {} };
            for (const [field, f] of Object.entries(o.fields || {})) { row[field] = f.value; row._sources[field] = f.sourceIds; row._scopes[field] = f.scope; }
            return capitalReturns(row);
        }) : []);
        for (const p of paragraphs) {
            if (!/free cash|\bFCF\b/i.test(p) || !/dividend/i.test(p) || !/buyback|repurchas/i.test(p)) continue;
            const year = p.match(/\bFY\s*(20\d{2})\b/i)?.[1];
            const c = year ? checks.find(c => c.periodEnd?.startsWith(year)) : checks[0];
            if (!c || c.coveredByFreeCashflow === null) continue;
            const positive = /(?:cover(?:s|ed)?|fund(?:s|ed)?|sufficient|enough to)/i.test(p);
            const negative = /(?:does(?:n't| not)|did(?:n't| not)|cannot|can't|not enough|not sufficient|insufficient|shortfall|exceed(?:s|ed)?|fell short|less than)/i.test(p);
            if (positive && !negative && !c.coveredByFreeCashflow)
                issues.push(`For ${r.symbol} ${c.periodEnd}, FCF ${c.freeCashflow} ${c.currency} is below combined dividends/buybacks ${c.totalDistributions}; shortfall ${-c.surplusAfterDistributions}. It cannot cover them.`);
        }
    }
    const narrative = results.some(r => /^(?:fetch_page|search_filings|get_key_points|get_filing_diff)$/.test(r.tool || '') && !r.result?.error);
    if (!narrative && /(?:likely|driven|due|tied|because|reflects|from|fuelled|fueled)[^.!?\n]{0,80}(?:AI[\s/-]+(?:investment|infrastructure)|AI\/data|data[ -]cent(?:re|er)|one.off)/i.test(text))
        issues.push('Do not attribute a financial change to investment or one-offs without supporting retrieved narrative. Describe the observed change or state the cause is not established.');
    if (!narrative && /(?:funded|financed|covered|paid for)[^.!?\n]{0,70}(?:cash reserves|cash balances|debt issuance|borrowing|existing cash)/i.test(text))
        issues.push('A cash-coverage shortfall does not establish its financing source. Omit assertions about reserves or debt issuance unless separately sourced.');
    const limit = policy.maxWords;
    // The model overshoots a bare "over the limit" by a few words and the rewrite
    // pass barely trims (measured: 509 → 498 against a 480 cap, 339 → 330 against
    // 320). Naming the count and the size of the cut makes the instruction
    // actionable rather than a judgement call.
    // The model lands within a few percent of whatever cap it is given, and the
    // rewrite pass barely trims (measured: 331 → 329 against a 320 cap; 481
    // against 480). A hard boundary turns a complete, fully sourced answer into
    // the generic receipt over one word — twice in six probes. The published cap
    // stays the number the prompt quotes and the target the model aims at; the
    // audit allows 5% of jitter above it before an answer is rejected for length.
    const ceiling = policy.ceiling;
    const words = wordCount(text);
    if (words > ceiling) issues.push(`Answer is ${words} prose words, ${words - limit} over the ${limit}-word limit. Cut at least ${words - limit} words: delete whole sentences, starting with repeated figures and unrequested history — never drop a sourced figure, a missing-data reason or the Next line to get there.`);
    // Table rows are excluded from the prose budget above, so bound them here.
    const tableRows = (String(text).match(/^\s*\|.*$/gm) || []).length;
    if (tableRows > policy.tableRows) issues.push(`Answer has ${tableRows} table rows. Keep tables to the metrics, periods and context columns actually requested.`);
    return [...new Set(issues)];
}

function requestedPeriodCount(question) {
    const word = String(question || '').match(/\b(?:latest|last|past|previous|over the last)?\s*(\d+|one|two|three|four|five|six|seven|eight)\s+(?:stored\s+)?(?:SEC[- ]reported\s+)?(?:annual\s+)?(?:fiscal\s+)?(?:periods?|years?)\b/i)?.[1];
    if (!word && /\b(?:latest|last|most recent)(?: stored)? annual (?:period|year)\b/i.test(question)) return 1;
    if (!word) return null;
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
    return Math.max(1, Math.min(8, Number(words[word.toLowerCase()] || word)));
}

function groupedFinancialBars(data, question) {
    const annual = data.filter(r => /^annual/.test(r.basis || '') && ['income', 'cash'].includes(r.statement));
    const income = annual.find(r => r.statement === 'income'), cash = annual.find(r => r.statement === 'cash');
    if (!income) return null;
    const unit = String(income.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(unit)) return null;
    const compatibleCash = cash && income.symbol === cash.symbol && String(cash.currency || '').toUpperCase() === unit ? cash : { observations: [] };
    const fields = [
        ['totalRevenue', 'Revenue', income],
        ['netIncome', 'Net income', income],
        ['shareBasedCompensation', 'Share-based compensation', compatibleCash]
    ];
    const observations = fields.map(([, , result]) => new Map((result.observations || []).map(o => [o.periodEnd, o])));
    const count = requestedPeriodCount(question) || 3;
    const explicitYear = String(question || '').match(/\b(?:FY\s*)?(20\d{2})\b/i)?.[1];
    let periods = [...new Set(observations.flatMap(rows => [...rows.keys()]))]
        .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p) && (!explicitYear || p.startsWith(explicitYear)))
        .sort((a, b) => b.localeCompare(a)).slice(0, explicitYear ? 1 : count).reverse();
    if (!periods.length || (!explicitYear && count !== 1 && periods.length < 2)) return null;
    const series = fields.map(([field, name], i) => ({
        name,
        points: periods.map(period => {
            const observation = observations[i].get(period), fact = observation?.fields?.[field];
            const compatible = fact && unitName(fact.unit || observation.currency) === unit && (!observation.currency || observation.currency === unit);
            return [period, compatible && num(fact.value) !== null && fact.sourceIds?.length ? num(fact.value) : null];
        })
    }));
    if (!series.some(s => s.points.some(p => p[1] !== null))) return null;
    const missing = series.flatMap(s => {
        const periods = s.points.filter(([, value]) => value === null).map(([period]) => period);
        return periods.length ? [{ metric: s.name, periods }] : [];
    });
    // Faceted when the spread warrants it, by the same 10x rule audit() applies.
    // A receipt is the guaranteed-valid terminal state, so it must never itself be
    // an answer its own audit rejects — and revenue beside SBC is always wide.
    const magnitudes = series.flatMap(s => s.points.map(p => p[1])).filter(v => v !== null && v !== 0).map(Math.abs);
    const spread = magnitudes.length ? Math.max(...magnitudes) / Math.min(...magnitudes) : 1;
    return {
        symbol: income.symbol,
        periodCount: periods.length,
        requestedCount: explicitYear ? 1 : count,
        missing,
        spec: { title: `${income.symbol} · Revenue, net income and share-based compensation`, unit,
            orientation: 'vertical', ...(spread > 10 ? { facet: true } : {}), series }
    };
}

// If one bounded rewrite still fails validation, publish a factual receipt
// rather than the rejected generated conclusions. No narrative is invented.
function fallback(results, question = '') {
    const data = unwrap(results), sections = new Map();
    const hasFiled=data.some(r=>r.observations?.length);
    const lines = [hasFiled?'This is a partial answer using verified SEC evidence. Unverified figures are omitted.':'This is a partial answer using attributed financial evidence. Sources and dates are retained.'];
    const wantsRevenueProfitSbc = /revenue/i.test(question) && /net (?:income|profit)|net profit/i.test(question) && /share.?based compensation|\bSBC\b/i.test(question);
    const grouped = wantsRevenueProfitSbc ? groupedFinancialBars(data, question) : null;
    if (grouped) {
        lines.push(`\n**${grouped.symbol} — verified annual facts, reported in ${grouped.spec.unit}.**`);
        if (grouped.periodCount < grouped.requestedCount)
            lines.push(`Only ${grouped.periodCount} comparable annual periods have the requested sourced values; older periods are omitted.`);
        lines.push('Each bar comes from the matching annual SEC observations.');
        for (const gap of grouped.missing) lines.push(`${gap.metric} is unavailable for ${gap.periods.join(', ')}; missing values are shown as gaps, not zero.`);
        lines.push('```bars\n' + JSON.stringify(grouped.spec) + '\n```');
        appendSegmentSankey(lines, results, question);
        const errors = new Set();
        for (const { tool, result } of results) if (result?.error) {
            if (tool === 'get_segments') continue; // its specific gap is stated by appendSegmentSankey
            if (result.code === 'UNSUPPORTED_SECURITY_TYPE' && result.symbol && result.securityType)
                errors.add(`${result.symbol} is a ${result.securityType}. Company financial analysis is unavailable for this instrument.`);
            else if (result.code === 'VERIFIED_FINANCIALS_UNAVAILABLE') errors.add('Some requested company figures have no verified financial data available.');
            else errors.add('Some requested research was unavailable.');
        }
        for (const error of errors) lines.push('\n' + error);
        appendDisclosureSummary(lines, results, question);
        return lines.join('\n');
    }
    const requested = [
        ['totalRevenue', 'Revenue', /revenue|sales/i], ['netIncome', 'Net income', /income|profit|earnings/i],
        ['shareBasedCompensation', 'Share-based compensation', /share.?based compensation|\bSBC\b/i],
        ['operatingCashflow', 'Operating cash flow', /cash|FCF/i], ['capitalExpenditures', 'Capex', /capex|capital expend|cash|FCF/i],
        ['dividendPayout', 'Dividend cash outflow', /dividend|distribution/i],
        ['paymentsForRepurchaseOfCommonStock', 'Buyback cash outflow', /buyback|repurchas|distribution/i]
    ].filter(([, , re]) => re.test(question));
    const fields = requested.length ? requested : [['totalRevenue', 'Revenue'], ['netIncome', 'Net income']];
    const fmt = (value, currency) => {
        const v = num(value);
        if (v === null) return 'Unavailable';
        const magnitude = Math.abs(v), scale = magnitude >= 1e12 ? 1e12 : magnitude >= 1e9 ? 1e9 : magnitude >= 1e6 ? 1e6 : 1;
        const suffix = scale === 1e12 ? 'tn' : scale === 1e9 ? 'bn' : scale === 1e6 ? 'm' : '';
        return currency + ' ' + (v / scale).toLocaleString('en-US', { maximumFractionDigits: scale === 1 ? 2 : 3 }) + suffix;
    };
    const labels = { ready: 'Verified core financial data', partial: 'Partial financial coverage',
        historical_only: 'Historical data; current annual reporting is not verified', unavailable: 'Verified financial data unavailable' };
    const periods = requestedPeriodCount(question) || (/two|compare|prior|previous|trend|years|history/i.test(question) ? 2 : 1);
    for (const r of data.slice(0, 4)) {
        if (!r.observations?.length) {
            if (num(r.price) !== null) lines.push(`\n**${r.symbol}** — stored price ${fmt(r.price, r.currency)} as of ${r.priceAsOf || r.asOf || 'an unspecified date'}.`);
            continue;
        }
        for (const o of r.observations.slice(0, periods)) {
            const key = r.symbol + ':' + o.periodEnd;
            if (!sections.has(key)) sections.set(key, { symbol: r.symbol, period: o.periodEnd, currency: o.currency,
                coverage: labels[r.coverage?.financialCoverage] || 'Verified stored observations', values: new Map() });
            const section = sections.get(key);
            // Observations are not all statement observations: get_ratios_history
            // returns {periodEnd, currency, metrics} with no fields at all, and
            // `field in undefined` threw — which turned an audit failure into a
            // failed question, because the receipt builder ran inside the catch.
            for (const [field, label] of fields) if (o.fields && field in o.fields &&
                (r.statement === 'cash' ? /operatingCashflow|capitalExpenditures|dividendPayout|paymentsForRepurchaseOfCommonStock|shareBasedCompensation/.test(field) : r.statement === 'income' ? /totalRevenue|netIncome/.test(field) : true)) {
                const fact = o.fields[field];
                section.values.set(label, fmt(fact.value, o.currency) + (fact.value === null && fact.missingReason ? ' — ' + fact.missingReason.replace(/\.$/, '') : ''));
            }
            if (r.statement === 'cash' && /free cash|\bFCF\b/i.test(question)) {
                const f = r.calculations?.find(c => c.periodEnd === o.periodEnd);
                section.values.set('Free cash flow (OCF minus capex magnitude)', fmt(f?.value, o.currency));
            }
            if (r.statement === 'cash' && /dividend|buyback|repurchas|distribution/i.test(question)) {
                const c = r.capitalReturns?.find(c => c.periodEnd === o.periodEnd);
                section.values.set('Combined dividends and buybacks', fmt(c?.totalDistributions, o.currency));
                section.values.set('FCF coverage', c?.coveredByFreeCashflow == null ? 'Unavailable' : c.coveredByFreeCashflow
                    ? 'Covered by free cash flow' : 'Not covered; shortfall ' + fmt(-c.surplusAfterDistributions, o.currency));
            }
        }
    }
    const supplementalSeen=new Set();
    for(const r of data.slice(0,4)) {
        const selected=(r.supplementalObservations || []).filter(f=>f.state==='available' && require('./company-observations').validSupplement(f,f.issuer) && fields.some(([field])=>field===f.field)).sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd));
        const dates=[...new Set(selected.map(f=>f.periodEnd))].slice(0,periods),rows=[];
        for(const f of selected.filter(f=>dates.includes(f.periodEnd))){const key=require('./company-observations').key(f);if(supplementalSeen.has(key))continue;supplementalSeen.add(key);const label=fields.find(([field])=>field===f.field)?.[1] || f.definition;rows.push('| '+label+' | '+f.periodEnd+' | '+f.currency+' '+String(f.value)+' | '+f.sourceName+' '+require('./company-observations').sourceDate(f)+' | '+f.accountingBasis+' |');}
        if(rows.length)lines.push('\n**'+(r.symbol || 'Company')+' — additional attributed financial observations**','| Field | Period end | Value and currency | Source and date | Accounting basis |','| --- | --- | --- | --- | --- |',...rows.slice(0,20));
    }
    for (const section of sections.values()) {
        if (!section.values.size) continue;
        lines.push(`\n**${section.symbol} — period ended ${section.period} (${section.currency})**`, section.coverage + '.');
        for (const [label, value] of section.values) lines.push(`- ${label}: ${value}.`);
    }
    appendSegmentSankey(lines, results, question);
    const errors = new Set();
    for (const { result } of results) if (result?.error) {
        if (result.code === 'UNSUPPORTED_SECURITY_TYPE' && result.symbol && result.securityType)
            errors.add(`${result.symbol} is a ${result.securityType}. Company financial analysis is unavailable for this instrument.`);
        else if (result.code === 'VERIFIED_FINANCIALS_UNAVAILABLE') errors.add('Some requested company figures have no verified financial data available.');
        else errors.add('Some requested research was unavailable.');
    }
    for (const error of errors) lines.push('\n' + error);
    appendDisclosureSummary(lines, results, question);
    return lines.join('\n');
}

function appendDisclosureSummary(lines, results, question) {
    if (!DISCLOSURE_TERMS.test(question)) return;
    if (!issuerDisclosureEvidence(results, question)) {
        lines.push('\nSEC filing research is unavailable for this request. No issuer-specific conclusion or exposure amount can be verified from the retrieved evidence.');
        return;
    }
    const candidates = results.filter(r => r.tool === 'search_filings').flatMap(r => (r.result || {}).results || []);
    const candidateUrls = new Set(candidates.map(r => r.url).filter(Boolean));
    const page = results.map(r => ({ tool: r.tool, result: r.result || r }))
        .find(r => r.tool === 'fetch_page' && candidateUrls.has(r.result.url) && !r.result?.error &&
            !/keyword\s+["“].*?["”]\s+not found/i.test(String(r.result.note || '')) &&
            requestedDisclosureText(r.result.text, question));
    if (!page) {
        lines.push('\nSEC filing candidates were available, but the fetched excerpts do not contain verifiable text for the requested disclosure. That does not establish that no such disclosure exists elsewhere in the filing.');
        return;
    }
    const hit = candidates.find(r => r.url === page.result.url) || {};
    const filed = hit.filed ? ` filed ${hit.filed}` : '';
    const form = hit.form || 'SEC filing';
    const amounts = filingNarrativeEvidence(results).filter(f => f.filingUrl === page.result.url);
    const names = {
        lease_obligation: 'Lease obligations', guarantee: 'Guarantees', commitment: 'Contractual commitments',
        reported_debt: 'Debt-related amounts', entity_or_securitization_exposure: 'Unconsolidated-entity or securitization exposure'
    };
    const displayName = f => f.category === 'lease_obligation' && /not yet commenced/i.test(f.context || '')
        ? 'Leases not yet commenced'
        : f.category === 'lease_obligation' && /lease liabilities/i.test(f.context || '')
            ? 'Reported lease liabilities'
        : f.category === 'entity_or_securitization_exposure' && /\bother VIEs?\b/i.test(f.context || '')
        ? 'Other VIE maximum exposure to loss'
        : f.category === 'entity_or_securitization_exposure' && /\bthe Venture\b/i.test(f.context || '')
            ? 'Venture maximum exposure to loss'
            : names[f.category] || 'disclosed amount';
    lines.push(`\n**Filing disclosure check:** Retrieved text from the issuer’s ${form}${filed}. This confirms only the disclosure language in that excerpt; it does not establish intent to conceal debt.`);
    const periodAmounts = amounts.filter(f => validCalendarDate(f.periodEnd));
    const unique = [...new Map(periodAmounts.map(f => [`${f.category}:${f.unit}:${f.periodEnd}:${f.value}`, f])).values()].slice(0, 5);
    if (unique.length) {
        if (ENTITY_DISCLOSURE_TERMS.test(question) && !unique.some(f => f.category === 'entity_or_securitization_exposure'))
            lines.push('The retrieved excerpt does not quantify a separate unconsolidated-entity or securitization exposure.');
        const comparable = unique.filter(f => f.unit === unique[0].unit && f.periodEnd === unique[0].periodEnd);
        // A category can contain distinct measures (lease liabilities versus
        // uncommenced leases, for example). Do not silently select one of them
        // when the available excerpt cannot distinguish the chart labels.
        const chartFacts = comparable.filter(f => comparable.filter(x => displayName(x) === displayName(f)).length === 1);
        const rows = chartFacts.map(f => [`${displayName(f)} · as of ${f.periodEnd}`, f.value]);
        const plotted = rows.length >= 2 ? new Set(chartFacts) : new Set();
        lines.push(...unique.filter(f => !plotted.has(f)).map(f => `- ${displayName(f)} as of ${f.periodEnd}: ${f.unit} ${formatDisclosureAmount(f.value)} in the retrieved filing text. ${f.category === 'reported_debt'
            ? 'This is a reported debt-related amount; it is not added to the separately disclosed obligations.'
            : 'This separate disclosure is not added to reported debt or the other obligations.'}`));
        if (rows.length < comparable.length) lines.push('Several separately disclosed amounts share a category label. They are listed separately above and omitted from the chart because their scopes cannot be compared reliably.');
        if (rows.length >= 2) lines.push(`\n\`\`\`bars\n${JSON.stringify({ title: `Separately disclosed amounts · not summed · ${form} filed ${hit.filed || 'date unavailable'}`, unit: unique[0].unit, orientation: 'horizontal', rows })}\n\`\`\``);
    } else {
        lines.push(amounts.length
            ? 'The retrieved excerpt contains amounts, but no standalone amount has an explicit matching period, so I have not quantified this exposure. This does not prove that no such amount appears elsewhere in the full filing.'
            : 'The retrieved excerpt contains relevant filing language but no standalone amount that can be verified for this exposure. This does not prove that no such amount appears elsewhere in the full filing.');
    }
    const mentionRules = [
        ['lease_obligation', /\blease(?:s|d|ing)?\b/i], ['guarantee', /\bguarantee/i],
        ['commitment', /\b(?:purchase|contractual|capital)\s+commitment|\bpurchase\s+obligation/i],
        ['entity_or_securitization_exposure', /\b(?:SPV|SPE|special purpose|unconsolidated|variable interest|VIE|securitiz)\w*\b|\bexposure to loss\b/i]
    ];
    const mentions = new Set();
    for (const row of results) {
        const result = row.result || row;
        if (row.tool !== 'fetch_page' || result.url !== page.result.url || result.error ||
            /keyword\s+["“].*?["”]\s+not found/i.test(String(result.note || ''))) continue;
        for (const [category, pattern] of mentionRules) if (pattern.test(result.text || '')) mentions.add(category);
    }
    const quantified = new Set(unique.map(f => f.category));
    for (const category of mentions) if (!quantified.has(category)) {
        lines.push(`- ${names[category]} are mentioned in the retrieved excerpt, but I could not verify an amount with its own explicit scale, currency and period. This does not establish that the full filing contains no such amount.`);
    }
}

function formatDisclosureAmount(value) {
    const n = num(value);
    if (n === null) return 'unavailable';
    const magnitude = Math.abs(n), scale = magnitude >= 1e12 ? 1e12 : magnitude >= 1e9 ? 1e9 : magnitude >= 1e6 ? 1e6 : 1;
    const suffix = scale === 1e12 ? 'tn' : scale === 1e9 ? 'bn' : scale === 1e6 ? 'm' : '';
    return `${(n / scale).toLocaleString('en-US', { maximumFractionDigits: scale === 1 ? 2 : 3 })}${suffix}`;
}

function appendSegmentSankey(lines, results, question) {
    if (!/\b(?:segment|business mix|where (?:does|do) (?:the )?revenue come from)\b/i.test(question)) return;
    const evidence = verifiedSegmentEvidence(results);
    if (evidence.status === 'eligible') {
        const issuer = results.find(r => r.tool === 'get_segments')?.result?.symbol || 'Issuer';
        const spec = {
            title: 'Revenue by business segment', unit: evidence.currency, periodEnd: evidence.periodEnd,
            filingDate: evidence.filingDate, accessionNumber: evidence.accessionNumber,
            sourceUrl: evidence.sourceUrl, total: evidence.totalRevenue, unallocated: evidence.unallocated,
            segments: evidence.segments.map(({ name, value }) => ({ name, value }))
        };
        lines.push(`\n**${issuer} — filed segment revenue, ${evidence.currency}, period ended ${evidence.periodEnd}.**`);
        lines.push('```sankey\n' + JSON.stringify(spec) + '\n```');
    } else if (results.some(r => r.tool === 'get_segments')) {
        lines.push(`\nA complete segment revenue flow could not be verified: ${evidence.reason}`);
    }
}

module.exports = { audit, chartEvidence, normalizeFacetedViz, numericClaims, wordCount, wordLimit, fallback, segmentEvidence, verifiedSegmentEvidence, filingNarrativeEvidence, disclosureCategory, issuerDisclosureEvidence, appendDisclosureSummary };
