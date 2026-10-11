'use strict';

// Tool: query_universe — any formula over the filed statement lines of every
// screenable company.
//
// screen_universe filters on a fixed set of precomputed columns. A condition
// outside that set ("over 35% revenue growth across the last four quarters",
// "share-based pay under 5% of revenue") could not be tested at all, and the
// answer was written from the nearest column there was. Here the caller writes
// the formula, so no figure has to be built in advance for a question to be
// answerable.
//
// Formulas are parsed and walked here; nothing is handed to eval.

const screenFacts = require('./screen-facts');

const MAX_COLUMNS = 12, MAX_FORMULA_CHARS = 400, MAX_LIMIT = 40, DEFAULT_LIMIT = 15;
const STALE_QUARTER_DAYS = 200, STALE_YEAR_DAYS = 500;

// Per-company figures that are not statement lines; they come from the screen
// row (daily price cache), so they are point-in-time and USD.
const SCALARS = {
    market_cap: r => (num(r.marketCapB) === null ? null : r.marketCapB * 1e9),
    market_cap_b: r => num(r.marketCapB),
    price: r => num(r.price),
    pe: r => num(r.pe),
    dividend_yield_pct: r => num(r.divYieldPct),
    profitable_years_10: r => num(r.profitableYears10)
};

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// ---------- parser ----------
function tokenize(src) {
    const out = [], re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|==|!=|&&|\|\||[-+*/^(),<>=!]))/y;
    let i = 0;
    while (i < src.length) {
        if (/^\s*$/.test(src.slice(i))) break;
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m) throw new Error(`Unexpected character "${src.slice(i).trim()[0]}"`);
        i = re.lastIndex;
        if (m[1] !== undefined) out.push({ k: 'num', v: Number(m[1]) });
        else if (m[2] !== undefined) {
            const word = m[2].toLowerCase();
            out.push(['and', 'or', 'not'].includes(word) ? { k: 'op', v: word } : { k: 'id', v: m[2] });
        } else out.push({ k: 'op', v: m[3] === '&&' ? 'and' : m[3] === '||' ? 'or' : m[3] === '!' ? 'not' : m[3] === '=' ? '==' : m[3] });
    }
    return out;
}

function parse(src) {
    const text = String(src || '').trim();
    if (!text) throw new Error('Empty formula');
    if (text.length > MAX_FORMULA_CHARS) throw new Error(`Formula is longer than ${MAX_FORMULA_CHARS} characters`);
    const t = tokenize(text);
    let i = 0;
    const peek = v => t[i] && t[i].k === 'op' && t[i].v === v;
    const take = v => { if (peek(v)) { i++; return true; } return false; };
    const bin = (next, ops) => () => {
        let a = next();
        for (;;) {
            const op = ops.find(peek);
            if (!op) return a;
            i++;
            a = { t: 'bin', op, a, b: next() };
        }
    };
    const primary = () => {
        const tok = t[i++];
        if (!tok) throw new Error('Formula ends early');
        if (tok.k === 'num') return { t: 'num', v: tok.v };
        if (tok.k === 'id') {
            if (!take('(')) return { t: 'id', name: tok.v };
            const args = [];
            if (!take(')')) {
                do { args.push(or()); } while (take(','));
                if (!take(')')) throw new Error(`Missing ")" after ${tok.v}(`);
            }
            return { t: 'call', name: tok.v.toLowerCase(), args };
        }
        if (tok.v === '(') { const e = or(); if (!take(')')) throw new Error('Missing ")"'); return e; }
        throw new Error(`Unexpected "${tok.v}"`);
    };
    const power = () => { const a = primary(); return take('^') ? { t: 'bin', op: '^', a, b: unary() } : a; };
    const unary = () => (take('-') ? { t: 'neg', a: unary() } : take('+') ? unary() : power());
    const mul = bin(unary, ['*', '/']);
    const add = bin(mul, ['+', '-']);
    const cmp = bin(add, ['>=', '<=', '==', '!=', '>', '<']);
    const not = () => (take('not') ? { t: 'not', a: not() } : cmp());
    const and = bin(not, ['and']);
    const or = bin(and, ['or']);
    const ast = or();
    if (i < t.length) throw new Error(`Unexpected "${t[i].v}"`);
    return ast;
}

// ---------- evaluator ----------
// env: { fact, row, columns: Map, period: null | { basis: 'q'|'a', i } }
const PERIOD_FUNCS = { q: 'q', fy: 'a' };
const AGG = {
    sum: v => v.reduce((a, b) => a + b, 0),
    avg: v => v.reduce((a, b) => a + b, 0) / v.length,
    min: v => Math.min(...v),
    max: v => Math.max(...v)
};
const AGG_FUNCS = {};
for (const kind of Object.keys(AGG)) { AGG_FUNCS[kind + '_q'] = [kind, 'q']; AGG_FUNCS[kind + '_fy'] = [kind, 'a']; }

function constant(node, label) {
    if (!node) return null;
    if (node.t !== 'num' || !Number.isInteger(node.v) || node.v < 0 || node.v > 40) throw new Error(`${label} must be a whole number from 0 to 40`);
    return node.v;
}

function at(env, basis, i, node) {
    return evaluate(node, { ...env, period: { basis, i } });
}

function evaluate(node, env) {
    switch (node.t) {
        case 'num': return node.v;
        case 'neg': { const v = evaluate(node.a, env); return v === null ? null : -v; }
        case 'not': { const v = evaluate(node.a, env); return v === null ? null : !truthy(v); }
        case 'id': {
            const name = node.name;
            if (env.columns.has(name)) return env.columns.get(name);
            const key = name.toLowerCase();
            if (SCALARS[key]) return SCALARS[key](env.row);
            if (screenFacts.FIELDS[key]) {
                if (!env.period) throw new Error(`"${name}" is a statement line: say which period, e.g. q(${name}) for the latest quarter, fy(${name}) for the latest fiscal year or ttm(${name}) for the last four quarters`);
                const s = env.fact[env.period.basis];
                const v = s && s.f[key] ? s.f[key][env.period.i] : null;
                return v === undefined ? null : v;
            }
            throw new Error(`Unknown name "${name}"`);
        }
        case 'bin': {
            if (node.op === 'and' || node.op === 'or') {
                const a = evaluate(node.a, env), b = evaluate(node.b, env);
                const ta = a === null ? null : truthy(a), tb = b === null ? null : truthy(b);
                if (node.op === 'and') return ta === false || tb === false ? false : ta === null || tb === null ? null : true;
                return ta === true || tb === true ? true : ta === null || tb === null ? null : false;
            }
            const a = evaluate(node.a, env), b = evaluate(node.b, env);
            if (a === null || b === null || typeof a === 'boolean' || typeof b === 'boolean') return null;
            switch (node.op) {
                case '+': return a + b;
                case '-': return a - b;
                case '*': return a * b;
                case '/': return b === 0 ? null : a / b;
                case '^': { const v = Math.pow(a, b); return Number.isFinite(v) ? v : null; }
                case '>': return a > b;
                case '>=': return a >= b;
                case '<': return a < b;
                case '<=': return a <= b;
                case '==': return a === b;
                case '!=': return a !== b;
                default: throw new Error(`Unknown operator ${node.op}`);
            }
        }
        case 'call': return call(node, env);
        default: throw new Error('Malformed formula');
    }
}
function truthy(v) { return typeof v === 'boolean' ? v : v !== 0; }

function call(node, env) {
    const { name, args } = node;
    const need = (min, max = min) => { if (args.length < min || args.length > max) throw new Error(`${name}() takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? '' : 's'}`); };
    const numbers = () => { const v = args.map(a => evaluate(a, env)); return v.some(x => x === null || typeof x === 'boolean') ? null : v; };
    if (PERIOD_FUNCS[name]) {
        need(1, 2);
        return at(env, PERIOD_FUNCS[name], constant(args[1], 'The period offset') || 0, args[0]);
    }
    if (name === 'ttm') {
        need(1, 2);
        const k = constant(args[1], 'The quarter offset') || 0, v = [];
        for (let j = 0; j < 4; j++) { const x = at(env, 'q', k + j, args[0]); if (x === null || typeof x === 'boolean') return null; v.push(x); }
        return AGG.sum(v);
    }
    if (AGG_FUNCS[name]) {
        need(2, 3);
        const [kind, basis] = AGG_FUNCS[name], n = constant(args[1], 'The number of periods'), k = constant(args[2], 'The period offset') || 0, v = [];
        if (!n) throw new Error(`${name}() needs at least one period`);
        for (let j = 0; j < n; j++) { const x = at(env, basis, k + j, args[0]); if (x === null) return null; v.push(typeof x === 'boolean' ? Number(x) : x); }
        return AGG[kind](v);
    }
    if (name === 'lag') {
        need(2);
        if (!env.period) throw new Error('lag() is used inside q(), fy(), ttm() or a *_q / *_fy function');
        return at(env, env.period.basis, env.period.i + constant(args[1], 'The lag'), args[0]);
    }
    if (name === 'growth_pct') { need(2); const v = numbers(); return v && v[1] > 0 ? (v[0] / v[1] - 1) * 100 : null; }
    if (name === 'pct') { need(2); const v = numbers(); return v && v[1] > 0 ? v[0] / v[1] * 100 : null; }
    if (name === 'cagr_pct') { need(3); const v = numbers(); return v && v[0] > 0 && v[1] > 0 && v[2] > 0 ? (Math.pow(v[0] / v[1], 1 / v[2]) - 1) * 100 : null; }
    if (name === 'abs') { need(1); const v = numbers(); return v ? Math.abs(v[0]) : null; }
    if (name === 'min' || name === 'max') { if (!args.length) throw new Error(`${name}() needs arguments`); const v = numbers(); return v ? Math[name](...v) : null; }
    if (name === 'coalesce') { for (const a of args) { const v = evaluate(a, env); if (v !== null) return v; } return null; }
    throw new Error(`Unknown function ${name}()`);
}

// Top-level "and" parts of a condition, so a company that misses can be told
// which part it missed.
function clauses(node) { return node.t === 'bin' && node.op === 'and' ? [...clauses(node.a), ...clauses(node.b)] : [node]; }
function show(node) {
    switch (node.t) {
        case 'num': return String(node.v);
        case 'id': return node.name;
        case 'neg': return '-' + show(node.a);
        case 'not': return 'not ' + show(node.a);
        case 'call': return `${node.name}(${node.args.map(show).join(', ')})`;
        default: return `${show(node.a)} ${node.op} ${show(node.b)}`;
    }
}

const HELP = 'Statement lines: ' + Object.keys(screenFacts.FIELDS).join(', ') + '. '
    + 'Periods: q(line, k) = the quarter k quarters back (k=0 latest); fy(line, k) = the fiscal year k years back; ttm(line, k) = the four quarters starting k back, summed (ttm(revenue) against ttm(revenue, 4) is the last four quarters against the four before). '
    + `Stored: the newest ${screenFacts.QUARTERS} consecutive quarters and ${screenFacts.YEARS} consecutive fiscal years. `
    + 'Several periods: sum_q, avg_q, min_q, max_q (formula, n, k) and the same with _fy; lag(line, k) inside them is the value k periods earlier, so min_q(growth_pct(revenue, lag(revenue, 4)), 4) is the weakest year-on-year growth of the last four quarters. '
    + 'Maths: + - * / ^, growth_pct(new, old), pct(part, whole), cagr_pct(new, old, years), abs, min, max, coalesce. Conditions: > >= < <= == !=, and, or, not. '
    + 'Per company (price cache, USD): ' + Object.keys(SCALARS).join(', ') + '. Outflows (capex, buybacks, dividends_paid) may be filed with either sign: wrap them in abs().';

function fmt(v, unit) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (unit === 'usd') return String(Math.round(v));
    if (unit === 'percent') return v.toFixed(1);
    return Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Number(v.toPrecision(4)));
}
const cell = v => String(v === null || v === undefined ? '' : v).replace(/[|\n]/g, ' ');

// screenRows: the live screen index rows (name, sector, price cache).
function query(args, { screenRows, facts = screenFacts.load(), sectorMatches = null } = {}) {
    const a = args || {};
    if (!facts) return { error: 'The statement table is not available on this server right now. Use screen_universe and get_financials instead, and say which condition that leaves untested.' };
    const specs = (Array.isArray(a.columns) ? a.columns : []).slice(0, MAX_COLUMNS);
    const columns = [];
    try {
        for (const spec of specs) {
            const name = String(spec?.name || '').trim(), formula = String(spec?.formula || spec?.expr || spec?.expression || '').trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name)) throw new Error(`Column name "${name}" must be letters, digits and underscores`);
            if (screenFacts.FIELDS[name.toLowerCase()] || SCALARS[name.toLowerCase()]) throw new Error(`Column name "${name}" is already a statement line; choose another name`);
            if (columns.some(c => c.name === name)) throw new Error(`Column "${name}" is defined twice`);
            const unit = ['percent', 'usd', 'number'].includes(spec.unit) ? spec.unit
                : /pct\(|growth_pct|cagr_pct/.test(formula) || /pct|percent|growth|margin|yield/i.test(name) ? 'percent' : 'number';
            columns.push({ name, formula, unit, ast: parse(formula) });
        }
    } catch (e) { return { error: `${e.message}.`, help: HELP }; }
    let where = null;
    try { where = a.where ? parse(a.where) : null; } catch (e) { return { error: `where: ${e.message}.`, help: HELP }; }
    if (!columns.length && !where) return { error: 'Give at least one column formula or a where condition.', help: HELP };
    const parts = where ? clauses(where) : [];

    const wanted = new Set((Array.isArray(a.symbols) ? a.symbols : String(a.symbols || '').split(/[\s,;/]+/))
        .map(s => String(s).trim().toUpperCase()).filter(Boolean).flatMap(s => [s, s.replace(/\./g, '-'), s.replace(/-/g, '.')]));
    const asOf = Date.parse(facts.asOf) || Date.now();
    let universe = 0, stale = 0, evaluated = 0;
    const matched = [], near = [], blanks = new Map(columns.map(c => [c.name, 0]));
    for (const row of screenRows || []) {
        const fact = facts.bySymbol.get(row.symbol);
        if (!fact) continue;
        if (wanted.size && !wanted.has(row.symbol)) continue;
        if (a.sector && sectorMatches && !sectorMatches(row.sector, a.sector)) continue;
        universe++;
        // A company that stopped filing does not have "a latest quarter".
        const lastQ = fact.q?.ends[0], lastA = fact.a?.ends[0];
        const old = lastQ ? (asOf - Date.parse(lastQ)) / 86400000 > STALE_QUARTER_DAYS : !lastA || (asOf - Date.parse(lastA)) / 86400000 > STALE_YEAR_DAYS;
        if (old && !a.include_stale && !wanted.size) { stale++; continue; }
        evaluated++;
        const env = { fact, row, columns: new Map(), period: null };
        const values = {};
        try {
            for (const c of columns) {
                const v = evaluate(c.ast, env);
                env.columns.set(c.name, v); values[c.name] = v;
                if (v === null) blanks.set(c.name, blanks.get(c.name) + 1);
            }
            const results = parts.map(part => evaluate(part, env));
            const failed = parts.filter((_, i) => results[i] !== true);
            const item = { row, fact, values, failed, untested: parts.filter((_, i) => results[i] === null) };
            if (!failed.length) matched.push(item);
            else if (parts.length > 1) near.push(item);
        } catch (e) { return { error: `${e.message}.`, help: HELP }; }
    }

    const sortKey = columns.some(c => c.name === a.sort_by) ? a.sort_by : null;
    const scalarSort = !sortKey && SCALARS[String(a.sort_by || '').toLowerCase()] ? SCALARS[String(a.sort_by).toLowerCase()] : null;
    const keyOf = item => (sortKey ? item.values[sortKey] : scalarSort ? scalarSort(item.row) : num(item.row.marketCapB));
    const dir = a.ascending ? 1 : -1;
    const order = (x, y) => {
        const p = keyOf(x), q = keyOf(y);
        if ((p === null) !== (q === null)) return p === null ? 1 : -1;
        return (p === null ? 0 : dir * (Number(p) - Number(q))) || String(x.row.symbol).localeCompare(String(y.row.symbol));
    };
    matched.sort(order);
    const limit = Math.min(Math.max(Number(a.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const top = matched.slice(0, limit);

    const header = ['symbol', 'name', 'sector', 'mktCap$B', 'latestQtr', 'latestFY', ...columns.map(c => c.name + (c.unit === 'percent' ? '%' : c.unit === 'usd' ? '$' : ''))];
    const line = item => [item.row.symbol, item.row.name, item.row.sector, num(item.row.marketCapB) === null ? '' : item.row.marketCapB.toFixed(1),
        item.fact.q?.ends[0] || '', item.fact.a?.ends[0] || '', ...columns.map(c => fmt(item.values[c.name], c.unit))].map(cell).join('|');
    const money = [], percentages = [];
    for (const item of top) {
        if (num(item.row.marketCapB) !== null) money.push(item.row.marketCapB * 1e9, Number(item.row.marketCapB.toFixed(1)) * 1e9);
        for (const c of columns) {
            const v = item.values[c.name];
            if (typeof v !== 'number') continue;
            if (c.unit === 'usd') money.push(v, Math.round(v));
            else percentages.push(v, Number(v.toFixed(1)), Number(v.toFixed(2)));
        }
    }
    const out = {
        universe: `${universe} US-listed companies with filed statements${wanted.size ? ' among the tickers named' : ''}`,
        evaluated, matched: matched.length, returned: top.length,
        ...(stale ? { skippedStale: `${stale} companies whose newest filed quarter is more than ${STALE_QUARTER_DAYS} days old were left out; pass include_stale=true to include them.` } : {}),
        columns: columns.map(c => ({ name: c.name, formula: c.formula, unit: c.unit, blankFor: blanks.get(c.name) })),
        ...(where ? { where: show(where) } : {}),
        table: [header.join('|'), ...top.map(line)].join('\n'),
        note: 'Every figure is computed from filed statements in each company\'s reporting currency for the periods named by latestQtr / latestFY; a blank means the company did not file a line the formula needs, and a blank never passes a condition. Market cap is from the daily price cache. Name the period whenever you cite a figure.'
    };
    // Nothing passed every part: show who came closest and what each missed,
    // so the condition is never quietly loosened to produce a list.
    if (!matched.length && near.length) {
        near.sort((x, y) => (x.failed.length - y.failed.length) || order(x, y));
        const closest = near.slice(0, Math.min(limit, 10));
        for (const item of closest) for (const c of columns) { const v = item.values[c.name]; if (typeof v === 'number' && c.unit !== 'usd') percentages.push(v, Number(v.toFixed(1)), Number(v.toFixed(2))); }
        out.closest = {
            note: 'No company passes every part of the condition. These pass the most parts; "misses" names each part a company fails ("untested" = it did not file a line that part needs). Say plainly that nothing passes everything before presenting any of them.',
            table: [header.concat('misses').join('|'), ...closest.map(item => line(item) + '|' + cell(item.failed.map(part => show(part) + (item.untested.includes(part) ? ' (untested)' : '')).join('; ')))].join('\n')
        };
    }
    out.claimable = { money: [...new Set(money)].map(value => ({ value, unit: 'USD' })), percentages: [...new Set(percentages)] };
    return out;
}

// The figures one company has for a set of formulas — what the harness uses to
// test an answer's own pick.
function valuesFor(symbol, formulas, { screenRows, facts = screenFacts.load() } = {}) {
    if (!facts) return null;
    const row = (screenRows || []).find(r => r.symbol === symbol), fact = facts.bySymbol.get(symbol);
    if (!row || !fact) return null;
    const env = { fact, row, columns: new Map(), period: null };
    return formulas.map(formula => { try { return evaluate(parse(formula), env); } catch (_) { return null; } });
}

const TOOL = {
    type: 'function',
    function: {
        name: 'query_universe',
        description: 'Compute ANY figure from the filed statements of every US-listed company at once, and filter and rank on it. Use it whenever the question sets a condition or wants a ranking that screen_universe has no ready column for — growth over the last four quarters, share-based pay as a share of revenue, buybacks, cash conversion, any ratio of any two lines over any period. You write the formulas; never replace the user\'s condition with a different metric because a column for it is missing. ' + HELP,
        parameters: {
            type: 'object',
            properties: {
                columns: {
                    type: 'array', description: `Up to ${MAX_COLUMNS} computed columns. A later column and the where condition may use an earlier column by name.`,
                    items: { type: 'object', properties: {
                        name: { type: 'string', description: 'Short name, letters/digits/underscores, e.g. rev_growth_4q' },
                        formula: { type: 'string', description: 'e.g. growth_pct(ttm(revenue), ttm(revenue, 4))' },
                        unit: { type: 'string', enum: ['percent', 'usd', 'number'] }
                    }, required: ['name', 'formula'] }
                },
                where: { type: 'string', description: 'Condition every returned company must pass, e.g. "rev_growth_4q > 35 and sbc_share < 5 and market_cap_b >= 2". A company with a blank in a part does not pass it.' },
                sort_by: { type: 'string', description: 'A column name (or market_cap_b, pe, price). Default: market cap.' },
                ascending: { type: 'boolean', description: 'Default false (largest first).' },
                limit: { type: 'integer', description: `Max ${MAX_LIMIT}, default ${DEFAULT_LIMIT}` },
                symbols: { type: 'array', items: { type: 'string' }, description: 'Restrict to these tickers — use it to compute the same figures for named companies, or to check a company against the user\'s conditions.' },
                sector: { type: 'string', description: 'Sector filter, e.g. Technology' },
                include_stale: { type: 'boolean', description: 'Include companies that have not filed a recent quarter.' }
            }
        }
    }
};

module.exports = { TOOL, HELP, parse, evaluate, query, valuesFor, show, clauses, SCALARS };
