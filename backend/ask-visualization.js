'use strict';

const LABELS = { totalRevenue: 'Revenue', netIncome: 'Net income', grossProfit: 'Gross profit', operatingIncome: 'Operating income', researchAndDevelopment: 'Research and development', operatingCashflow: 'Operating cash flow', freeCashflow: 'Free cash flow', totalAssets: 'Total assets', price: 'Stock price', marketCap: 'Market capitalisation' };
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
