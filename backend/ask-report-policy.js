'use strict';

// Shared by generation, numerical review, saved conversations and local QA.
const VERSION = 4;
const ANSWER_MAX_CHARS = 32000;
const QUESTION_MAX_CHARS = 60000;
const HISTORY_MAX_BYTES = 96000; // a 60,000-character question and a full answer both reach the follow-up
const EXPLICIT = /(?:under|at most|maximum(?: of)?|no more than|within|keep (?:it|the answer) (?:to|below))\s+(\d+)\s+words\b/i;
const NARROW = /\b(?:compar(?:e|es|ed|ing|ison)|similar|peers?|competitors?|(?:compan(?:y|ies)|stocks?|firms?|names?|businesses|alternatives?) like|lookalikes?|(?:large|mid|small|micro|nano)[- ]?caps?|versus|vs\.?|portfolio|screen(?:er|ing)?|rank|best|top\s+\d|revenue|sales|margin|earnings|eps|income|profit|p\/e|price|market cap|valuation|multiple|dividend|buyback|debt|cash flow|fcf|ratio|yield|volume|beta|volatility|quarter|q[1-4]|fy\s?\d|annual|results|10-k|10-q|8-k|prospectus|insider|governance|esg|risk factor|segments?|guidance|outlook|brief|concise|employees?|headcount|workforce|capex|tax|ffo|affo|arr|roe|roa|backlog)\b/i;
// A request to model a trade is its own kind of answer: levels, size and
// protection for the trade that was asked for, never a company overview.
const TRADE = /\b(?:(?:swing|day|position|short[- ]term|long[- ]term|options?)\s+trad(?:e|es|ing)|trade\s+(?:idea|setup|set-up|plan)|(?:model|make|build|plan|structure|set up|give me|create|design|show me)\b[^.?!]{0,40}\btrades?\b|stop[- ]?loss|(?:entry|exit) (?:point|price|level)s?|downside protection|protective (?:put|call)|position siz(?:e|ing)|hedge (?:my|a|an|the|this)|risk[- /]reward)\b/i;
// A question that opens by asking something particular is answered as asked.
// Shipped 2026-10-05 without this: once a tool call had named a company, any
// question typed without punctuation ("who is the ceo of amd", "what is the
// unemployment rate") was replaced by the full company report.
const SPECIFIC = /^(?:why|who|whom|whose|when|where|which|should|shall|can|could|will|would|did|does|do|is|are|was|were|has|have|had|how (?:much|many|long|often|did|does|do|will|would|can|could|to|far|big|fast))\b/i;
const REPORT_WORDS = /\b(?:business|overview|analy[sz]e|analysis|report|tell me about|deep dive|in.depth)\b/i;
const NOT_TICKERS = new Set('a an and the my me it its this that these those today now any all some one two trade trades stock stocks share shares long short term swing day week month year bank banks tech gold oil cash bond bonds fund funds etf etfs market markets option options put puts call calls buy sell hold risk plan idea setup with for on in of at to from by or not no yes please make model build give show what how why who new old big small good bad best top us usa uk eu fed gdp cpi ai ev'.split(' '));
let registry;
// Correct only narrative words in a story-request phrase. Do not fuzzy-match
// company identities or turn stock/price-history lookups into company stories.
function narrativeQuestion(question) {
    return String(question || '').replace(/\b(?:the|thes|a|an)\s+(?:stroy|storry|storey|stoy|stry|touy)\b/gi, 'the story')
        .replace(/\b(tell(?: me)?|write|create)\s+(?:stroy|storry|storey|stoy|stry|touy)\b/gi, '$1 story');
}
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
// What people type for the largest companies is often not the registered name:
// "google" is listed as Alphabet, "exxon" as ExxonMobil, and "apple" is also the
// first word of an unrelated REIT. Measured 2026-10-06: "google" resolved to a
// hedged fund, "exxon" to nothing, and "toyota", "shell" and "berkshire" each
// stopped to ask which listing was meant.
const COMMON_NAMES = {
    google: 'GOOGL', alphabet: 'GOOGL', facebook: 'META', meta: 'META', exxon: 'XOM', 'exxon mobil': 'XOM', exxonmobil: 'XOM',
    jpmorgan: 'JPM', 'j p morgan': 'JPM', 'jp morgan': 'JPM', 'jpmorgan chase': 'JPM', berkshire: 'BRK.B', 'berkshire hathaway': 'BRK.B',
    'bank of america': 'BAC', bofa: 'BAC', tsmc: 'TSM', 'taiwan semiconductor': 'TSM', coke: 'KO', 'coca cola': 'KO', mcdonalds: 'MCD',
    disney: 'DIS', walmart: 'WMT', 'at t': 'T', verizon: 'VZ', pepsi: 'PEP', pepsico: 'PEP', 'johnson johnson': 'JNJ', 'procter gamble': 'PG',
    lilly: 'LLY', 'eli lilly': 'LLY', goldman: 'GS', 'goldman sachs': 'GS', 'morgan stanley': 'MS', 'wells fargo': 'WFC', citi: 'C',
    citigroup: 'C', chevron: 'CVX', 'home depot': 'HD', 'general electric': 'GE', 'general motors': 'GM', ford: 'F', ibm: 'IBM', '3m': 'MMM',
    nvidia: 'NVDA', tesla: 'TSLA', apple: 'AAPL', amazon: 'AMZN', microsoft: 'MSFT', netflix: 'NFLX', intel: 'INTC', broadcom: 'AVGO',
    visa: 'V', mastercard: 'MA', costco: 'COST', oracle: 'ORCL', salesforce: 'CRM', adobe: 'ADBE', paypal: 'PYPL', uber: 'UBER', boeing: 'BA',
    starbucks: 'SBUX', nike: 'NKE', pfizer: 'PFE', merck: 'MRK', abbvie: 'ABBV', unitedhealth: 'UNH', toyota: 'TM', shell: 'SHEL',
    'novo nordisk': 'NVO', astrazeneca: 'AZN', alibaba: 'BABA', sony: 'SONY', micron: 'MU', caterpillar: 'CAT', robinhood: 'HOOD',
    palantir: 'PLTR', coinbase: 'COIN', booking: 'BKNG', 'booking holdings': 'BKNG', honeywell: 'HON', lockheed: 'LMT', 'lockheed martin': 'LMT'
};
// Several listings can carry one company name: a hedged or leveraged product
// built on the shares, or a second share class. Neither is a reason to stop and
// ask — the operating company's own most-traded listing is what was meant.
const DERIVED_PRODUCT = /hedged|leverag|\b[1-3]x\b|\binverse\b|\bETF\b|\bETN\b|daily target|option income|yield ?max/i;
const PRIMARY_CLASS = { 'BRK-A': 'BRK.B', 'BRK.A': 'BRK.B', GOOG: 'GOOGL' };
function narrow(matches) {
    if (matches.length < 2) return matches;
    const own = matches.filter(c => (c.securityType || 'stock') === 'stock' && !DERIVED_PRODUCT.test((c.securityName || '') + ' ' + (c.name || '')));
    const list = own.length ? own : matches;
    if (list.length > 1 && list.every(c => c.cik) && new Set(list.map(c => c.cik)).size === 1) {
        const preferred = list.find(c => Object.values(PRIMARY_CLASS).includes(c.symbol) && list.some(o => PRIMARY_CLASS[o.symbol] === c.symbol));
        return [preferred || list.slice().sort((a, b) => a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol))[0]];
    }
    return list;
}
function resolve(question, companies = listings()) {
    const subject = narrativeQuestion(question).replace(EXPLICIT, '').trim().replace(/[?.!,]+$/g, '')
        .replace(/^(?:please\s+)?(?:tell me about|what do you think (?:of|about)|give me (?:an? )?(?:overview|report|analysis) (?:of|on)|how is|what does|analy[sz]e|explain)\s+/i, '')
        .replace(/^(?:please\s+)?(?:tell(?: me)?|write|create|give me)\s+(?:(?:the|a|an|full|long|detailed|company)\s+)*(?:story|history|narrative|biography|chronicle)\s+(?:(?:of|about|behind|for)\s+)?/i, '')
        .replace(/^(?:please\s+)?(?:tell(?: me)?|write|create)\s+(?:the\s+)?/i, '')
        .replace(/\s+(?:story|history|narrative|biography|chronicle)$/i, '')
        .replace(/\s+(?:doing|do|please|stock|company)$/i, '').trim();
    const symbol = require('./symbol-resolver').normalizeTicker(subject.replace(/^\$/, ''));
    let matches = companies.filter(c => require('./symbol-resolver').normalizeTicker(c.symbol) === symbol);
    const key = nameKey(subject);
    if (!matches.length && COMMON_NAMES[key]) matches = companies.filter(c => c.symbol === COMMON_NAMES[key]);
    if (!matches.length && key) matches = narrow(companies.filter(c => nameKey(c.name) === key));
    if (!matches.length && key.length >= 3) matches = narrow(companies.filter(c => nameKey(c.name).startsWith(key + ' ')));
    return { subject, matches, bare: matches.length > 0 };
}
// A ticker-shaped word the user typed that no listing carries, with the
// nearest real symbols. It is a prompt hint, never a substitution: on
// 2026-10-10 "make a swing trade for frgth" was answered about another company.
function unknownTicker(question, companies = listings()) {
    const q = String(question || '').trim().replace(/[?.!,]+$/g, '');
    const words = q.split(/\s+/);
    const candidates = words.length === 1 ? [words[0]] : [...q.matchAll(/\b(?:for|on|in|of|buy|sell|short|long)\s+\$?([A-Za-z]{2,5})\b/gi)].map(m => m[1]);
    const explicit = [...q.matchAll(/\$([A-Za-z]{1,5})\b/g)].map(m => m[1]);
    for (const word of [...explicit, ...candidates]) {
        const typed = word.toUpperCase();
        if (NOT_TICKERS.has(word.toLowerCase()) || resolve(word, companies).matches.length) continue;
        const nearest = require('./ask-trade-model').nearestListings(typed, 3, companies);
        if (explicit.includes(word) || nearest.length || words.length === 1) return { typed, nearest };
    }
    return null;
}
function select(question = '', mode = 'analyst', options = {}) {
    const q = narrativeQuestion(question).trim(), identity = resolve(q, options.companies);
    const requested = q.match(EXPLICIT), explicitWords = requested ? Number(requested[1]) : null;
    const company = options.company || (identity.matches.length === 1 ? identity.matches[0] : null);
    const ambiguous = identity.matches.length > 1;
    const fund = company && ['etf', 'mutual_fund', 'closed_end_fund'].includes(company.securityType);
    const trade = TRADE.test(q) && !ambiguous;
    const open = !trade && (identity.bare || (!SPECIFIC.test(q) && !NARROW.test(q) && REPORT_WORDS.test(q)));
    const story = (/\b(?:story|stories|storytelling|narrative|chronicle|biography)\b/i.test(q) ||
        (identity.bare && /\bhistory\b/i.test(q))) && !fund && !ambiguous;
    const full = !!company && company.securityType === 'stock' && (open || story) && !ambiguous;
    const kind = ambiguous ? 'listing_choice' : trade ? 'trade' : fund ? 'fund' : full ? 'company_report' : 'focused';
    const maxWords = explicitWords !== null ? Math.min(explicitWords,1600) : 1600;
    return { version: VERSION, kind, mode: mode === 'normal' ? 'normal' : 'analyst',
        company, choices: ambiguous ? identity.matches.map(c => ({ symbol: c.symbol, name: c.name, exchange: c.exchange })) : [],
        story, targetWords: null,
        maxWords, ceiling: maxWords,
        explicitWordLimit: explicitWords !== null, tableRows: full ? 70 : 40,
        unknownTicker: company || ambiguous ? null : unknownTicker(q, options.companies),
        visualRequired: !!company && !ambiguous && !trade && !/\b(?:no|without)\s+(?:extra\s+history\s+or\s+)?(?:chart|visual)/i.test(q) && !(explicitWords !== null && explicitWords < 40),
        annualPeriods: full ? 5 : null, quarterlyPeriods: full ? 4 : null };
}
function missingResearch(policy, used) {
    if (policy.kind !== 'company_report' || (policy.explicitWordLimit && !policy.story)) return [];
    const symbol = policy.company.symbol;
    const required = policy.story ? [
        {tool:'get_financials',args:{symbol,statement:'income',basis:'annual',limit:5}},
        {tool:'get_key_points',args:{symbol}}
    ] : [
        ...['income', 'balance', 'cash'].map(statement => ({ tool: 'get_financials', args: { symbol, statement, basis: 'annual', limit: 5 } })),
        { tool: 'get_financials', args: { symbol, statement: 'income', basis: 'quarterly', limit: 4 } },
        ...['annual', 'quarterly'].map(basis => ({ tool: 'get_ratios_history', args: { symbol, basis, limit: basis === 'annual' ? 5 : 4 } })),
        ...['get_peer_context', 'get_segments', 'get_quote', 'get_filing_diff', 'get_key_points'].map(tool => ({ tool, args: { symbol } }))
    ];
    // An attempted retrieval, including an honest failure, satisfies the fetch
    // requirement. It does not make the missing observations available.
    return required.filter(r => !used.some(t => t.tool === r.tool && String(t.args?.symbol || '').toUpperCase() === symbol &&
        (!r.args.statement || t.args.statement === r.args.statement) && (!r.args.basis || (t.args.basis || 'annual') === r.args.basis) &&
        (!r.args.limit || Number(t.args.limit ?? (r.tool === 'get_financials' ? 5 : 10)) >= r.args.limit)));
}
function supplementalNeeds(policy, results) {
    if (policy.kind !== 'company_report' || (policy.explicitWordLimit && !policy.story)) return null;
    const fields = new Set(), sections = new Set();
    for (const basis of policy.story ? ['annual'] : ['annual', 'quarterly']) {
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
    if (policy.kind !== 'company_report' || policy.explicitWordLimit || policy.story) return [];
    const financial = results.filter(r => r.tool === 'get_financials' && r.result?.statement === 'income');
    const supplements = results.flatMap(r => r.result?.supplementalObservations || []).filter(f => ['totalRevenue','netIncome'].includes(f.field) && f.state === 'available' && require('./company-observations').validSupplement(f,f.issuer));
    if (!financial.some(r => r.result?.observations?.length) && !supplements.length) return []; // A bounded search may leave no history.
    const issues = [], rows = (String(text).match(/^\s*\|.*$/gm) || []).join('\n');
    const availableDates = {};
    for (const basis of ['annual','quarterly']) {
        const observations = financial.find(r => String(r.result?.basis || '').startsWith(basis))?.result?.observations || [];
        const dates = [...new Set(observations.length ? observations.map(o => o.periodEnd) : supplements.filter(f => (f.historyBasis || f.basis) === basis).map(f => f.periodEnd))].sort().reverse().slice(0, basis === 'annual' ? policy.annualPeriods : policy.quarterlyPeriods);
        availableDates[basis] = dates;
        if (dates.some(date => !rows.includes(date))) issues.push(`The full report needs its available ${basis} financial periods in a Markdown table with actual fiscal period ends. Keep exact supplied values; never fill a period from memory.`);
    }
    const sections = coverage(text);
    if (rows) {
        if (availableDates.annual.some(date => rows.includes(date))) sections.annual = true;
        if (availableDates.quarterly.some(date => rows.includes(date))) sections.quarters = true;
    }
    const missing = Object.entries(sections).filter(([,present]) => !present).map(([section]) => section);
    if (missing.length) issues.push('The full report lacks these requested topics: ' + missing.join(', ') + '. Cover each one the supplied evidence supports and leave out any it does not — never write about what is missing. Choose your own headings, layout and reading order; keep the requested The read and Next markers.');
    return issues;
}
const TRADE_PROMPT = 'TRADE REQUEST: the user wants a trade modelled, not a company report. Call model_trade for the symbol with the horizon the user named (swing, short_term or long_term; swing when none is named), their direction, and their account size and risk percentage when given. Pass downside_protection=false ONLY when the user explicitly said they do not want protection; otherwise every trade carries protection. Answer with: the setup in one or two sentences; a Level | Price table (entry zone, stop, each target with its reward-to-risk); the position size; and the protection — the stop order, and the option when model_trade found one, with its expiry, cost and maximum loss. Use only numbers model_trade returned, and give the price date once. A short context paragraph from get_quote or search_web is welcome when it matters to the trade (results date, recent news); do not write a company overview. Honour any other wish the user stated (a maximum loss, a holding period, no options, no shorting). BROKER: when the user has named their broker (in this message, earlier in the conversation or in MEMORY), use search_web and fetch_page to check what that broker offers for this asset — whether the symbol can be traded there, options, short selling, fractional shares, and stop, stop-limit, trailing-stop or bracket orders — and write the order steps only from what it offers, naming the page you read. If it does not offer the protective option, use the stop and say so. When no broker is known, give the full trade anyway and close with one line asking which broker they use so the order steps can be matched to it. A closing disclaimer is added for you; do not write one.';
function prompt(policy) {
    return `SELECTED ANSWER POLICY: ${policy.kind}; ${policy.explicitWordLimit ? 'strict requested' : 'default'} prose limit ${policy.maxWords} words; choose the length needed for a useful answer, without a minimum or preset target. Focused lookups stay focused; do not pad an answer to reach the ceiling. Markdown tables and chart JSON have separate budgets (${policy.tableRows} table rows). ${policy.company ? `Resolved listing: ${policy.company.name} (${policy.company.symbol}), ${policy.company.securityType}.` : 'Resolve the listing and instrument before choosing company or fund tools.'}
${policy.unknownTicker ? `UNKNOWN SYMBOL: the user typed "${policy.unknownTicker.typed}", which is not a listed symbol here.${policy.unknownTicker.nearest.length ? ' Nearest listings: ' + policy.unknownTicker.nearest.map(c => `${c.symbol} (${c.name})`).join(', ') + '.' : ''} If it was meant as a ticker, say plainly that it was not found${policy.unknownTicker.nearest.length === 1 ? ', then answer the question for the nearest listing and label it as the nearest match' : policy.unknownTicker.nearest.length ? ' and ask which of the nearest listings was meant' : ''}. Never answer about a different company the user did not name.\n` : ''}${policy.kind === 'trade' ? TRADE_PROMPT + '\n' : ''}${policy.story ? 'COMPANY STORY: tell a source-backed chronological narrative with chapters or eras and an engaging explanation of business turning points. Use as many words as the story needs within the selected ceiling. The engine supplies annual financial history, original business context and an older annual-document attempt before generation; reuse those pulls. A stock quote is not company-history evidence and a price receipt does not answer a story request. Founding dates, leadership changes, product launches, acquisitions, near-bankruptcy and turnaround claims require retrieved narrative that actually establishes them; never recall an unsupported early era from memory. Use search_filings/search_web and fetch_page within their existing budgets when the supplied business context lacks the requested historical eras; read original issuer/history pages before making historical claims. If one historical era cannot be sourced, tell the supported parts and name that specific gap. Tables are optional; use compatible supplied financial history for a meaningful visual when available. Retrieve requested historical periods and original issuer/history sources as needed; disclose unsupported eras and never fill them from memory. Use third person by default. If a real person is requested as narrator, label the perspective as a dramatization; invented dialogue is never an authentic quote. Keep supplied facts, ratios, dates and source distinctions exact. A missing disclosure can justify a shorter story. Finish with The read and one Next question. NO PROCESS TALK — the reader asked about the company, not about this research. Never write a section, note, table row or sentence about gaps, what could not be sourced, retrieved or extracted, tools, budgets, sessions, context limits or data availability, and never open with a recency, freshness or caveat note. A part with no supplied evidence is left out entirely — no heading, no apology, no list of what is missing. State each period by its date and let the dates speak; do not explain how recent the data is. A single metric with a business reason for being absent may read "n/a" with that reason (negative earnings, no dividend paid) — never a retrieval reason; a metric that was simply not supplied is left out of the table.' : ''}
EVIDENCE: each statement and ratio result gives observations with raw values in the reported currency for an exact periodEnd, and a table of the same values scaled as its units line says. Use the raw observation values, with their fiscal dates, for charts and calculations; quote printed table figures exactly. supplementalObservations are provider figures: name their sourceName and date beside them. Filing links are added to the answer for you.
VISUAL FREEDOM: ${policy.kind === 'company_report' && !policy.story && !policy.explicitWordLimit ? 'the report format fixes the headings and their order; choose the visuals within it' : 'choose your own headings, reading order and visual layout'}. Choose any supported line chart, horizontal or grouped bars, faceted bars, eligible revenue Sankey or Markdown table that helps explain the evidence. Include a meaningful chart when supplied observations support it; a simple lookup can use a single-value bar. Choose the number and placement of visuals to suit the question. Preserve readable scales, exact periods, currencies, definitions and attribution. A financial report includes at least one annual trend visual when compatible history exists. Explain the gap when no supported chart can be drawn. Never invent data to make a visual.`;
}
function historyMessages(history, n = 8, maxBytes = HISTORY_MAX_BYTES) {
    let remaining = Math.min(HISTORY_MAX_BYTES,maxBytes);
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
module.exports = { TRADE, unknownTicker, VERSION, ANSWER_MAX_CHARS, QUESTION_MAX_CHARS, HISTORY_MAX_BYTES, select, prompt, resolve, coverage, historyMessages, missingResearch, supplementalNeeds, reportIssues, invalidate: () => { registry = null; } };
