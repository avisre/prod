'use strict';

// Deterministic checks of the generated presentation against supplied evidence.
// These checks do not claim to verify arbitrary narrative or outside research.
const { number: num } = require('./sec-coverage');
const { capitalReturns } = require('./ask-evidence');
const unitName = unit => unit === '$' ? 'USD' : unit === '$ps' ? 'USD/share' : unit;
const unwrap = results => results.map(r => r.result || r).filter(r => !r.error);

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
    return out;
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

function numericClaims(text, results) {
    const data = unwrap(results);
    if (!data.some(r => r.observations?.some(o => o.fields))) return [];
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
        if (!facts.some(f => (f.unit === unit || f.unit === unit + '/share') &&
            (Math.abs(f.value - value) <= tolerance ||
            ((/capitalExpenditures|dividend|Repurchase/.test(f.field || '') ||
                (f.difference && /fell|fall|drop|declin|decreas|lower/i.test(context)) ||
                (f.field === 'surplusAfterDistributions' && /short|deficit|more than|exceed|gap/i.test(context))) && Math.abs(Math.abs(f.value) - Math.abs(value)) <= tolerance))))
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
    if (!/\b(hypothetical|suppose|assume)\b/i.test(question)) issues.push(...numericClaims(text, results));
    const financial = data.some(r => r.observations?.length);
    let charts = 0;
    for (const match of text.matchAll(/```(viz|bars)\s*\n([\s\S]*?)```/g)) {
        charts++;
        let spec;
        try { spec = JSON.parse(match[2]); } catch (_) { issues.push('Chart JSON is invalid.'); continue; }
        const unit = unitName(spec.unit);
        if (!/^(?:[A-Z]{3}(?:\/share)?|%|x|shares)$/.test(unit || '')) issues.push('Chart unit is missing or unsupported.');
        const series = match[1] === 'viz' ? spec.series : [{ points: spec.rows }];
        if (!Array.isArray(series) || !series.length || series.length > 3) { issues.push('Chart series structure is invalid.'); continue; }
        for (const s of series) {
            if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length > (match[1] === 'bars' ? 8 : 20)) {
                issues.push('Chart needs 2–20 time points, or 2–8 category rows.'); continue;
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
                    const magnitude = /capex|capital expend|dividend|buyback|repurchas/i.test(p[0] + ' ' + (s.name || ''));
                    const matches = facts.filter(f => f.unit === unit &&
                        (Math.abs(f.value - v) <= Math.max(1e-8, Math.abs(f.value) * 1e-10) ||
                        (magnitude && Math.abs(Math.abs(f.value) - v) <= Math.max(1e-8, Math.abs(f.value) * 1e-10))));
                    if (!matches.length) issues.push('A financial chart value has no exact supplied source in its declared unit. Use raw unscaled observations/calculations; do not use the millions table.');
                    else {
                        const label = p[0] + ' ' + (s.name || '');
                        const metric = unit === '%' && /net margin/i.test(label) ? 'netMarginPct'
                            : unit === '%' && /gross margin/i.test(label) ? 'grossMarginPct'
                            : unit === '%' && /operating margin/i.test(label) ? 'opMarginPct'
                            : /free cash|\bFCF\b/i.test(label) ? 'freeCashflow'
                            : /operating cash/i.test(label) ? 'operatingCashflow'
                            : /capex|capital expend/i.test(label) ? 'capitalExpenditures'
                            : /net income|net profit/i.test(label) ? 'netIncome'
                            : /revenue|sales/i.test(label) ? 'totalRevenue' : null;
                        if (metric && !matches.some(f => f.field === metric)) issues.push('Chart metric label does not match its sourced field.');
                        const date = p[0].match(/\d{4}-\d{2}-\d{2}/)?.[0];
                        if (date && !matches.some(f => f.periodEnd === date)) issues.push('Chart date does not match the sourced financial period.');
                    }
                }
            }
            // A connecting line implies chronological movement. Categories
            // such as OCF, capex and FCF must instead use horizontal bars.
            if (match[1] === 'viz' && s.points.some(p => /^(?:operating cash flow|capex|capital expenditure|free cash flow)$/i.test(p?.[0] || '')))
                issues.push('Use bars for categories such as operating cash flow, capex and FCF; a line chart implies a time sequence.');
        }
    }
    if (charts > 2) issues.push('Use no more than two charts.');
    if (charts && /```viz/.test(text) && !/```bars/.test(text) && /each bar|the bars|bar chart/i.test(text.replace(/```[\s\S]*?```/g, '')))
        issues.push('The supplied viz renders as a line chart. Describe its lines/points accurately, or use a bars block for a category comparison.');
    if (/```(?:viz|bars)[\s\S]*$/.test(text.replace(/```(?:viz|bars)\s*\n[\s\S]*?```/g, '')))
        issues.push('Chart fence is incomplete.');

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

// If one bounded rewrite still fails validation, publish a factual receipt
// rather than the rejected generated conclusions. No narrative is invented.
function fallback(results, question = '') {
    const data = unwrap(results), sections = new Map();
    const lines = ['I verified these figures, but could not validate the accompanying analysis.'];
    const requested = [
        ['totalRevenue', 'Revenue', /revenue|sales/i], ['netIncome', 'Net income', /income|profit|earnings/i],
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
    const periods = /two|compare|prior|previous|trend|years|history/i.test(question) ? 2 : 1;
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
                (r.statement === 'cash' ? /operatingCashflow|capitalExpenditures|dividendPayout|paymentsForRepurchaseOfCommonStock/.test(field) : r.statement === 'income' ? /totalRevenue|netIncome/.test(field) : true)) {
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
    const errors = new Set();
    for (const { result } of results) if (result?.error) {
        if (result.code === 'UNSUPPORTED_SECURITY_TYPE' && result.symbol && result.securityType)
            errors.add(`${result.symbol} is a ${result.securityType}. Company financial analysis is unavailable for this instrument.`);
        else if (result.code === 'VERIFIED_FINANCIALS_UNAVAILABLE') errors.add('Some requested company figures have no verified financial data available.');
        else errors.add('Some requested research was unavailable.');
    }
    for (const error of errors) lines.push('\n' + error);
    return lines.join('\n');
}

module.exports = { audit, chartEvidence, numericClaims, wordCount, wordLimit, fallback };
