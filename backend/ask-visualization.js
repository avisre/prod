'use strict';

const LABELS = { totalRevenue: 'Revenue', netIncome: 'Net income', grossProfit: 'Gross profit', operatingIncome: 'Operating income', researchAndDevelopment: 'Research and development', operatingCashflow: 'Operating cash flow', freeCashflow: 'Free cash flow', totalAssets: 'Total assets', price: 'Stock price', marketCap: 'Market capitalisation' };
// A focused answer is charted only on a field it discusses: an NFLX risk-factor
// answer (2026-10-24) was given an "Annual total assets" chart it never mentioned.
const MENTIONS = { totalRevenue: /revenue|sales|przych|sprzeda/i, netIncome: /net income|net profit|earnings|zysk\S* netto/i,
    grossProfit: /gross (?:profit|margin)|zysk\S* brutto|marż\S* brutto/i, operatingIncome: /operating (?:income|profit|margin)|zysk\S* operacyjn|marż\S* operacyjn/i,
    researchAndDevelopment: /research|R&D|badani/i, operatingCashflow: /operating cash|przepływ\S* operacyjn|przepływ\S* z działalności operacyjnej/i,
    freeCashflow: /free cash|\bFCF\b|woln\S* przepływ/i, totalAssets: /total assets|aktyw\S* ogółem|sum\S* aktywów/i,
    price: /price|cena|ceny|kurs/i, marketCap: /market cap|kapitalizac/i };
function specs(text) {
    return [...String(text).matchAll(/```(viz|bars|sankey)\s*\n([\s\S]*?)```/g)].flatMap(m => {
        try { return [{ type: m[1], ...JSON.parse(m[2]) }]; } catch (_) { return []; }
    });
}
// A model-supplied supported visual takes precedence. If it omits one, provide
// a small chart from the same validated observations, without another model call.
function ensure(text, results, policy) {
    if (!policy.visualRequired) return text;
    const quality = require('./ask-answer-quality');
    // The facts carry no company, so a chart drawn from several companies pooled
    // them: a seven-company answer (2026-10-24) got one "net income" line mixing
    // three companies' quarters. Only a single company's facts are charted here.
    const symbolOf = r => String(r.result?.symbol || r.args?.symbol || '').toUpperCase();
    if (new Set(results.filter(r => symbolOf(r) && quality.chartEvidence([r]).length).map(symbolOf)).size > 1) return text;
    const annualResults = results.filter(r => r.tool === 'get_financials' && /^annual/.test(r.result?.basis));
    const all = quality.chartEvidence(results);
    const annual = [...quality.chartEvidence(annualResults), ...all.filter(f => f.basis === 'annual')], existing = specs(text);
    const annualDates = new Set(annual.map(f => f.periodEnd));
    const annualShown = existing.some(s => (s.series || [{ points: s.rows || [] }]).some(series =>
        new Set((series.points || []).map(p => p[0]?.match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(d => annualDates.has(d))).size >= 2));
    if (existing.length && (policy.kind !== 'company_report' || annualShown || annualDates.size < 2)) return text;
    const facts = annual.length ? annual : all;
    const groups = new Map();
    for (const f of facts) {
        if (!LABELS[f.field] || !f.periodEnd || !Number.isFinite(f.value) || !f.unit) continue;
        if (policy.kind !== 'company_report' && !MENTIONS[f.field].test(text)) continue;
        const key = [f.field, f.unit, f.sourceType || 'sec_filing', f.sourceName || 'SEC', f.accountingBasis || '', f.basis || '', f.sourceType === 'provider' ? f.publicationDate : ''].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    const preference = /free cash|\bfcf\b/i.test(policy.question || '') ? 'freeCashflow'
        : /net income|net profit/i.test(policy.question || '') ? 'netIncome' : /price/i.test(policy.question || '') ? 'price' : 'totalRevenue';
    const periods = group => new Set(group.map(f => f.periodEnd)).size;
    const candidates = [...groups.values()].sort((a, b) => (b[0].field === preference) - (a[0].field === preference) || periods(b) - periods(a));
    const chosen = candidates[0];
    if (!chosen) return text;
    const first = chosen[0], points = [...new Map(chosen.map(f => [f.periodEnd, [f.periodEnd, f.value]])).values()].sort((a, b) => a[0].localeCompare(b[0])).slice(-5);
    const source = first.sourceType === 'provider' || first.sourceType === 'market_quote'
        ? ` · ${first.sourceName} data ${first.publicationDate}` : '';
    const spec = { title: `${annual.length ? 'Annual ' : ''}${LABELS[first.field].toLowerCase()}${source}`, unit: first.unit,
        ...(points.length < 2 ? { orientation: 'vertical' } : {}), series: [{ name: LABELS[first.field], points }] };
    const block = `\n\n\`\`\`${points.length < 2 ? 'bars' : 'viz'}\n${JSON.stringify(spec)}\n\`\`\`\n\n`;
    return /^> Next:/m.test(text) ? String(text).replace(/^> Next:/m, block + '> Next:') : String(text) + block;
}
module.exports = { ensure, specs };
