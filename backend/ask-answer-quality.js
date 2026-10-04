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

function wordCount(text) {
    return String(text).replace(/```[\s\S]*?```/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim().split(/\s+/).filter(Boolean).length;
}
function wordLimit(question, mode) {
    const explicit = question.match(/(?:under|at most|maximum(?: of)?|no more than|within|keep it (?:to|below))\s+(\d+)\s+words/i);
    if (explicit) return Math.min(Math.max(Number(explicit[1]), 40), 2000);
    if (/\b(detailed|comprehensive|in.depth|deep dive|exhaustive)\b/i.test(question)) return mode === 'normal' ? 550 : 800;
    return mode === 'normal' ? 250 : 350;
}

function chartEvidence(results) {
    const out = [];
    function visit(value, currency, field, periodEnd) {
        if (!value || typeof value !== 'object') return;
        currency = value.currency || currency;
        periodEnd = value.periodEnd || periodEnd;
        if (num(value.value) !== null && value.sourceIds?.length) {
            const name = value.formula === 'operatingCashflow - abs(capitalExpenditures)' ? 'freeCashflow' : field;
            const unit = value.unit || (/Pct$/.test(field || '') ? '%' : /^(currentRatio|debtToEquity|ocfToNetIncome)$/.test(field || '') ? 'x' : field === 'sharesOutM' ? 'million_shares' : currency);
            out.push({ value: num(value.value), unit: unitName(unit),
                field: name, periodEnd, sourceIds: value.sourceIds });
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
            if (['provenance', 'sources', 'coverage', 'inputs', 'sourceIds'].includes(key)) continue;
            const nextField = /^(current|previous)$/.test(key) ? field : key;
            if (Array.isArray(item)) for (const child of item) visit(child, currency, nextField, periodEnd);
            else if (item && typeof item === 'object') visit(item, currency, nextField, periodEnd);
        }
    }
    for (const result of unwrap(results)) visit(result, result.currency, null, null);
    out.push(...filingNarrativeEvidence(results));
    return out;
}

function metricForLabel(label) {
    const s = String(label || '');
    return /share.?based compensation|\bSBC\b/i.test(s) ? 'shareBasedCompensation'
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

function percentageEvidence(results) {
    const percentages = chartEvidence(results).filter(f => f.unit === '%').map(f => f.value);
    for (const r of unwrap(results)) {
        for (const c of r.capitalReturns || []) if (num(c.shortfallPctOfFreeCashflow) !== null)
            percentages.push(c.shortfallPctOfFreeCashflow);
        const rows = r.observations || [];
        for (const o of rows) {
            const f = o.fields || {};
            for (const [top, bottom] of [['netIncome', 'totalRevenue'], ['grossProfit', 'totalRevenue'], ['operatingIncome', 'totalRevenue']]) {
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
    const hasFinancialObservations = data.some(r => r.observations?.some(o => o.fields));
    const filingFacts = filingNarrativeEvidence(results);
    if (!hasFinancialObservations && !filingFacts.length) return [];
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
    for (const r of data) if (r.priceAsOf || r.asOf) {
        for (const key of ['price', 'previousClose', 'marketCap', 'high52Week', 'low52Week', 'eps']) {
            if (num(r[key]) !== null) facts.push({ value: num(r[key]), unit: r.currency });
        }
    }
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const issues = [];
    const currencies = { '$': 'USD', '¥': 'JPY', '€': 'EUR', '£': 'GBP' };
    for (const m of prose.matchAll(/(USD|JPY|EUR|GBP|CAD|AUD|CHF|CNY|\$|¥|€|£)\s*([−–-]?\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million|tn|bn|[TtBbMmKk]\b)?/g)) {
        const unit = currencies[m[1]] || m[1], suffix = (m[3] || '').toLowerCase();
        const scale = /^(trillion|tn|t)$/.test(suffix) ? 1e12 : /^(billion|bn|b)$/.test(suffix) ? 1e9 : /^(million|m)$/.test(suffix) ? 1e6 : suffix === 'k' ? 1e3 : 1;
        const raw = m[2].replace(/,/g, '').replace(/[−–]/g, '-');
        const before = prose.slice(Math.max(0, m.index - 45), m.index);
        const context = before + prose.slice(m.index, m.index + m[0].length + 45);
        const after = prose.slice(m.index + m[0].length, m.index + m[0].length + 20);
        const negative = /(?:[−–-]|negative\s+|loss of\s+|consumed\s+|used\s+|spent\s+|outflow of\s+)(?:\*\*)?$/.test(before) || /^\s*(?:\*\*)?\s*(?:net )?outflow\b/i.test(after);
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
            issues.push(`Monetary claim ${m[0]} does not match supplied facts/calculations at its displayed currency and precision. Omit it or use the exact verified value.`);
    }
    const percentages = percentageEvidence(results);
    for (const m of prose.matchAll(/([+−–-]?\d+(?:\.\d+)?)\s*%/g)) {
        const raw = m[1].replace(/[−–]/g, '-');
        const before = prose.slice(Math.max(0, m.index - 40), m.index);
        const value = Number(raw) * (!/^[+-]/.test(raw) && /(?:down|fell|declined|decreased|drop(?:ped)?|decline|decrease|fall|slipped|shrank|lower|contracted|reduced)\s+(?:(?:by|about|around|roughly|approximately|nearly)\s+)?[~≈]?\s*$/i.test(before) ? -1 : 1);
        const tolerance = 0.5 * Math.pow(10, -(raw.split('.')[1]?.length || 0)) + 1e-8;
        if (!percentages.some(p => Math.abs(p - value) <= tolerance))
            issues.push(`Percentage claim ${m[0]} does not match the verified dated comparison or a compatible calculation at its stated precision. Use supplied comparisons or verified ratio inputs.`);
    }
    return [...new Set(issues)];
}

function audit(text, results, { question = '', mode = 'analyst' } = {}) {
    const issues = [], facts = chartEvidence(results), data = unwrap(results);
    if (!/\b(hypothetical|suppose|assume)\b/i.test(question)) issues.push(...numericClaims(text, results, question));
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
        const disclosurePeriods = new Set();
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
        if (disclosurePeriods.size > 1) issues.push('Horizontal filing disclosure bars must compare amounts from the same disclosed date.');
    }
    if (chartMatches.length > 3) issues.push('Use no more than three charts in a detailed multi-angle answer.');
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
            for (const [field, f] of Object.entries(o.fields)) { row[field] = f.value; row._sources[field] = f.sourceIds; row._scopes[field] = f.scope; }
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
    const limit = wordLimit(question, mode);
    if (wordCount(text) > limit) issues.push(`Answer exceeds ${limit} prose words. Remove repeated figures, unrequested history and technical concept names; preserve requested facts and missing-data reasons.`);
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
    return {
        symbol: income.symbol,
        periodCount: periods.length,
        requestedCount: explicitYear ? 1 : count,
        missing,
        spec: { title: `${income.symbol} · Revenue, net income and share-based compensation`, unit,
            orientation: 'vertical', series }
    };
}

// If one bounded rewrite still fails validation, publish a factual receipt
// rather than the rejected generated conclusions. No narrative is invented.
function fallback(results, question = '') {
    const data = unwrap(results), sections = new Map();
    const lines = ['This is a partial answer using verified SEC evidence. Unverified figures are omitted.'];
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
            for (const [field, label] of fields) if (field in o.fields &&
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

module.exports = { audit, chartEvidence, numericClaims, wordCount, wordLimit, fallback, segmentEvidence, verifiedSegmentEvidence, filingNarrativeEvidence, disclosureCategory, issuerDisclosureEvidence, appendDisclosureSummary };
