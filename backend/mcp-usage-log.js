'use strict';

// The mcp_calls usage log — which tools, companies, metrics and filings
// connector users ask for, which come back empty, and where calls fail.
//
// WHY THIS EXISTS: the credit ledger records only a successful charged call,
// and only for a signed-in account. A keyless caller — the population the
// whole keyless tier exists to convert — left a stdout line and nothing else,
// and a refused call left nothing anywhere, so "what do people ask for before
// they pay" was unmeasurable. One structured row per tool call answers that
// for both callers.
//
// PRIVACY, the rule this file is built around: never store raw tool arguments,
// raw IPs, free-text questions or conversation content. Everything a call was
// "about" is reduced here to bounded structured facets — tickers, metric ids,
// form types, a section name, a search term, a topic category — before it is
// written. A question asked of ask_filings survives only as (topic, length).
// A keyless caller survives only as a salted monthly-rotating hash, so the IP
// is neither stored nor recoverable and cannot be joined across months.
//
// Everything here is fire-and-forget and never throws: usage logging must not
// be able to fail, delay or charge a connector call.

const crypto = require('node:crypto');

const COLLECTION = 'mcp_calls';
const RETENTION_DAYS = Number(process.env.MCP_USAGE_RETENTION_DAYS || 90);

// MCP_USAGE_LOG=false switches the whole log off (record writes nothing).
function enabled(env = process.env) {
    return String(env.MCP_USAGE_LOG ?? 'true').toLowerCase() !== 'false';
}

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// ---------------------------------------------------------------------------
// Caller identity — pseudonymous by construction
// ---------------------------------------------------------------------------

// A signed-in caller is a stable pseudonym of the account id (the report wants
// repeat behaviour). A keyless caller is a salted hash of the IP that rotates
// with the calendar month: the salt is secret, the month is in the digest, and
// the IP itself is never stored — so the row cannot be reversed to an address
// and cannot be followed past the month boundary. Connector traffic arrives
// from the AI platform's egress network anyway, which makes the per-visitor
// hash a per-connection pseudonym rather than a person.
function callerHash({ anonymous, userId, ip, now = new Date() } = {}) {
    if (!anonymous) {
        const id = String(userId == null ? '' : userId);
        if (!id) return null;
        return sha256Hex(`u:${id}`).slice(0, 16);
    }
    const addr = String(ip == null ? '' : ip);
    if (!addr) return null;
    const salt = process.env.MCP_USAGE_SALT || process.env.JWT_SECRET || 'mcp-usage';
    const month = now.toISOString().slice(0, 7);
    return sha256Hex(`a:${salt}:${month}:${addr}`).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Facets — what the call was about, never the raw arguments
// ---------------------------------------------------------------------------

// Ticker-shaped: what a ticker or a ticker list cell looks like. Anything
// longer or prose-shaped is a company name, which only ever reaches the log
// through a search tool's `term` facet.
const TICKERISH = /^[A-Z][A-Z0-9.\-]{0,11}$/;

function cleanTicker(value) {
    const s = String(value == null ? '' : value).trim().toUpperCase();
    return TICKERISH.test(s) ? s : null;
}

// The ask_filings topic classifier: a small keyword bucket per question, so
// "what do people ask about" is answerable without ever storing a question.
// Ordered: the first bucket whose pattern matches wins, so a specific reading
// (margins, cash flow, debt) beats the generic growth/risk vocabulary.
const TOPIC_PATTERNS = [
    ['valuation', /valuation|intrinsic|fair value|p\/e|price.to.(earnings|book|sales)|earnings multiple|multiple|expensive|cheap|overvalued|undervalued|priced/i],
    ['margins', /margin|gross profit|operating profit|profitability|unit economics|cost of (sales|revenue|goods)/i],
    ['cash_flow', /cash flow|free cash|operating cash|capex|capital expenditure|burn|fcf/i],
    ['debt_liquidity', /debt|leverage|liquidity|covenant|borrow|credit facility|insolven|working capital|cash position|balance sheet/i],
    ['capital_return', /buyback|repurchase|dividend|share count|shares outstanding|capital return|payout|stock split|dilution/i],
    ['guidance', /guidance|outlook|forecast|expect|anticipat|projection|full.year|next (quarter|year|fiscal)/i],
    ['segments', /segment|division|business unit|geograph|regional|product line|subsidiar|business line/i],
    ['comparison', /\bversus\b|\bvs\.?\b|compar(e|ed|ison|ing)|\brival\b|\bpeer\b|better than|worse than/i],
    ['accounting', /goodwill|impairment|write.?down|restructuring|accrual|deferred revenue|accounting|restat|one.time|non.gaap|\bgaap\b|audit/i],
    ['growth', /\bgrow(?:th|ing|s)?\b|\bgrew\b|declin|rose|increas|decreas|\bfell\b|\bdrop\b|shrunk|expand|cagr|momentum|trend|slow/i],
    ['risk', /risk|threat|litigation|lawsuit|regulat|competitive|competition|antitrust|fraud|downside|headwind/i]
];

function classifyTopic(question) {
    const text = String(question || '');
    for (const [topic, pattern] of TOPIC_PATTERNS) {
        if (pattern.test(text)) return topic;
    }
    return 'other';
}

function facetsFor(tool, args) {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const out = {};
    const toolName = String(tool || '');

    // Companies asked about: tickers only, bounded. A company name is dropped
    // unless it is ticker-shaped; a search tool's name input is kept as `term`
    // below instead, because it is research input, not conversation.
    const rawTickers = [];
    for (const v of [a.ticker, a.symbol, a.company]) {
        if (typeof v === 'string' && v.trim()) rawTickers.push(v.trim());
    }
    for (const v of [a.companies, a.tickers]) {
        const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
        for (const x of list) if (typeof x === 'string' && x.trim()) rawTickers.push(x.trim());
    }
    const tickers = [...new Set(rawTickers.map(cleanTicker).filter(Boolean))].slice(0, 10);
    if (tickers.length) out.tickers = tickers;

    // Metric ids asked for (never a metric VALUE — those live in the result).
    const rawMetrics = [];
    for (const v of [a.metrics, a.metric_ids]) {
        const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
        for (const x of list) if (typeof x === 'string' && x.trim()) rawMetrics.push(x.trim());
    }
    if (typeof a.metric === 'string' && a.metric.trim()) rawMetrics.push(a.metric.trim());
    const metrics = [...new Set(rawMetrics.map((s) => s.slice(0, 40)).filter(Boolean))].slice(0, 20);
    if (metrics.length) out.metrics = metrics;

    if (typeof a.period_type === 'string' && a.period_type.trim()) out.periodType = a.period_type.trim().slice(0, 20);
    const numeric = [a.periods, a.years, a.limit].map((v) => Number(v)).find((n) => Number.isFinite(n) && n > 0);
    if (numeric !== undefined) out.periods = numeric;

    const rawForms = [];
    for (const v of [a.filing_type, a.forms]) {
        const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
        for (const x of list) if (typeof x === 'string' && x.trim()) rawForms.push(x.trim().toUpperCase());
    }
    const forms = [...new Set(rawForms.filter(Boolean))].slice(0, 5).map((f) => f.slice(0, 10));
    if (forms.length) out.forms = forms;

    if (typeof a.section === 'string' && a.section.trim()) out.section = a.section.trim().slice(0, 40);

    const hasQuery = typeof a.query === 'string' && a.query.trim().length > 0;
    out.hasQuery = hasQuery;
    if (hasQuery) out.queryLen = a.query.length;

    // A company search term is research input (what names people start from),
    // kept for search_companies only, lower-cased and bounded.
    if (toolName === 'search_companies') {
        const term = String(a.query || '').trim().toLowerCase();
        if (term) out.term = term.slice(0, 60);
    }

    // A free-text question NEVER survives as text: only its topic bucket and
    // its length, which is all the demand signal the report needs.
    if (toolName === 'ask_filings') {
        const question = String(a.question || '');
        if (question.trim()) {
            out.topic = classifyTopic(question);
            out.questionLen = question.length;
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// Result facets — outcome, size and emptiness, never the payload
// ---------------------------------------------------------------------------

// Best-effort row count of a successful result: the main array in the
// structured content. Candidate keys in tool-preference order.
const ROW_KEYS = ['filings', 'results', 'matches', 'companies', 'periods', 'rows', 'observations'];

function resultFacets(result) {
    const r = result && typeof result === 'object' ? result : {};
    const out = { ok: !r.isError };
    if (r.isError) {
        // errorResult() puts {code, error} JSON-encoded in content[0].text and
        // sets isError; there is no structuredContent on a refusal.
        let code = null;
        try {
            const parsed = JSON.parse((r.content && r.content[0] && r.content[0].text) || '{}');
            if (parsed && typeof parsed.code === 'string') code = parsed.code;
        } catch (_) { /* not parseable: no code facet */ }
        out.code = code;
    } else {
        out.code = null;
    }
    try {
        out.bytes = JSON.stringify(r.content || []).length;
    } catch (_) { out.bytes = null; }

    const sc = r.structuredContent && typeof r.structuredContent === 'object' ? r.structuredContent : null;
    let rows = null;
    if (sc) {
        for (const key of ROW_KEYS) {
            if (Array.isArray(sc[key])) { rows = sc[key].length; break; }
        }
        if (rows === null && typeof sc.match_count === 'number') rows = sc.match_count;
    }
    if (rows !== null) out.rows = rows;
    out.empty = out.ok && rows === 0;

    const share = nullShare(sc);
    out.nullShare = share === null ? null : Math.round(share * 1000) / 1000;
    return out;
}

// Fraction of null among numeric-or-null leaf values, scanning at most
// NULL_LEAF_CAP leaves so a huge result cannot make this expensive. Null when
// the content has no such leaves.
const NULL_LEAF_CAP = 5000;

function nullShare(node) {
    if (!node || typeof node !== 'object') return null;
    let numeric = 0;
    let nulls = 0;
    let seen = 0;
    const walk = (n) => {
        if (seen >= NULL_LEAF_CAP) return;
        if (n === null) { nulls += 1; seen += 1; return; }
        if (typeof n === 'number') { numeric += 1; seen += 1; return; }
        if (Array.isArray(n)) { for (const x of n) { if (seen >= NULL_LEAF_CAP) return; walk(x); } return; }
        if (n && typeof n === 'object') { for (const v of Object.values(n)) { if (seen >= NULL_LEAF_CAP) return; walk(v); } }
    };
    walk(node);
    const total = numeric + nulls;
    return total > 0 ? nulls / total : null;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

const indexed = new WeakSet();

// TTL index on `at` (a Date) plus a tool/at query index. Called once lazily
// from record(); every failure is swallowed — an index problem must never
// reach the request path.
function ensureIndexes(col) {
    if (!col || indexed.has(col)) return Promise.resolve();
    indexed.add(col);
    return Promise.all([
        col.createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 }),
        col.createIndex({ tool: 1, at: -1 })
    ]).catch(() => {});
}

// Fire-and-forget: inserts one small row (undefined/null keys dropped, so a
// refusal row carries only what it actually has) and never throws, never
// awaits on the request path.
function record(col, evt) {
    if (!enabled() || !col || !evt || !evt.tool) return;
    try {
        ensureIndexes(col);
        const doc = { at: new Date() };
        for (const [key, value] of Object.entries(evt)) {
            if (value === undefined || value === null) continue;
            doc[key] = value;
        }
        col.insertOne(doc).catch(() => {});
    } catch (_) { /* usage logging must never fail a call */ }
}

// ---------------------------------------------------------------------------
// Read path — the admin usage report (Phase 2)
// ---------------------------------------------------------------------------

const REPORT_WINDOW_MAX_DAYS = 90;

// One aggregation per question, each bounded with a $limit. A failing
// aggregation (an old server without $percentile, a blip) yields its empty
// shape rather than failing the whole report.
async function safe(col, pipeline) {
    try {
        return await col.aggregate(pipeline).toArray();
    } catch (_) {
        return [];
    }
}

const cleanGroups = (rows, key) => rows.map((r) => ({ [key]: r._id, count: r.count })).filter((r) => r[key] !== null && r[key] !== undefined);

async function collectMcpUsage(col, { days = 7 } = {}) {
    const window = Math.min(Math.max(Number(days) || 7, 1), REPORT_WINDOW_MAX_DAYS);
    const since = new Date(Date.now() - window * 86400000);
    const out = {
        days: window,
        generatedAt: new Date().toISOString(),
        totals: { calls: 0, ok: 0, refused: 0, callers: 0, anonymousCallers: 0, signedInCallers: 0 },
        byTool: [],
        byClient: [],
        refusals: [],
        tickers: [],
        metrics: [],
        forms: [],
        sections: [],
        emptySearchTerms: [],
        askTopics: [],
        perDay: [],
        firstTools: []
    };
    if (!col) return out;

    const within = [{ $match: { at: { $gte: since } } }];

    // Totals, including distinct callers split anonymous/signed-in.
    const [totals] = await safe(col, [...within, {
        $group: {
            _id: null,
            calls: { $sum: 1 },
            ok: { $sum: { $cond: [{ $eq: ['$ok', true] }, 1, 0] } },
            callers: { $addToSet: '$caller' },
            anonCallers: { $addToSet: { $cond: [{ $eq: ['$anonymous', true] }, '$caller', null] } }
        }
    }, { $limit: 1 }]);
    if (totals) {
        const callers = (totals.callers || []).filter(Boolean);
        const anon = (totals.anonCallers || []).filter(Boolean);
        out.totals = {
            calls: totals.calls || 0,
            ok: totals.ok || 0,
            refused: (totals.calls || 0) - (totals.ok || 0),
            callers: callers.length,
            anonymousCallers: anon.length,
            signedInCallers: callers.filter((c) => !anon.includes(c)).length
        };
    }

    // Tool × surface: calls, ok rate, p50/p95 ms, avg rows, avg nullShare, empty count.
    // $percentile needs a 7.0+ server; an older one falls back to plain averages.
    const byTool = await safe(col, [...within, {
        $group: {
            _id: { tool: '$tool', surface: '$surface' },
            calls: { $sum: 1 },
            ok: { $sum: { $cond: [{ $eq: ['$ok', true] }, 1, 0] } },
            p50ms: { $percentile: { input: '$ms', p: [0.5], method: 'discrete' } },
            p95ms: { $percentile: { input: '$ms', p: [0.95], method: 'discrete' } },
            avgRows: { $avg: '$rows' },
            avgNullShare: { $avg: '$nullShare' },
            empty: { $sum: { $cond: [{ $eq: ['$empty', true] }, 1, 0] } }
        }
    }, { $sort: { calls: -1, _id: 1 } }, { $limit: 200 }]);
    if (!byTool.length) {
        const fallback = await safe(col, [...within, {
            $group: {
                _id: { tool: '$tool', surface: '$surface' },
                calls: { $sum: 1 },
                ok: { $sum: { $cond: [{ $eq: ['$ok', true] }, 1, 0] } },
                avgMs: { $avg: '$ms' },
                avgRows: { $avg: '$rows' },
                avgNullShare: { $avg: '$nullShare' },
                empty: { $sum: { $cond: [{ $eq: ['$empty', true] }, 1, 0] } }
            }
        }, { $sort: { calls: -1, _id: 1 } }, { $limit: 200 }]);
        out.byTool = fallback.map((r) => ({
            tool: r._id.tool || '(unknown)', surface: r._id.surface || null, calls: r.calls || 0,
            ok: r.ok || 0, okRate: r.calls ? Math.round((r.ok / r.calls) * 1000) / 10 : null,
            p50Ms: r.avgMs != null ? Math.round(r.avgMs) : null, p95Ms: null,
            avgRows: r.avgRows != null ? Math.round(r.avgRows * 10) / 10 : null,
            avgNullShare: r.avgNullShare != null ? Math.round(r.avgNullShare * 1000) / 1000 : null,
            emptyCount: r.empty || 0
        }));
    } else {
        out.byTool = byTool.map((r) => {
            const p = Array.isArray(r.p50ms) ? r.p50ms : [r.p50ms];
            const q = Array.isArray(r.p95ms) ? r.p95ms : [r.p95ms];
            return {
                tool: r._id.tool || '(unknown)', surface: r._id.surface || null, calls: r.calls || 0,
                ok: r.ok || 0, okRate: r.calls ? Math.round((r.ok / r.calls) * 1000) / 10 : null,
                p50Ms: p[0] != null ? Math.round(p[0]) : null, p95Ms: q[0] != null ? Math.round(q[0]) : null,
                avgRows: r.avgRows != null ? Math.round(r.avgRows * 10) / 10 : null,
                avgNullShare: r.avgNullShare != null ? Math.round(r.avgNullShare * 1000) / 1000 : null,
                emptyCount: r.empty || 0
            };
        });
    }

    out.byClient = (await safe(col, [...within, {
        $group: { _id: { client: '$client', platform: '$platform' }, calls: { $sum: 1 } }
    }, { $sort: { calls: -1, _id: 1 } }, { $limit: 100 }]))
        .map((r) => ({ client: r._id.client || '(not recorded)', platform: r._id.platform || null, calls: r.calls || 0 }));

    out.refusals = cleanGroups(await safe(col, [...within, { $match: { ok: false } }, {
        $group: { _id: '$code', count: { $sum: 1 } }
    }, { $sort: { count: -1, _id: 1 } }, { $limit: 50 }]), 'code');

    out.tickers = cleanGroups(await safe(col, [...within, { $unwind: '$tickers' }, {
        $group: { _id: '$tickers', count: { $sum: 1 } }
    }, { $sort: { count: -1, _id: 1 } }, { $limit: 50 }]), 'ticker');

    out.metrics = cleanGroups(await safe(col, [...within, { $unwind: '$metrics' }, {
        $group: { _id: '$metrics', count: { $sum: 1 } }
    }, { $sort: { count: -1, _id: 1 } }, { $limit: 30 }]), 'metric');

    const [faceted] = await safe(col, [...within, { $facet: {
        forms: [{ $unwind: '$forms' }, { $group: { _id: '$forms', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 30 }],
        sections: [{ $match: { section: { $ne: null } } }, { $group: { _id: '$section', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 30 }]
    } }]);
    if (faceted) {
        out.forms = cleanGroups(faceted.forms || [], 'form');
        out.sections = cleanGroups(faceted.sections || [], 'section');
    }

    // Company search terms nobody was found for: the coverage gaps the search
    // surface is most able to reveal.
    out.emptySearchTerms = cleanGroups(await safe(col, [...within, {
        $match: { tool: 'search_companies', term: { $ne: null }, empty: true }
    }, { $group: { _id: '$term', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 50 }]), 'term');

    out.askTopics = cleanGroups(await safe(col, [...within, {
        $match: { tool: 'ask_filings', topic: { $ne: null } }
    }, { $group: { _id: '$topic', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 20 }]), 'topic');

    out.perDay = (await safe(col, [...within, {
        $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at' } }, calls: { $sum: 1 } }
    }, { $sort: { _id: 1 } }, { $limit: REPORT_WINDOW_MAX_DAYS }]))
        .map((r) => ({ day: r._id, calls: r.calls || 0 }));

    // Each caller's earliest tool in the window: how people START with the
    // connector. The sort puts the earliest call first so $first picks it.
    const firsts = await safe(col, [...within, { $sort: { at: 1 } }, {
        $group: { _id: '$caller', firstTool: { $first: '$tool' } }
    }, { $limit: 50000 }]);
    const counts = new Map();
    for (const row of firsts) {
        if (!row._id || !row.firstTool) continue;
        counts.set(row.firstTool, (counts.get(row.firstTool) || 0) + 1);
    }
    out.firstTools = [...counts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

    return out;
}

// ---------------------------------------------------------------------------
// Admin auth: x-admin-token, else the session + marketing-dashboard pair
// ---------------------------------------------------------------------------

// dealMirrorAdminAuth-style check (ADMIN_TOKEN, timing-safe), extracted so
// both the JSON and the HTML route — and the tests — share one implementation.
function tokenOk(req, env = process.env) {
    const token = env.ADMIN_TOKEN;
    if (!token) return false;
    const provided = req && req.headers && req.headers['x-admin-token'];
    if (provided == null) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// token header valid → allowed; else fall through to the same
// authMiddleware + marketingDashboardOnly pair /admin/marketing uses.
function adminAuth({ tokenOk: tokenCheck = tokenOk, sessionAuth, dashboardOnly }) {
    return (req, res, next) => {
        try {
            if (tokenCheck(req)) return next();
        } catch (_) { /* a broken token check must not open the route */ }
        return sessionAuth(req, res, () => dashboardOnly(req, res, next));
    };
}

module.exports = {
    COLLECTION, RETENTION_DAYS,
    enabled, ensureIndexes, callerHash, facetsFor, classifyTopic, resultFacets, nullShare,
    record, collectMcpUsage, adminAuth, tokenOk
};