'use strict';

// Shared by generation, numerical review, saved conversations and local QA.
const VERSION = 2;
const ANSWER_MAX_CHARS = 32000;
const QUESTION_MAX_CHARS = 8000;
const HISTORY_MAX_BYTES = 64000;
const EXPLICIT = /(?:under|at most|maximum(?: of)?|no more than|within|keep (?:it|the answer) (?:to|below))\s+(\d+)\s+words\b/i;
const NARROW = /\b(?:compar(?:e|es|ed|ing|ison)|similar|peers?|competitors?|(?:companies|stocks) like|lookalikes?|versus|vs\.?|portfolio|screen(?:er|ing)?|rank|best|top\s+\d|revenue|sales|margin|earnings|eps|income|profit|p\/e|price|market cap|valuation|multiple|dividend|buyback|debt|cash flow|fcf|ratio|yield|volume|beta|volatility|quarter|q[1-4]|fy\s?\d|annual|results|10-k|10-q|8-k|prospectus|insider|governance|esg|risk factor|segments?|guidance|outlook|brief|concise|employees?|headcount|workforce|capex|tax|ffo|affo|arr|roe|roa|backlog)\b/i;
let registry;
function nameKey(value) {
    return String(value || '').toLowerCase().replace(/['’]s\b/g, '')
        .replace(/\b(?:class\s+[a-z]|common (?:stock|shares)|ordinary shares|incorporated|inc|corporation|corp|limited|ltd|co)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function listings() {
    if (!registry) {
        registry = [...require('./stock-universe').companies()];
        // Exchange flags establish funds before keyword rules interpret names.
        const fs = require('node:fs'), path = require('node:path');
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(require('./sec-coverage').DATA_DIR, 'stock-universe-manifest.json'), 'utf8'));
            for (const row of manifest.outcomes || []) if (row.classification === 'etf') registry.push({ symbol: row.symbol, name: row.name, securityType: 'etf' });
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return registry;
}
function resolve(question, companies = listings()) {
    const subject = String(question || '').replace(EXPLICIT, '').replace(/[?.!,]+$/g, '')
        .replace(/^(?:please\s+)?(?:tell me about|what do you think (?:of|about)|give me (?:an? )?(?:overview|report|analysis) (?:of|on)|how is|what does|analy[sz]e|explain)\s+/i, '')
        .replace(/\s+(?:doing|do|please|stock|company)$/i, '').trim();
    const symbol = require('./symbol-resolver').normalizeTicker(subject.replace(/^\$/, ''));
    let matches = companies.filter(c => require('./symbol-resolver').normalizeTicker(c.symbol) === symbol);
    const key = nameKey(subject);
    if (!matches.length && key) matches = companies.filter(c => nameKey(c.name) === key);
    if (!matches.length && /^(?:jpmorgan|j p morgan)$/.test(key)) matches = companies.filter(c => c.symbol === 'JPM');
    if (!matches.length && key.length >= 3) matches = companies.filter(c => nameKey(c.name).startsWith(key + ' '));
    return { subject, matches, bare: matches.length > 0 };
}
function select(question = '', mode = 'analyst', options = {}) {
    const q = String(question).trim(), identity = resolve(q, options.companies);
    const requested = q.match(EXPLICIT), explicitWords = requested ? Number(requested[1]) : null;
    const company = options.company || (identity.matches.length === 1 ? identity.matches[0] : null);
    const ambiguous = identity.matches.length > 1;
    const fund = company && ['etf', 'mutual_fund', 'closed_end_fund'].includes(company.securityType);
    const open = identity.bare || (!NARROW.test(q) && (/\b(?:business|overview|doing|investment|analy[sz]e|analysis|report|tell me|think|thoughts|deep dive|in.depth)\b/i.test(q) || (!!options.company && /^[\w .&'’-]+$/.test(q))));
    const full = !!company && company.securityType === 'stock' && open && !ambiguous;
    const kind = ambiguous ? 'listing_choice' : fund ? 'fund' : full ? 'company_report' : 'focused';
    const detailed = /\b(?:detailed|comprehensive|in.depth|deep dive|exhaustive)\b/i.test(q);
    const maxWords = explicitWords !== null ? explicitWords : full ? 1200 : detailed ? (mode === 'normal' ? 700 : 1000) : mode === 'normal' ? 320 : 480;
    return { version: VERSION, kind, mode: mode === 'normal' ? 'normal' : 'analyst',
        company, choices: ambiguous ? identity.matches.map(c => ({ symbol: c.symbol, name: c.name, exchange: c.exchange })) : [],
        targetWords: full && explicitWords === null ? [600, 900] : null,
        maxWords, ceiling: explicitWords === null ? Math.ceil(maxWords * 1.05) : maxWords,
        explicitWordLimit: explicitWords !== null, tableRows: full ? 70 : 40,
        visualRequired: !!company && !ambiguous && !/\b(?:no|without)\s+(?:extra\s+history\s+or\s+)?(?:chart|visual)/i.test(q) && !(explicitWords !== null && explicitWords < 40),
        annualPeriods: full ? 5 : null, quarterlyPeriods: full ? 4 : null };
}
function missingResearch(policy, used) {
    if (policy.kind !== 'company_report' || policy.explicitWordLimit) return [];
    const symbol = policy.company.symbol;
    const required = [
        ...['income', 'balance', 'cash'].map(statement => ({ tool: 'get_financials', args: { symbol, statement, basis: 'annual', limit: 5 } })),
        { tool: 'get_financials', args: { symbol, statement: 'income', basis: 'quarterly', limit: 4 } },
        ...['annual', 'quarterly'].map(basis => ({ tool: 'get_ratios_history', args: { symbol, basis, limit: basis === 'annual' ? 5 : 4 } })),
        ...['get_peer_context', 'get_segments', 'get_quote', 'get_key_points', 'get_filing_diff'].map(tool => ({ tool, args: { symbol } }))
    ];
    // An attempted retrieval, including an honest failure, satisfies the fetch
    // requirement. It does not make the missing observations available.
    return required.filter(r => !used.some(t => t.tool === r.tool && String(t.args?.symbol || '').toUpperCase() === symbol &&
        (!r.args.statement || t.args.statement === r.args.statement) && (!r.args.basis || (t.args.basis || 'annual') === r.args.basis) &&
        (!r.args.limit || Number(t.args.limit ?? (r.tool === 'get_financials' ? 5 : 10)) >= r.args.limit)));
}
function supplementalNeeds(policy, results) {
    if (policy.kind !== 'company_report' || policy.explicitWordLimit) return null;
    const fields = new Set(), sections = new Set();
    for (const basis of ['annual', 'quarterly']) {
        const income = results.find(r => r.tool === 'get_financials' && r.result?.statement === 'income' && String(r.result?.basis || '').startsWith(basis));
        for (const field of ['totalRevenue', 'netIncome']) {
            const count = new Set((income?.result?.observations || []).filter(o => Number.isFinite(o.fields?.[field]?.value)).map(o => o.periodEnd)).size;
            if (count < (basis === 'annual' ? policy.annualPeriods : policy.quarterlyPeriods)) fields.add(field);
        }
    }
    for (const r of results) {
        if (r.tool === 'get_financials' || r.tool === 'get_ratios_history') for (const gap of r.result?.coverage?.remainingGaps || []) if (gap.field && gap.state !== 'not_applicable') fields.add(gap.field);
        if (r.tool === 'get_key_points' && (r.result?.error || !(r.result?.sections?.length))) sections.add('business');
        if (r.tool === 'get_segments' && r.result?.error) sections.add('segments');
        if (r.tool === 'get_quote' && (r.result?.error || !Number.isFinite(r.result?.price))) sections.add('valuation');
    }
    return fields.size || sections.size ? { symbol: policy.company.symbol, missingFields: [...fields], missingSections: [...sections], periods: { annual: policy.annualPeriods, quarterly: policy.quarterlyPeriods } } : null;
}
function reportIssues(text, policy, results) {
    if (policy.kind !== 'company_report' || policy.explicitWordLimit) return [];
    const financial = results.filter(r => r.tool === 'get_financials' && r.result?.statement === 'income');
    const supplements = results.flatMap(r => r.result?.supplementalObservations || []).filter(f => ['totalRevenue','netIncome'].includes(f.field) && f.state === 'available' && require('./company-observations').validSupplement(f,f.issuer));
    if (!financial.some(r => r.result?.observations?.length) && !supplements.length) return []; // A bounded search may leave no history.
    const issues = [], rows = (String(text).match(/^\s*\|.*$/gm) || []).join('\n');
    const availableDates = {};
    for (const basis of ['annual','quarterly']) {
        const observations = financial.find(r => String(r.result?.basis || '').startsWith(basis))?.result?.observations || [];
        const dates = [...new Set(observations.length ? observations.map(o => o.periodEnd) : supplements.filter(f => (f.historyBasis || f.basis) === basis).map(f => f.periodEnd))].sort().reverse().slice(0, basis === 'annual' ? policy.annualPeriods : policy.quarterlyPeriods);
        availableDates[basis] = dates;
        if (dates.some(date => !rows.includes(date))) issues.push(`The full report needs its available ${basis} financial periods in a Markdown table with actual fiscal period ends. Keep exact supplied values; state unavailable periods rather than filling them from memory.`);
    }
    const sections = coverage(text);
    if (rows) {
        if (availableDates.annual.some(date => rows.includes(date))) sections.annual = true;
        if (availableDates.quarterly.some(date => rows.includes(date))) sections.quarters = true;
    }
    const missing = Object.entries(sections).filter(([,present]) => !present).map(([section]) => section);
    if (missing.length) issues.push('The full report lacks these requested topics: ' + missing.join(', ') + '. Cover supported evidence or state each specific source gap. Choose your own headings, layout and reading order; keep the requested The read and Next markers.');
    return issues;
}
function prompt(policy) {
    return `SELECTED ANSWER POLICY: ${policy.kind}; ${policy.explicitWordLimit ? 'strict requested' : 'default'} prose limit ${policy.maxWords} words${policy.targetWords ? '; aim for 600–900 prose words in BOTH modes' : ''}; Markdown tables and chart JSON have separate budgets (${policy.tableRows} table rows). ${policy.company ? `Resolved listing: ${policy.company.name} (${policy.company.symbol}), ${policy.company.securityType}.` : 'Resolve the listing and instrument before choosing company or fund tools.'}
VISUAL FREEDOM: choose your own headings, reading order and visual layout. Choose any supported line chart, horizontal or grouped bars, faceted bars, eligible revenue Sankey or Markdown table that helps explain the evidence. Include a meaningful chart when supplied observations support it; a simple lookup can use a single-value bar. Choose the number and placement of visuals to suit the question. Preserve readable scales, exact periods, currencies, definitions and attribution. A financial report includes at least one annual trend visual when compatible history exists. Explain the gap when no supported chart can be drawn. Never invent data to make a visual.`;
}
function historyMessages(history, n = 8) {
    let remaining = HISTORY_MAX_BYTES;
    return (Array.isArray(history) ? history.slice(-n) : []).filter(h => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string').reverse().flatMap(h => {
        if (!remaining) return [];
        let text = h.content.slice(0, h.role === 'assistant' ? ANSWER_MAX_CHARS : QUESTION_MAX_CHARS);
        if (Buffer.byteLength(text) > remaining) text = Buffer.from(text).subarray(0, remaining).toString('utf8').replace(/\uFFFD$/, '');
        remaining -= Buffer.byteLength(text);
        return [{ role: h.role, content: text }];
    }).reverse();
}
function coverage(text) {
    const tests = { business: /\b(?:business|sells?|products?|customers?|makes money)\b/i,
        divisions: /\b(?:segments?|divisions?|revenue streams?|business mix|not disclosed)\b/i,
        quarters: /\b(?:quarters?|q[1-4])\b/i, annual: /\b(?:annual|fiscal years?|FY20\d\d)\b/i,
        differences: /\b(?:peers?|competitors?|different|competitive|advantages?|moat|positioning|pricing power)\b/i, risks: /\b(?:risks?|threats?|uncertainty|dependencies|concentration)\b/i,
        valuation: /\b(?:valuation|P\/E|price|market cap|multiple)\b/i, read: /\*\*The read\*\*/i, next: /^>\s*Next:/m };
    return Object.fromEntries(Object.entries(tests).map(([section, test]) => [section, test.test(text)]));
}
module.exports = { VERSION, ANSWER_MAX_CHARS, QUESTION_MAX_CHARS, HISTORY_MAX_BYTES, select, prompt, resolve, coverage, historyMessages, missingResearch, supplementalNeeds, reportIssues, invalidate: () => { registry = null; } };
