'use strict';

// Evidence sent to Ask is limited to the observations actually used. Values
// remain in reported units; presentation scaling belongs to the table only.
const { number: num, day } = require('./sec-coverage');
const DAY = 86400000;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 192 * 1024;

function observation(row, field) {
    const value = num(row?.[field]);
    const sourceIds = value === null ? [] : [...new Set(row?._sources?.[field] || [])];
    return {
        value: sourceIds.length ? value : null,
        periodEnd: row?.fiscalDateEnding || null,
        periodStart: row?.periodStart || null,
        currency: row?.reportedCurrency || null,
        unit: /shares/i.test(field) ? 'shares' : /eps/i.test(field) ? `${row?.reportedCurrency || 'unknown'}/share` : row?.reportedCurrency || null,
        scope: row?._scopes?.[field] || null,
        sourceIds,
        ...(row?._signs?.[field] ? { transformation: { formula: 'rawValue * multiplier', multiplier: row._signs[field] } } : {}),
        ...(row?._derivations?.[field] ? { derivation: row._derivations[field] } : {})
    };
}

function rowEvidence(row, fields) {
    return {
        periodEnd: row.fiscalDateEnding, periodStart: row.periodStart || null,
        currency: row.reportedCurrency, periodType: row.periodType,
        fields: Object.fromEntries(fields.map(field => [field, observation(row, field)]))
    };
}

function provenance(data, observations) {
    const ids = new Set();
    function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value.sourceIds)) for (const id of value.sourceIds) ids.add(id);
        for (const [key, item] of Object.entries(value)) if (key !== 'sourceIds') visit(item);
    }
    visit(observations);
    return {
        financialDigest: data.provenance?.financialDigest || null,
        sources: Object.fromEntries([...ids].filter(id => data.provenance?.sources?.[id])
            .map(id => [id, data.provenance.sources[id]]))
    };
}

function compatible(a, b) {
    return a.value !== null && b.value !== null && a.currency && a.currency === b.currency && a.scope === b.scope;
}

function quarterlyComparisons(reports, fields) {
    const rows = reports.filter(r => day(r.fiscalDateEnding)).slice().sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));
    const latest = rows[0];
    if (!latest) return null;
    // 52/53-week calendars move by a few days. Require matching durations as
    // well as an actual dated quarter, never an array offset or a YTD period.
    const duration = r => r.periodStart ? (Date.parse(r.fiscalDateEnding) - Date.parse(r.periodStart)) / DAY + 1 : null;
    const instant = latest.periodType === 'instant';
    const candidates = (low, high) => rows.filter(r => {
        const gap = (Date.parse(latest.fiscalDateEnding) - Date.parse(r.fiscalDateEnding)) / DAY;
        return gap >= low && gap <= high && r.reportedCurrency === latest.reportedCurrency &&
            (instant ? r.periodType === 'instant' : duration(latest) >= 75 && duration(latest) <= 105 && duration(r) >= 75 && duration(r) <= 105);
    });
    const compare = (low, high) => {
        const matches = candidates(low, high);
        const prior = matches.length === 1 ? matches[0] : null;
        return {
            periodEnd: prior?.fiscalDateEnding || null,
            missingReason: prior ? null : 'No unique comparable verified quarter is available.',
            metrics: Object.fromEntries(fields.map(field => {
                const current = observation(latest, field), previous = observation(prior, field);
                const valid = compatible(current, previous) && previous.value > 0;
                return [field, {
                    current, previous,
                    changePct: valid ? (current.value / previous.value - 1) * 100 : null,
                    formula: '(current / previous - 1) * 100',
                    sourceIds: valid ? [...new Set([...current.sourceIds, ...previous.sourceIds])] : [],
                    missingReason: valid ? null : 'Missing or incompatible facts, or a non-positive comparison base.'
                }];
            }))
        };
    };
    return { periodEnd: latest.fiscalDateEnding, yoy: compare(350, 380), qoq: compare(75, 105) };
}

function annualComparisons(reports, fields) {
    const rows = reports.filter(r => day(r.fiscalDateEnding)).slice().sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));
    const current = rows[0];
    if (!current) return null;
    const annual = r => r.periodType === 'instant' || (r.periodStart &&
        (Date.parse(r.fiscalDateEnding) - Date.parse(r.periodStart)) / DAY + 1 >= 340 &&
        (Date.parse(r.fiscalDateEnding) - Date.parse(r.periodStart)) / DAY + 1 <= 380);
    const candidates = rows.slice(1).filter(r => {
        const gap = (Date.parse(current.fiscalDateEnding) - Date.parse(r.fiscalDateEnding)) / DAY;
        return gap >= 340 && gap <= 380 && annual(current) && annual(r) && r.reportedCurrency === current.reportedCurrency;
    });
    const prior = candidates.length === 1 ? candidates[0] : null;
    return { periodEnd: current.fiscalDateEnding, yoy: {
        periodEnd: prior?.fiscalDateEnding || null,
        missingReason: prior ? null : 'No unique comparable verified annual period is available.',
        metrics: Object.fromEntries(fields.map(field => {
            const a = observation(current, field), b = observation(prior, field);
            const magnitude = /capitalExpenditures|dividend|Repurchase/.test(field);
            const base = b.value === null ? null : magnitude ? Math.abs(b.value) : b.value;
            const valid = compatible(a, b) && base > 0;
            return [field, { current: a, previous: b,
                changePct: valid ? ((magnitude ? Math.abs(a.value) : a.value) / base - 1) * 100 : null,
                formula: magnitude ? '(abs(current) / abs(previous) - 1) * 100' : '(current / previous - 1) * 100',
                sourceIds: valid ? [...new Set([...a.sourceIds, ...b.sourceIds])] : [],
                missingReason: valid ? null : 'Missing or incompatible annual inputs, or a non-positive comparison base.' }];
        }))
    } };
}

function freeCashFlow(row) {
    const ocf = observation(row, 'operatingCashflow'), capex = observation(row, 'capitalExpenditures');
    const valid = compatible(ocf, capex);
    return {
        value: valid ? ocf.value - Math.abs(capex.value) : null,
        periodEnd: row.fiscalDateEnding, periodStart: row.periodStart || null,
        currency: row.reportedCurrency,
        formula: 'operatingCashflow - abs(capitalExpenditures)',
        inputs: { operatingCashflow: ocf, capitalExpenditures: capex },
        sourceIds: valid ? [...new Set([...ocf.sourceIds, ...capex.sourceIds])] : [],
        missingReason: valid ? null : 'Both verified cash-flow inputs for the same period and currency are required.'
    };
}

function capitalReturns(row) {
    const fcf = freeCashFlow(row), dividends = observation(row, 'dividendPayout');
    const buybacks = observation(row, 'paymentsForRepurchaseOfCommonStock');
    const valid = fcf.value !== null && compatible(dividends, buybacks) &&
        dividends.currency === fcf.currency;
    const total = valid ? Math.abs(dividends.value) + Math.abs(buybacks.value) : null;
    return { periodEnd: row.fiscalDateEnding, periodStart: row.periodStart || null,
        currency: row.reportedCurrency, freeCashflow: fcf.value,
        totalDistributions: total, surplusAfterDistributions: valid ? fcf.value - total : null,
        shortfallPctOfFreeCashflow: valid && fcf.value > 0 ? Math.max(0, total - fcf.value) / fcf.value * 100 : null,
        coveredByFreeCashflow: valid ? fcf.value >= total : null,
        formula: 'freeCashflow - (abs(dividendPayout) + abs(paymentsForRepurchaseOfCommonStock))',
        inputs: { freeCashflow: fcf, dividends, buybacks },
        sourceIds: valid ? [...new Set([...fcf.sourceIds, ...dividends.sourceIds, ...buybacks.sourceIds])] : [],
        missingReason: valid ? null : 'Verified FCF, dividends and buybacks for the same period and currency are required.' };
}

function calculate(inputs, formula, fn, { sameScope = false } = {}) {
    const values = Object.values(inputs);
    const first = values[0];
    const valid = first && values.every(o => o.value !== null && o.sourceIds.length && o.currency && o.currency === first.currency &&
        o.periodEnd === first.periodEnd && (!o.periodStart || !first.periodStart || o.periodStart === first.periodStart) &&
        (!sameScope || (o.scope && o.scope === first.scope)));
    const value = valid ? num(fn(...values.map(o => o.value))) : null;
    return { value, formula, inputs, periodEnd: first?.periodEnd || null, periodStart: first?.periodStart || null,
        currency: first?.currency || null, sourceIds: value === null ? [] : [...new Set(values.flatMap(o => o.sourceIds))],
        missingReason: value === null ? 'Verified compatible inputs and a valid denominator are required.' : null };
}

function toolError(error) {
    const known = {
        UNSUPPORTED_SECURITY_TYPE: 'Company financial analysis is unavailable for units and rights. Explain the instrument and continue any supported company research.',
        VERIFIED_FINANCIALS_UNAVAILABLE: 'No verified SEC financial facts are available. State the gap and continue any supported research.'
    };
    const code = known[error?.code] ? error.code : 'TOOL_UNAVAILABLE';
    // Do not put upstream errors, credentials or provider details in prompts.
    return { code, error: known[code] || 'This data tool is unavailable. State the gap and continue with the other results.', retryable: false,
        ...(code === 'UNSUPPORTED_SECURITY_TYPE' && ['unit', 'right'].includes(error.securityType)
            ? { symbol: error.symbol, securityType: error.securityType } : {}) };
}

function serializeResult(result, remaining) {
    const content = JSON.stringify(result ?? { error: 'The tool returned no data.' });
    if (Buffer.byteLength(content) <= Math.min(MAX_RESULT_BYTES, remaining)) return content;
    return JSON.stringify({ code: 'TOOL_CONTEXT_LIMIT', error: 'This result exceeds the research context budget. Request fewer periods or a narrower result. No values from this result were supplied.' });
}

function fitHistory(result, data, availablePeriods) {
    const requestedPeriods = result.observations.length;
    result.history = { requestedPeriods, returnedPeriods: requestedPeriods, availablePeriods, omittedReason: null };
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES && result.observations.length > 1) {
        result.observations.pop();
        if (result.calculations?.length) result.calculations.pop();
        if (result.capitalReturns?.length) result.capitalReturns.pop();
        result.table = result.table.split('\n').slice(0, result.observations.length + 1).join('\n');
        result.provenance = provenance(data, [result.observations, result.comparisons, result.calculations, result.capitalReturns]);
        result.history.returnedPeriods = result.observations.length;
        result.history.omittedReason = 'Older periods omitted to keep research within its context budget. Use before with the oldest returned periodEnd for the next history window.';
    }
    return result;
}

function filingLinks(result) {
    return Object.values(result?.provenance?.sources || {}).filter(s => s.linkage === 'xbrl_fact' &&
        /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//.test(s.filingUrl || ''))
        .map(s => ({ url: s.filingUrl, label: `${result.symbol || 'SEC'} ${s.form} filed ${s.filingDate}` }));
}

function appendCitations(text, links) {
    const unique = [...new Map(links.map(link => [link.url, link])).values()];
    const missing = unique.filter(link => !text.includes(link.url)).slice(0, 8);
    if (!missing.length) return text;
    const citation = '\n\nSEC sources: ' + missing.map(link => `[${link.label}](${link.url})`).join('; ') + '.';
    // Preserve the UI's final suggested-question contract.
    const next = text.search(/\n> Next:/);
    return next < 0 ? text + citation : text.slice(0, next) + citation + text.slice(next);
}

// A concrete financial number cannot be answered solely from model memory.
// Definitions, hypothetical inputs and user attachments remain supported.
function requiresEvidence(question, answer) {
    const definition = /^\s*(?:define\b|definition\b|explain (?:the |how )?(?:formula|concept)\b|what does .+ mean\s*\??$|what (?:is|are) (?:an? |the )?(?:net margin|revenue|earnings per share|eps|cash flow|p\/e|price.to.earnings|gross margin|operating margin|capex|market cap)(?: ratio| multiple| formula)?\s*[?.]?\s*$)/i.test(question);
    return /\d/.test(answer) &&
        /\b(revenue|net income|earnings|eps|cash flow|capex|market cap|stock price|quarter|financial results|margin|p\/e|trades)\b/i.test(question + '\n' + answer) &&
        !definition && !/\b(hypothetical|suppose|assume)\b/i.test(question);
}

module.exports = { observation, rowEvidence, provenance, compatible, quarterlyComparisons, annualComparisons, freeCashFlow, capitalReturns, calculate,
    toolError, serializeResult, fitHistory, filingLinks, appendCitations, requiresEvidence, MAX_RESULT_BYTES, MAX_CONTEXT_BYTES };
