'use strict';
// Which tickers a question named that the answer never looked up. On
// 2026-10-1x a customer pasted a ten-question checklist over seven tickers;
// the run closed after three and they had to type "continue" to get the rest.
// ask() turns the leftover tickers into a one-tap "Next:" line.

const stockUniverse = require('./stock-universe');

// Upper-case words a research question uses that are also listed symbols
// (AI, ON, IT, ALL, NOW ...) or common finance shorthand. Never read as tickers
// unless written with a $.
const NOT_TICKERS = new Set(('A I AI ALL AND ANY ARE AT BE BIG CAN CEO CFO CAGR COO CTO DCF DD EBIT EBITDA EPS ETF EU EV FCF FOR FX GAAP '
    + 'GDP HAS IPO IRR IS IT K NAV NEW NOT NOW OF ON ONE OR OUT PE PEG Q QOQ RSI ROA ROE ROI ROIC SEC SG SO TA TTM UK US USA USD VS WACC YOY YTD')
    .split(' '));
const MIN_NAMED = 3; // a single- or two-company question has no checklist to continue

function namedTickers(question, lookup = stockUniverse.lookup) {
    const seen = new Set(), out = [];
    for (const m of String(question || '').matchAll(/(\$)?\b([A-Z]{1,5}(?:\.[A-Z])?)\b/g)) {
        const [, dollar, word] = m;
        if (seen.has(word) || (!dollar && (word.length < 2 || NOT_TICKERS.has(word)))) continue;
        seen.add(word);
        if (lookup(word)) out.push(word);
    }
    return out;
}

// Every string a successful tool call was given, upper-cased: covers symbol,
// ticker, symbols[], tickers[] and the compare tools' a/b without listing them.
function lookedUp(toolsUsed) {
    const found = new Set();
    const walk = (v) => {
        if (typeof v === 'string') found.add(v.trim().toUpperCase());
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const t of toolsUsed || []) if (t && t.ok !== false) walk(t.args);
    return found;
}

function uncovered(question, toolsUsed, lookup) {
    const named = namedTickers(question, lookup);
    if (named.length < MIN_NAMED) return [];
    const done = lookedUp(toolsUsed), left = named.filter((s) => !done.has(s));
    // nothing looked up at all is a different failure (no research), not a cut-off run
    return left.length && left.length < named.length ? left : [];
}

const nextLine = (symbols) => `> Next: Continue with ${symbols.join(', ')}: the same questions, answered in the language I asked in.`;

// Checklist parts that one tool answers for each company. The same seven-company
// checklist (2026-10-24) answered "who is their management team" from Form 4
// trades and said proxy data was "not available" for all seven without once
// calling get_governance, and its dividend part skipped three of them.
const PART_TOOLS = [
    { re: /\bmanagement\b|\bboard of directors\b|\bexecutives?\b|\bleadership\b|zarząd|kierownictw/i, tool: 'get_governance', part: 'management' },
    { re: /dividend|dywidend/i, tool: 'get_health_checks', part: 'dividend' },
    // Its "how is the stock price doing" part said three companies had no price
    // history in the cache, without calling get_price_history for them.
    { re: /(?:stock|share) price|price (?:is )?doing|cen[aęy] akcji|kurs akcji|notowani/i, tool: 'get_price_history', part: 'share price performance' },
    { re: /what does (?:the|this|each) company do|business model|czym (?:się )?zajmuj/i, tool: 'get_key_points', part: 'what the company does' }
];

// The parts of a question naming 3 or more companies whose tool has not been
// tried for every one of them. A call that failed was tried.
function missingResearch(question, toolsUsed, lookup) {
    const named = namedTickers(question, lookup);
    if (named.length < MIN_NAMED) return [];
    const out = [];
    for (const p of PART_TOOLS) {
        if (!p.re.test(question)) continue;
        const tried = new Set((toolsUsed || []).filter((t) => t && t.tool === p.tool).map((t) => String((t.args && t.args.symbol) || '').toUpperCase()));
        const left = named.filter((s) => !tried.has(s));
        if (left.length) out.push({ tool: p.tool, part: p.part, symbols: left });
    }
    return out;
}

const researchDirective = (missing) => 'ANSWER NOT RELEASED: parts of the question have not been researched for every company it names. Call each tool below for each company listed, in one batch, then write the complete answer again from the start (the user has not seen the draft). A company the tool has no data for is named as a gap in that part; never say data is unavailable for a company you have not called the tool for.\n'
    + missing.map((m) => `- ${m.part}: ${m.tool} for ${m.symbols.join(', ')}`).join('\n');

module.exports = { namedTickers, lookedUp, uncovered, nextLine, missingResearch, researchDirective, NOT_TICKERS };
