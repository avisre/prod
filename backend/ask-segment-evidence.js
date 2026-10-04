'use strict';

// Pure checks shared by extraction, cache reads and the answer validator.
const crypto = require('node:crypto');
const inline = require('./ask-inline-segments');
const { number: num, cik, day } = require('./sec-coverage');
const VERSION = 2;
const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const accession = value => String(value || '').replace(/\D/g, '');

function filingMatches(filing, issuer) {
    const match = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\/[^\s"<>]+$/i.exec(String(filing?.url || ''));
    return !!match && cik(match[1]) === cik(issuer) && match[2] === accession(filing.accessionNumber || filing.accession) &&
        ANNUAL_FORMS.has(filing.form) && !!day(filing.date);
}

function exactAnnualRevenue(filing, income, issuer, asOf = new Date().toISOString().slice(0, 10)) {
    if (!cik(issuer) || !filingMatches(filing, issuer) || filing.date > asOf || !/^annual/.test(income?.basis || '')) return null;
    const found = [];
    for (const observation of income?.observations || []) {
        const revenue = observation.fields?.totalRevenue;
        const value = num(revenue?.value), currency = observation.currency;
        if (!(value > 0) || !day(observation.periodEnd) || observation.periodEnd > asOf || !/^[A-Z]{3}$/.test(currency || '')) continue;
        for (const id of revenue.sourceIds || []) {
            const source = income.provenance?.sources?.[id];
            const days = (Date.parse(source?.periodEnd) - Date.parse(source?.periodStart)) / 86400000 + 1;
            if (source?.type !== 'sec_xbrl_fact' || source.linkage !== 'xbrl_fact' || cik(source.cik) !== cik(issuer) ||
                source.form !== filing.form || source.filingDate !== filing.date || accession(source.accessionNumber) !== accession(filing.accessionNumber || filing.accession) ||
                source.periodEnd !== observation.periodEnd || source.unit !== currency || revenue.unit !== currency ||
                num(source.rawValue) !== value || !(days >= 340 && days <= 380)) continue;
            found.push({ value, currency, periodEnd: observation.periodEnd, periodStart: source.periodStart, sourceId: id, source });
        }
    }
    // An annual filing contains comparative revenue for earlier years too.
    // Anchor the flow to its report period rather than treating comparisons
    // as conflicting current-period evidence.
    const annual = income.coverage?.latestAnnual;
    const metadataPeriod = filing.reportDate || (accession(annual?.accessionNumber) === accession(filing.accessionNumber || filing.accession)
        ? annual?.reportDate : null);
    if (metadataPeriod && (!day(metadataPeriod) || metadataPeriod > asOf)) return null;
    const period = metadataPeriod || found.map(row => row.periodEnd).sort().at(-1);
    const selected = found.filter(row => row.periodEnd === period);
    const values = new Set(selected.map(row => row.value + ':' + row.currency));
    return selected.length && values.size === 1 ? selected[0] : null;
}

function rawNumberAppears(quote, value) {
    const normalized = String(quote || '').replace(/,/g, '');
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\d.])${escaped}(?!\\d|\\.\\d)`).test(normalized);
}

function scaleFromText(text) {
    const scales = new Set();
    if (/\b(?:millions?|mn)\b/i.test(text)) scales.add(1e6);
    if (/\b(?:thousands?)\b/i.test(text)) scales.add(1e3);
    if (/\b(?:billions?|bn)\b/i.test(text)) scales.add(1e9);
    if (scales.size > 1) return null;
    return scales.size ? [...scales][0] : 1;
}

function basisCurrencyMatches(text, currency) {
    const upper = String(text || '').toUpperCase();
    const codes = upper.match(/\b(?:USD|CAD|AUD|HKD|SGD|NZD|EUR|GBP|CNY|JPY|CHF|INR|KRW|SEK|NOK|DKK|BRL|MXN|ZAR|ILS|TWD)\b/g) || [];
    const aliases = [
        ['USD', /\b(?:U\.?S\.?|UNITED STATES|AMERICAN) DOLLARS?\b|US\$/],
        ['CAD', /\bCANADIAN DOLLARS?\b|C\$/], ['AUD', /\bAUSTRALIAN DOLLARS?\b|A\$/],
        ['HKD', /\bHONG KONG DOLLARS?\b|HK\$/], ['EUR', /\bEUROS?\b|€/],
        ['GBP', /\b(?:POUNDS? STERLING|BRITISH POUNDS?)\b|£/], ['CNY', /\b(?:RMB|RENMINBI|CHINESE YUAN)\b/],
        ['JPY', /\b(?:JAPANESE )?YEN\b/]
    ];
    for (const [code, pattern] of aliases) if (pattern.test(upper)) codes.push(code);
    const unique = new Set(codes);
    if (unique.size) return unique.size === 1 && unique.has(currency);
    // Exact-filing XBRL currency establishes which dollar/yen basis a symbol
    // denotes; a symbol alone never establishes the issuer's currency.
    return upper.includes('$') ? /^(?:USD|CAD|AUD|HKD|SGD|NZD|TWD)$/.test(currency)
        : upper.includes('¥') ? /^(?:JPY|CNY)$/.test(currency) : false;
}
const currencyCue = text => /\$|¥|€|£|\b(?:USD|CAD|AUD|HKD|SGD|NZD|EUR|GBP|CNY|JPY|CHF|INR|KRW|SEK|NOK|DKK|BRL|MXN|ZAR|ILS|TWD|dollars?|euros?|sterling|yen|RMB|renminbi)\b/i.test(text);

function witness(text, excerpt) {
    const quote = compact(excerpt);
    if (quote.length < 4 || quote.length > 1500) return null;
    const start = text.indexOf(quote);
    return start < 0 ? null : { excerpt: quote, start, digest: hash(quote) };
}
function witnessValid(proof) {
    return !!proof && typeof proof.excerpt === 'string' && proof.excerpt.length >= 4 && proof.excerpt.length <= 1500 &&
        Number.isSafeInteger(proof.start) && proof.start >= 0 && proof.digest === hash(proof.excerpt);
}
const anchorDigest = anchor => hash(JSON.stringify([anchor?.sourceId, anchor?.source, anchor?.periodEnd, anchor?.value, anchor?.currency]));

function normalizeResult(parsed, symbol, issuer, filing, context) {
    const anchor = context?.anchor, text = compact(context?.text);
    if (!anchor || !text || !Array.isArray(parsed?.segments) || parsed.segments.length > 10 || parsed.segments.length < 2 || parsed.periodEnd !== anchor.periodEnd) return null;
    const basis = witness(text, parsed.basisExcerpt), period = witness(text, parsed.periodExcerpt);
    if (!basis || !period || !rawNumberAppears(period.excerpt, anchor.periodEnd.slice(0, 4)) ||
        (currencyCue(basis.excerpt) && !basisCurrencyMatches(basis.excerpt, anchor.currency))) return null;
    const scale = scaleFromText(basis.excerpt);
    if (scale === null) return null;
    const names = new Set();
    const segments = [];
    for (const item of parsed.segments) {
        const name = compact(item.name), reportedValue = num(item.reportedValue), value = num(item.value);
        const source = witness(text, item.sourceExcerpt);
        const binding = inline.select(context.inlineBindings || [], name, value, scale, anchor, issuer);
        const sharedQuote = parsed.segments.some(other => other !== item && source?.excerpt.toLowerCase().includes(compact(other.name).toLowerCase()));
        if (!name || name.length > 100 || names.has(name.toLowerCase()) || !source || !(reportedValue > 0) || item.scale !== scale ||
            item.currency !== anchor.currency || value !== reportedValue * scale || !rawNumberAppears(source.excerpt, reportedValue) ||
            !source.excerpt.toLowerCase().includes(name.toLowerCase()) || (sharedQuote && !binding) ||
            (!basisCurrencyMatches(basis.excerpt, anchor.currency) && !binding && !basisCurrencyMatches(source.excerpt, anchor.currency))) return null;
        names.add(name.toLowerCase());
        segments.push({ name, reportedValue, scale, currency: anchor.currency, value, sourceExcerpt: source.excerpt,
            sourceProof: source, ...(binding ? { inlineBinding: binding } : {}), sourceIds: [`sec-segment:${cik(issuer)}:${accession(filing.accession || filing.accessionNumber)}:${source.digest}`] });
    }
    return { schemaVersion: VERSION, symbol, cik: cik(issuer), periodEnd: anchor.periodEnd, currency: anchor.currency,
        segments, filing: { form: filing.form, date: filing.date, accessionNumber: filing.accession || filing.accessionNumber, url: filing.url },
        revenueEvidence: { statement: 'income', basis: 'annual', observations: [{ periodEnd: anchor.periodEnd, currency: anchor.currency,
            fields: { totalRevenue: { value: anchor.value, unit: anchor.currency, sourceIds: [anchor.sourceId] } } }],
            provenance: { sources: { [anchor.sourceId]: anchor.source } } },
        evidence: { type: 'sec_filing_text', documentDigest: hash(text), anchorDigest: anchorDigest(anchor), basis, period },
        verificationStatus: 'source_verified', extractedAt: new Date().toISOString() };
}

function validCachedPayload(payload, issuer, filing, anchor) {
    if (!payload || !anchor || payload.schemaVersion !== VERSION || payload.cik !== cik(issuer) || !filingMatches(payload.filing, issuer) ||
        accession(payload.filing.accessionNumber) !== accession(filing.accession || filing.accessionNumber) || payload.filing.date !== filing.date ||
        payload.filing.url !== filing.url || payload.periodEnd !== anchor.periodEnd || payload.currency !== anchor.currency ||
        payload.evidence?.type !== 'sec_filing_text' || !/^[a-f0-9]{64}$/.test(payload.evidence.documentDigest || '') ||
        payload.evidence.anchorDigest !== anchorDigest(anchor) || !witnessValid(payload.evidence.basis) || !witnessValid(payload.evidence.period) ||
        !rawNumberAppears(payload.evidence.period.excerpt, anchor.periodEnd.slice(0, 4)) ||
        (currencyCue(payload.evidence.basis.excerpt) && !basisCurrencyMatches(payload.evidence.basis.excerpt, anchor.currency)) ||
        !Array.isArray(payload.segments) || payload.segments.length < 2 || payload.segments.length > 10) return false;
    const names = new Set(), scale = scaleFromText(payload.evidence.basis.excerpt);
    return payload.segments.every(s => {
        const name = compact(s.name).toLowerCase();
        const binding = s.inlineBinding && inline.matches(s.inlineBinding, s.name, s.value, s.scale, anchor, issuer);
        const sharedQuote = payload.segments.some(other => other !== s && s.sourceExcerpt?.toLowerCase().includes(compact(other.name).toLowerCase()));
        if (!name || names.has(name) || s.currency !== anchor.currency || !(num(s.reportedValue) > 0) || s.scale !== scale ||
            num(s.value) !== s.reportedValue * s.scale || !witnessValid(s.sourceProof) || s.sourceExcerpt !== s.sourceProof.excerpt ||
            !rawNumberAppears(s.sourceExcerpt, s.reportedValue) || !s.sourceExcerpt.toLowerCase().includes(name) ||
            s.sourceIds?.[0] !== `sec-segment:${cik(issuer)}:${accession(payload.filing.accessionNumber)}:${s.sourceProof.digest}` ||
            (s.inlineBinding && !binding) || (sharedQuote && !binding) ||
            (!basisCurrencyMatches(payload.evidence.basis.excerpt, anchor.currency) && !binding && !basisCurrencyMatches(s.sourceExcerpt, anchor.currency))) return false;
        names.add(name); return true;
    });
}

module.exports = { VERSION, hash, compact, accession, filingMatches, exactAnnualRevenue, rawNumberAppears, normalizeResult, validCachedPayload };
