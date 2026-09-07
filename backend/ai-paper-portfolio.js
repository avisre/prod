// AI Paper Portfolio — beta experiment, gated to AI_PORTFOLIO_BETA_EMAILS.
//
// Two minds, one stock each, $100k of paper money: a guru persona (researches
// the famous investor's documented PHILOSOPHY — never their trades; works for
// dead gurus) and a pure-data AI persona (no investor reference at all) each
// pick exactly one stock, then a tool-less allocator call decides the dollar
// split. Code, not the model, enforces every guardrail: exactly 2 positions
// (one per persona), max 70% in a single position, max 20% cash, stocks-only,
// $100k budget. After the two nightly advisory reviews the AI never runs again
// — snapshots and the SPY benchmark continue forever.
//
// The OWNER may steer the experiment after construction (applySteering):
// reallocate dollars between the two slots, swap one slot's stock, and set
// standing rules the nightly review must reflect — every steering action is
// an explicit owner command, priced at official closes, guardrail-checked in
// code, and logged as a 'steering' decision. The model can still never trade
// silently: chat reaches steering only through the explicit tool the owner's
// request triggers.
//
// A running build is pausable: create() registers the run, the persona loops
// check an abort flag between rounds and tool calls, and a paused build keeps
// its setup (guru + owner constraints) so the owner can edit the plan and run
// it again — a fresh run, never a half-built ledger.
//
// Hard invariants (structural, tested in test/ai-paper-gating.test.js):
//   * `positions` are written by exactly TWO code paths: the construction
//     commit and the owner-steering trade helper — nothing else, ever.
//   * Decisions are append-only: the module never updates or deletes one.
//   * Separate Mongo collections — real Stock/Portfolio docs are never read
//     or written here.
//   * Every stored rationale passes aiClient.leaksIdentity (model identity is
//     a trade secret; prompts and UI never name the model or provider).
//
// Credits: meter, don't gate (single-user beta) — spends ai_paper_build (10)
// on a committed build and ai_paper_daily (4) per review tick. Never calls
// credits.check(); add that gate before any wider rollout.
//
// Data layer: this module deliberately does NOT import app.js (app.js imports
// this) — it talks to yahoo-source directly through a small TTL cache with
// in-flight de-dup (two personas quoting the same ticker share one round
// trip). Tests inject fakes via __setDeps; production uses the default deps.

const mongoose = require('mongoose');
const aiClient = require('./ai-client');
const aiChat = require('./ai-chat');
const gurus = require('./gurus');
const credits = require('./credits');
const yahooSource = require('./yahoo-source');

const LOG_SCHEMA_VERSION = 1;   // append-only decision log format
const CARD_VERSION = 1;          // persona-card / prompt format
const STARTING_CAPITAL = 100000;
const MAX_SINGLE_WEIGHT = 0.70; // one mind can't dominate the book
const MIN_SINGLE_WEIGHT = 0.10;  // both minds must be in the book
const MAX_CASH_PCT = 0.20;
const REVIEW_DAYS = 2;           // nightly advisory reviews, then tracking
const PERSONA_MAX_ROUNDS = 6;    // LLM rounds per persona research loop
const PERSONA_MAX_TOOL_CALLS = 10;
const PERSONA_WALL_MS = 90 * 1000;       // hard cap per persona (parallel)
// The guru mind ALSO downloads the investor's philosophy from the live web
// before it may pick — a research tax the data mind doesn't pay. Its budget is
// wider so philosophy research can't starve the pick: the first live build
// (duquesne) spent its whole 10-call/90s budget and was discarded with no
// valid pick, exactly the starvation this headroom prevents.
const GURU_MAX_TOOL_CALLS = 12;
const GURU_WALL_MS = 120 * 1000;
const ALLOCATOR_TIMEOUT_MS = 25 * 1000;
const BUILD_PHASE_STALE_MS = 15 * 60 * 1000; // building older than this => failed
const SWEEP_MS = 10 * 60 * 1000;         // hourly-ish sweep cadence
const TICK_UTC_HOUR_DEFAULT = 2;         // 02:00 UTC = after the 4pm ET close

// ---- Tool subset handed to the persona research loops (from aiChat.TOOLS).
// screen_universe is a REAL custom-factor screener over the S&P-1500 SEC
// fundamentals cache (ROE / margins / rev CAGR / P/E / PEG / P/B / FCF /
// profitable years / latest-qtr earnings growth / sector / market cap),
// verified 2026-09-07 — but it has NO price-momentum factors, so the AI
// persona card tells it to read momentum from get_price_history instead.
// fetch_page lets the guru mind OPEN the letters/interviews it finds with
// search_web — snippets alone are a thin basis for "documented philosophy".
const PERSONA_TOOL_NAMES = [
    'search_web', 'fetch_page', 'get_quote', 'get_financials', 'get_price_history',
    'screen_universe', 'calculator', 'get_ratios_history', 'get_health_checks',
    'get_reverse_dcf', 'search_filings'
];
const THINK_RE = /<think>[\s\S]*?<\/think>/g;

// ---------------------------------------------------------------------------
// Data access — tiny TTL cache + in-flight de-dup over yahoo-source.
// ---------------------------------------------------------------------------

const _cache = new Map(); // key -> { at, data }
const _inflight = new Map(); // key -> Promise

function cacheGet(key, ttlMs) {
    const hit = _cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ttlMs) { _cache.delete(key); return null; }
    return hit.data;
}

async function yahooCached(fn, params, ttlMs, { bypassCache = false } = {}) {
    const key = `${fn}:${JSON.stringify(params)}`;
    if (!bypassCache && ttlMs > 0) {
        const cached = cacheGet(key, ttlMs);
        if (cached) return cached;
        if (_inflight.has(key)) return _inflight.get(key);
    }
    const p = (async () => {
        const data = await yahooSource.fetchFromYahoo(fn, params);
        if (ttlMs > 0) _cache.set(key, { at: Date.now(), data });
        return data;
    })();
    if (!bypassCache && ttlMs > 0) {
        _inflight.set(key, p);
        p.finally(() => _inflight.delete(key)).catch(() => {});
    }
    return p;
}

// Production deps. Quote cache 60s / daily 15m match app.js's fetchAlphaCached
// TTL choices. `searchWeb` reuses the Ask engine's grounded Google News + RSS
// tool so news digests behave identically to what users see in Ask.
const defaultDeps = {
    // opts.bypassCache skips the 60s quote cache — used by the freshness gate
    // to force a refetch when a quote looks one session stale.
    quote: (symbol, opts) => yahooCached('GLOBAL_QUOTE', { symbol }, 60 * 1000, opts),
    daily: (symbol) => yahooCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize: 'full' }, 15 * 60 * 1000),
    symbolSearch: (symbol) => yahooCached('SYMBOL_SEARCH', { keywords: symbol }, 60 * 60 * 1000),
    searchWeb: (query) => aiChat.runTool('search_web', { query }, {}),
    searchFilings: (args) => aiChat.runTool('search_filings', args, {}),
    llm: (messages, opts) => aiClient.chatRaw(messages, opts)
};
let deps = defaultDeps;
function __setDeps(overrides) { deps = { ...defaultDeps, ...overrides }; }
function __resetDeps() { deps = defaultDeps; }

// ---- Quote helpers --------------------------------------------------------

function quoteRow(data) {
    const q = data && data['Global Quote'];
    if (!q || !q['01. symbol']) return null;
    return {
        symbol: String(q['01. symbol']).toUpperCase(),
        price: Number(q['05. price']),
        quoteDay: String(q['07. latest trading day'] || ''),
        previousClose: Number(q['08. previous close'])
    };
}

// Latest trading dates from a daily series, newest first.
function dailyDates(seriesData, limit = 5) {
    const series = seriesData && seriesData['Time Series (Daily)'];
    if (!series) return [];
    return Object.keys(series).sort().reverse().slice(0, limit);
}

function dailyClose(seriesData, date) {
    const series = seriesData && seriesData['Time Series (Daily)'];
    const row = series && series[date];
    if (!row) return null;
    const c = Number(row['4. close']); // raw official close — NOT adjusted:
    // shares are immutable and were paid real dollars, so the mark must be the
    // same price series the shares live in (adjusted close would silently
    // rewrite the cost basis). SPY is marked on raw close too — a consistent
    // price-return vs price-return comparison.
    return Number.isFinite(c) ? c : null;
}

async function spySeries() { return deps.daily('SPY'); }

// The latest completed trading session, judged on SPY's own daily series —
// the most liquid instrument on the exchange is the session calendar. During
// US market hours the newest series row is the in-progress session and its
// close is the live price; that is still the freshest mark available and its
// date + price are recorded as provenance on every decision that uses them.
async function latestSession() {
    const spy = await spySeries();
    const dates = dailyDates(spy, 2);
    if (!dates.length) return { session: null, prevSession: null };
    return { session: dates[0], prevSession: dates[1] || null };
}

// ---------------------------------------------------------------------------
// Schemas — three collections, fully separate from Stock/Portfolio.
// ---------------------------------------------------------------------------

const PortfolioSchema = new mongoose.Schema({
    user: { type: String, index: true },
    name: { type: String, default: 'AI Paper Portfolio' },
    startingCapital: { type: Number, default: STARTING_CAPITAL },
    cash: { type: Number, default: 0 },
    personas: [{
        id: String,             // 'guru' | 'ai'
        kind: { type: String, enum: ['guru', 'ai'] },
        name: String,           // e.g. 'Warren Buffett' / 'Pure-data AI'
        fund: String,
        weight: Number,         // fraction of capital at construction
        philosophy: String,      // the principles the persona applied (card text)
        cardVersion: Number
    }],
    // IMMUTABLE after create commits — no code path writes positions later.
    positions: [{
        symbol: String,
        name: String,
        shares: Number,
        avgPrice: Number,
        personaId: String,
        openedAt: Date
    }],
    status: { type: String, enum: ['building', 'paused', 'committed', 'tracking', 'failed'], default: 'building' },
    buildPhase: { type: String, default: '' },   // progress label while building
    buildLog: { type: [String], default: [] },   // capped live research feed (last 120 lines)
    // The setup intent, kept through a pause so the owner can edit it and run
    // it again: guru (optional) + free-text owner constraints for both minds.
    setup: mongoose.Schema.Types.Mixed,          // { guruId, constraints: [String] }
    steeringRules: { type: [String], default: [] }, // standing owner rules for the nightly review
    guruId: String,               // retry can prefill the same guru
    dayCount: { type: Number, default: 0 },
    lastTickDay: { type: String, default: '' },   // UTC 'YYYY-MM-DD' idempotency lock
    spyBaseline: { type: Number, default: null },
    buildError: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'ai_paper_portfolios' });

const DecisionSchema = new mongoose.Schema({
    portfolioId: { type: mongoose.Schema.Types.ObjectId, index: true },
    seq: Number,                  // 1-based within a portfolio run
    day: Number,                  // 0 = construction
    type: { type: String, enum: ['construct', 'review', 'end_reviews', 'build_failed', 'steering'] },
    persona: String,              // 'guru' | 'ai' | 'allocator' | 'system'
    rationale: String,
    newsFactors: [String],        // headline digests consumed (audit trail)
    personaWeights: mongoose.Schema.Types.Mixed,
    wouldChange: [{
        symbol: String,
        action: { type: String, enum: ['buy_more', 'trim', 'exit', 'hold'] },
        rationale: String
    }],                            // ADVISORY ONLY — never executed anywhere
    resultingPositions: mongoose.Schema.Types.Mixed,
    provenance: mongoose.Schema.Types.Mixed,  // sessions/prices/quote days used
    usage: mongoose.Schema.Types.Mixed,        // per-call token/latency log
    logVersion: Number,
    at: { type: Date, default: Date.now }
}, { collection: 'ai_paper_decisions' });
DecisionSchema.index({ portfolioId: 1, seq: 1 }, { unique: true });

const SnapshotSchema = new mongoose.Schema({
    portfolioId: { type: mongoose.Schema.Types.ObjectId, index: true },
    date: String,                  // trading session 'YYYY-MM-DD'
    cash: Number,
    positionsValue: Number,
    totalValue: Number,
    portfolioReturnPct: Number,
    spyClose: Number,
    spyReturnPct: Number,
    perPersona: [{ id: String, value: Number, plPct: Number }],
    at: { type: Date, default: Date.now }
}, { collection: 'ai_paper_snapshots' });
SnapshotSchema.index({ portfolioId: 1, date: 1 }, { unique: true });

// Compiled lazily via connection.model() so mongodb-memory-server works and
// duplicate-model errors never fire across test files.
function model(name, schema) {
    try { return mongoose.model(name); } catch (_) { return mongoose.model(name, schema); }
}
const AIPaperPortfolio = () => model('AIPaperPortfolio', PortfolioSchema);
const AIPaperDecision = () => model('AIPaperDecision', DecisionSchema);
const AIPaperSnapshot = () => model('AIPaperSnapshot', SnapshotSchema);

// ---------------------------------------------------------------------------
// Beta gating — AI_PORTFOLIO_BETA_EMAILS is the entire gate; unset = off.
// ---------------------------------------------------------------------------

function betaEmails() {
    return String(process.env.AI_PORTFOLIO_BETA_EMAILS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function betaEnabled() {
    return String(process.env.AI_PAPER_PORTFOLIO || '') === '1' && betaEmails().length > 0;
}
function isBetaUser(user) {
    if (!betaEnabled()) return false;
    const email = String((user && user.email) || '').trim().toLowerCase();
    return betaEmails().includes(email);
}
function betaGate(req, res, next) {
    if (!isBetaUser(req.user)) return res.status(403).json({ code: 'BETA_NOT_ENABLED' });
    next();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Fence-tolerant JSON extraction: strips ``` fences, then takes the outermost
// {...} span. Returns the parsed object or null — never throws.
function parseModelJson(text) {
    const raw = String(text || '').replace(THINK_RE, '').trim();
    if (!raw) return null;
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    for (const attempt of [unfenced, raw]) {
        try {
            const parsed = JSON.parse(attempt);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) { /* try the span extraction */ }
        const start = attempt.indexOf('{');
        const end = attempt.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(attempt.slice(start, end + 1));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch (_) { /* fall through */ }
        }
    }
    return null;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function utcDay(d) {
    const date = d instanceof Date ? d : new Date(d);
    return date.toISOString().slice(0, 10);
}

function stripThink(text) {
    return String(text || '').replace(THINK_RE, '').trim();
}

// Deterministic weight guardrails — the model proposes, code enforces.
// Every rule here is a hard experiment constraint, applied regardless of what
// the allocator said:
//   * missing/unusable weights -> deterministic 50/50 (never a blocked build)
//   * no persona exceeds MAX_SINGLE_WEIGHT; the excess goes to the OTHER mind,
//     not to idle cash (one mind can't dominate the book, and both stay in it)
//   * each persona keeps at least MIN_SINGLE_WEIGHT
//   * leftover cash never exceeds MAX_CASH_PCT (under-allocation is invested
//     back up to that floor proportionally)
// Returns { g: number, a: number } with g + a in [1 - MAX_CASH_PCT, 1].
function fixWeights(wGuru, wAi) {
    let g = num(wGuru); let a = num(wAi);
    if (g === null || a === null) return { g: 0.5, a: 0.5 };
    if (g < 0) g = 0;
    if (a < 0) a = 0;
    const clampPair = () => {
        if (g > MAX_SINGLE_WEIGHT) { a += g - MAX_SINGLE_WEIGHT; g = MAX_SINGLE_WEIGHT; }
        if (a > MAX_SINGLE_WEIGHT) { g += a - MAX_SINGLE_WEIGHT; a = MAX_SINGLE_WEIGHT; }
        if (g > MAX_SINGLE_WEIGHT) g = MAX_SINGLE_WEIGHT; // both were over — discard
        if (g < MIN_SINGLE_WEIGHT) { a = Math.max(MIN_SINGLE_WEIGHT, a - (MIN_SINGLE_WEIGHT - g)); g = MIN_SINGLE_WEIGHT; }
        if (a < MIN_SINGLE_WEIGHT) { g = Math.max(MIN_SINGLE_WEIGHT, g - (MIN_SINGLE_WEIGHT - a)); a = MIN_SINGLE_WEIGHT; }
    };
    clampPair();
    let sum = g + a;
    if (sum > 1 + 1e-9) { g /= sum; a /= sum; } // over-allocated -> renormalize
    sum = g + a;
    if (sum < 1 - MAX_CASH_PCT - 1e-9) { // too much idle cash — invest it proportionally
        const target = 1 - MAX_CASH_PCT;
        g *= target / sum; a *= target / sum;
        clampPair();
    }
    g = Math.round(g * 1e9) / 1e9; // kill FP dust so weights compare exactly
    a = Math.round(a * 1e9) / 1e9;
    return { g, a };
}

// ---------------------------------------------------------------------------
// sanitizeAllocation — the deterministic seatbelt between the model and the
// ledger. Validates BOTH persona picks as real, fresh, stock-only tickers,
// converts weights into share counts, and enforces every budget guardrail in
// code. Pure w.r.t. the model: it only reads its inputs + quotes.
// ---------------------------------------------------------------------------

async function validateSymbol(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) return { ok: false, reason: `"${sym}" is not a valid ticker symbol.` };
    // Stocks only: SPY is the benchmark, never tradeable; ETFs/mutual funds
    // are excluded by the experiment design. SYMBOL_SEARCH exposes Yahoo's
    // quoteType — a pick must be an EQUITY, verified on real data.
    try {
        const search = await deps.symbolSearch(sym);
        const matches = (search && search.bestMatches) || [];
        const exact = matches.find((m) => String(m['1. symbol'] || '').toUpperCase() === sym);
        if (!exact) return { ok: false, reason: `"${sym}" could not be verified as a US-listed stock — no exchange match found.` };
        const type = String(exact['3. type'] || '').toUpperCase();
        if (type !== 'EQUITY') return { ok: false, reason: `"${sym}" is a ${type}, not a common stock. The experiment is stocks-only.` };
        // Freshness gate = the latest completed trading session (NOT literally
        // "today": creation works 24/7 including weekends/holidays). A quote
        // one session behind is refetched bypassing the cache; still-stale is
        // rejected — data accuracy beats data availability.
        const { session, prevSession } = await latestSession();
        if (!session) return { ok: false, reason: 'Market session data is unavailable right now — try again shortly.' };
        let quote = quoteRow(await deps.quote(sym));
        let stale = quote && quote.quoteDay !== session;
        if (stale) quote = quoteRow(await deps.quote(sym, { bypassCache: true })) || quote;
        if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
            return { ok: false, reason: `No usable price quote for ${sym} — it cannot be bought.` };
        }
        if (quote.quoteDay !== session) {
            const behind = quote.quoteDay === prevSession;
            if (!behind) {
                return { ok: false, reason: `The price quote for ${sym} is stale (${quote.quoteDay || 'no date'} vs session ${session}) — rejected rather than traded on old data.` };
            }
        }
        return {
            ok: true, symbol: sym,
            name: String(exact['2. name'] || sym).slice(0, 120),
            price: quote.price,
            provenance: { session, quoteDay: quote.quoteDay, price: quote.price, staleSessionUsed: quote.quoteDay !== session }
        };
    } catch (e) {
        return { ok: false, reason: `Could not verify ${sym} against live market data (${e && e.message ? e.message.slice(0, 80) : 'data unavailable'}).` };
    }
}

// alloc: parsed allocator JSON ({guruWeight, aiWeight, ...}) OR null to use the
// deterministic 50/50 fallback. picks: { guru: {symbol,...}, ai: {...} } from
// the persona loops. Throws nothing; returns { ok, ... } or { ok:false, reason }.
async function sanitizeAllocation(alloc, picks, capital = STARTING_CAPITAL) {
    const rawG = alloc ? num(alloc.guruWeight) : null;
    const rawA = alloc ? num(alloc.aiWeight) : null;
    const fellBack = rawG === null || rawA === null;
    const { g, a } = fixWeights(fellBack ? 0.5 : rawG, fellBack ? 0.5 : rawA);

    const [guruVal, aiVal] = await Promise.all([
        validateSymbol(picks.guru && picks.guru.symbol),
        validateSymbol(picks.ai && picks.ai.symbol)
    ]);
    if (!guruVal.ok) return { ok: false, persona: 'guru', reason: guruVal.reason };
    if (!aiVal.ok) return { ok: false, persona: 'ai', reason: aiVal.reason };
    if (guruVal.symbol === aiVal.symbol) {
        return { ok: false, persona: 'ai', reason: `Both minds picked ${guruVal.symbol} — the experiment needs two different stocks. The AI persona must pick again.` };
    }

    const now = new Date();
    const mkPosition = (val, weight, personaId) => {
        const dollars = weight * capital;
        const shares = Math.max(Math.round((dollars / val.price) * 10000) / 10000, 0.0001);
        return { symbol: val.symbol, name: val.name, shares, avgPrice: val.price, personaId, openedAt: now };
    };
    const positions = [
        mkPosition(guruVal, g, 'guru'),
        mkPosition(aiVal, a, 'ai')
    ];
    const invested = positions.reduce((s, p) => s + p.shares * p.avgPrice, 0);
    const cash = Math.round((capital - invested) * 100) / 100;
    if (cash < 0 || cash > MAX_CASH_PCT * capital + 1) {
        // Rounding can leave cents; a real breach means the math above broke.
        return { ok: false, persona: 'allocator', reason: 'Allocation failed the cash guardrail in code.' };
    }
    return {
        ok: true, fellBack, cash, positions,
        weights: { guru: g, ai: a },
        rationale: alloc && alloc.rationale ? stripThink(alloc.rationale).slice(0, 4000) : '',
        newsFactors: Array.isArray(alloc && alloc.newsFactors)
            ? alloc.newsFactors.map((f) => String(f).slice(0, 300)).slice(0, 8)
            : [],
        provenance: { guru: guruVal.provenance, ai: aiVal.provenance }
    };
}

// ---------------------------------------------------------------------------
// Snapshots — mark-to-market at official closing prices. Zero AI.
// ---------------------------------------------------------------------------

// Marks both positions at the newest raw close on or before `session` and
// returns the snapshot fields (caller upserts). Never throws — a failed
// series read marks that position at its last known avgPrice and flags it.
async function computeSnapshot(portfolio, { session } = {}) {
    const sess = session || (await latestSession()).session;
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    let positionsValue = 0;
    const perPersona = [];
    const marks = [];
    for (const p of positions) {
        let mark = null; let markDate = null; let lagged = false;
        try {
            const series = await deps.daily(p.symbol);
            const dates = dailyDates(series, 10);
            const onDate = dates.find((d) => d <= sess) || dates[dates.length - 1];
            mark = dailyClose(series, onDate);
            markDate = onDate;
            lagged = onDate !== sess;
        } catch (_) { mark = null; }
        const price = Number.isFinite(mark) && mark > 0 ? mark : p.avgPrice;
        const value = price * p.shares;
        positionsValue += value;
        const cost = p.shares * p.avgPrice;
        perPersona.push({
            id: p.personaId,
            value: Math.round(value * 100) / 100,
            plPct: cost > 0 ? Math.round(((value - cost) / cost) * 10000) / 100 : 0
        });
        marks.push({ symbol: p.symbol, markDate: markDate || sess, price, lagged });
    }
    let spyClose = null;
    try {
        const spy = await spySeries();
        const dates = dailyDates(spy, 5);
        const onDate = dates.find((d) => d <= sess) || dates[0];
        spyClose = dailyClose(spy, onDate);
    } catch (_) { spyClose = null; }
    const totalValue = Math.round((portfolio.cash + positionsValue) * 100) / 100;
    const base = Number(portfolio.spyBaseline);
    return {
        date: sess,
        cash: portfolio.cash,
        positionsValue: Math.round(positionsValue * 100) / 100,
        totalValue,
        portfolioReturnPct: Math.round(((totalValue - portfolio.startingCapital) / portfolio.startingCapital) * 10000) / 100,
        spyClose: Number.isFinite(spyClose) ? spyClose : null,
        spyReturnPct: (Number.isFinite(spyClose) && Number.isFinite(base) && base > 0)
            ? Math.round(((spyClose - base) / base) * 10000) / 100
            : null,
        perPersona,
        marks
    };
}

// ---------------------------------------------------------------------------
// Tick scheduling
// ---------------------------------------------------------------------------

function tickUtcHour() {
    const h = num(process.env.AI_PORTFOLIO_TICK_UTC_HOUR);
    return (h !== null && h >= 0 && h <= 23) ? h : TICK_UTC_HOUR_DEFAULT;
}

// Due when: live status, the UTC day's tick hour has arrived, the portfolio
// predates that boundary (a build finishing 5 minutes before the tick is not
// "day 1"), and today's tick hasn't been consumed.
function nextTickDue(p, now = new Date()) {
    if (!p || (p.status !== 'committed' && p.status !== 'tracking')) return false;
    const hour = tickUtcHour();
    const today = utcDay(now);
    const [y, m, d] = today.split('-').map(Number);
    const boundary = new Date(Date.UTC(y, m - 1, d, hour, 0, 0)).getTime();
    if (now.getTime() < boundary) return false;
    if (new Date(p.createdAt).getTime() >= boundary) return false;
    return p.lastTickDay !== today;
}

// ---------------------------------------------------------------------------
// Persona cards (versioned). The guru card carries the documented-philosophy
// assignment; the style tag drives the deterministic seatbelt screens. The AI
// card references no investor at all.
// ---------------------------------------------------------------------------

const GURU_STYLES = {
    berkshire: 'value', pershing: 'activist', baupost: 'value', scion: 'value',
    duquesne: 'macro', soros: 'macro', himalaya: 'value', southeastern: 'value',
    abrams: 'value', yacktman: 'quality', tweedy: 'value', akre: 'quality',
    davis: 'value', renaissance: 'quant', bridgewater: 'macro', thirdpoint: 'activist',
    appaloosa: 'macro', greenlight: 'value', tci: 'quality', valueact: 'quality',
    cooperman: 'value', viking: 'growth', tigerglob: 'growth', lonepine: 'growth',
    maverick: 'growth', durable: 'growth', ariel: 'value',
    // deceased legends — no 13F exists, so the holdings reference block is
    // simply omitted; only the (still documented, still researchable)
    // philosophy drives the pick.
    graham: 'value', munger: 'quality', lynch: 'growth', fisher: 'growth',
    templeton: 'value', schloss: 'value', neff: 'value', troweprice: 'growth'
};

// Deceased legends selectable by natural language alongside the living 13F
// managers. Their philosophies are documented (letters, books, interviews) —
// the guru mind researches them live exactly as it does for living gurus.
const LEGACY_GURUS = [
    { id: 'graham',     name: 'Benjamin Graham', fund: 'Graham-Newman Corporation' },
    { id: 'munger',     name: 'Charlie Munger',  fund: 'Daily Journal Corporation' },
    { id: 'lynch',      name: 'Peter Lynch',     fund: 'Fidelity Magellan Fund' },
    { id: 'fisher',     name: 'Philip Fisher',   fund: 'Fisher & Company' },
    { id: 'templeton',  name: 'John Templeton',  fund: 'Templeton Growth Fund' },
    { id: 'schloss',    name: 'Walter Schloss',  fund: 'Walter & J. Schloss Associates' },
    { id: 'neff',       name: 'John Neff',       fund: 'Windsor Fund (Vanguard)' },
    { id: 'troweprice', name: 'T. Rowe Price',   fund: 'T. Rowe Price Associates' }
];

// Natural-language guru resolution over living managers + legacy legends.
// "buffett", "Charlie Munger", "T. Rowe Price", "berkshire" all resolve to
// exactly one mind; ambiguous or unknown queries come back with the candidate
// list so the assistant can ask "did you mean X?" instead of guessing.
function resolveGuru(query) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const q = norm(query);
    if (!q) return { matched: [] };
    const all = [...gurus.GURU_LIST, ...LEGACY_GURUS];
    const exact = all.find((g) => norm(g.name) === q || g.id === q.replace(/\s+/g, ''));
    if (exact) return { matched: [exact] };
    if (q.length < 3) return { matched: [] };
    return { matched: all.filter((g) => {
        const n = norm(g.name);
        return n.includes(q) || q.includes(n);
    }) };
}

// Seatbelt, NOT validator: catches only egregious mismatches between the pick
// and the persona's style (a 300x P/E meme stock as a "value" pick). The
// cited-principles rationale is the primary alignment mechanism; this screen
// never rejects a defensible judgment call.
async function philosophyScreen(style, symbol) {
    try {
        const data = await aiChat.loadFundAny(symbol);
        if (!data || !data.overview) {
            return { pass: true, flags: [`No cached fundamentals for ${symbol} — screen skipped.`] };
        }
        const ov = data.overview || {};
        const capB = num(ov.MarketCapitalization) !== null ? num(ov.MarketCapitalization) / 1e9 : null;
        const pe = num(ov.PERatio);
        const flags = [];
        if (capB !== null && capB < 1) flags.push(`${symbol} market cap $${capB.toFixed(2)}B is micro-cap`);
        if (style === 'value' && pe !== null && pe > 80) flags.push(`${symbol} P/E ${pe.toFixed(0)} is extreme for a value philosophy`);
        if ((style === 'value' || style === 'quality') && num(ov.ReturnOnEquityTTM) !== null && num(ov.ReturnOnEquityTTM) < 0) {
            flags.push(`${symbol} has negative ROE`);
        }
        return { pass: flags.length === 0, flags };
    } catch (_) {
        return { pass: true, flags: ['Screen data unavailable — skipped.'] };
    }
}

// ---------------------------------------------------------------------------
// LLM plumbing — every call is logged into the run's usage rollup and every
// stored text passes the identity screen.
// ---------------------------------------------------------------------------

function newUsage() { return { calls: [], tokens: 0 }; }

function logCall(usage, task, round, msg, latencyMs, outcome) {
    const u = (msg && msg._usage) || {};
    const pt = num(u.prompt_tokens); const ct = num(u.completion_tokens);
    if (num(u.total_tokens) !== null) usage.tokens += num(u.total_tokens);
    usage.calls.push({
        task, round,
        promptTokens: pt, completionTokens: ct,
        toolCalls: Array.isArray(msg && msg.tool_calls) ? msg.tool_calls.map((t) => t.function.name) : [],
        latencyMs, outcome
    });
}

async function llmCall(messages, usage, { task, round, tools = null, timeoutMs = 120000, maxTokens = 8000 }) {
    const t0 = Date.now();
    // The provider returns an instantly-empty completion (zero usage) for a
    // system-only message list — and the persona loops, allocator and nightly
    // review all prompt exactly that way, which is why every live build died
    // with "no valid pick produced within the round budget" in seconds.
    // Guarantee a user turn; trailing system nudges are fine once one exists.
    const msgs = messages.some((m) => m && m.role === 'user')
        ? messages
        : [...messages, { role: 'user', content: 'Begin now.' }];
    const msg = await deps.llm(msgs, {
        purpose: 'chat', temperature: 0.3, maxTokens,
        tools: tools && tools.length ? tools : null,
        timeoutMs: Math.max(timeoutMs, 5000)
    });
    logCall(usage, task, round, msg, Date.now() - t0,
        Array.isArray(msg.tool_calls) && msg.tool_calls.length ? 'tool_calls'
            : (stripThink(msg.content) ? 'text' : 'empty'));
    return msg;
}

// One transient retry — the shared GPU pool drops connections under load
// (same policy as the Ask engine's loop).
async function llmCallRetry(messages, usage, opts) {
    try {
        return await llmCall(messages, usage, opts);
    } catch (e) {
        if (!/fetch failed|50\d|timeout|ECONNRESET|ETIMEDOUT/i.test(e && e.message || '')) throw e;
        await new Promise((r) => setTimeout(r, 2500));
        return await llmCall(messages, usage, { ...opts, round: (opts.round || 0) + 0.5 });
    }
}

// ---------------------------------------------------------------------------
// Persona research loops
// ---------------------------------------------------------------------------

function personaTools() {
    return (aiChat.TOOLS || []).filter((t) => PERSONA_TOOL_NAMES.includes(t && t.function && t.function.name));
}

const JSON_CONTRACT = [
    'FINAL ANSWER FORMAT — when you have your pick, output ONLY this JSON object (no prose around it, no markdown):',
    '{"symbol":"<US ticker>","name":"<company name>","rationale":"<why this pick, in 3-6 sentences>","philosophy":"<the principles you applied>","keyFactors":[{"metric":"<named metric>","value":"<the specific number you fetched>","why":"<one clause>"}],"confidence":"low|medium|high"}',
    'The rationale MUST quote specific numbers you actually fetched with tools (ROE, margin, P/E, growth, screen rank…). "Strong fundamentals" with no numbers is an automatic rejection. keyFactors needs at least 2 entries with real fetched values.',
    'Pick exactly ONE stock. Never more than one. Never an ETF, index fund, mutual fund, ADR or foreign listing — a US common stock only.'
].join('\n');

async function runPersonaLoop(personaId, systemPrompt, { usage, deadline, maxToolCalls = PERSONA_MAX_TOOL_CALLS, check = null, onLine = null }) {
    const tools = personaTools();
    const messages = [{ role: 'system', content: systemPrompt }];
    let toolCalls = 0;
    for (let round = 0; round < PERSONA_MAX_ROUNDS; round++) {
        // A pause wins over everything: checked at the top of every round so
        // a stop lands within one LLM call's latency at most.
        if (check) check();
        const remaining = deadline - Date.now();
        const finalRound = round === PERSONA_MAX_ROUNDS - 1 || remaining < 15000;
        if (finalRound) {
            messages.push({
                role: 'system',
                content: `TIME/ROUND BUDGET SPENT — call no more tools. Commit to your single pick NOW.\n${JSON_CONTRACT}`
            });
        }
        const msg = await llmCallRetry(messages, usage, {
            task: personaId, round,
            tools: finalRound ? null : tools,
            timeoutMs: Math.min(remaining, 110000)
        });
        if (!finalRound && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
            for (const tc of msg.tool_calls) {
                let result;
                if (toolCalls >= maxToolCalls) {
                    result = { error: 'Tool budget exhausted — make your final pick now with what you have.' };
                } else {
                    // Pause check between tool calls too: a stop never waits
                    // for the full tool budget to drain.
                    if (check) check();
                    toolCalls++;
                    let args = {};
                    try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { args = {}; }
                    if (onLine) { try { onLine(toolLine(tc.function.name, args, null)); } catch (_) { /* feed is best-effort */ } }
                    try {
                        result = await aiChat.runTool(tc.function.name, args, {});
                    } catch (e) {
                        result = { error: `Tool failed: ${String(e && e.message || 'unknown').slice(0, 120)}` };
                    }
                    if (onLine) { try { onLine('  ↳ ' + toolLine(tc.function.name, args, result)); } catch (_) { /* feed is best-effort */ } }
                }
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 20000) });
            }
            continue;
        }
        // Text round — try to read the pick out of it.
        const parsed = parseModelJson(msg.content);
        const pick = validatePickShape(parsed);
        if (pick) return { ...pick, toolCalls };
        if (finalRound) break;
        // Malformed JSON mid-loop: one nudge, then keep going.
        messages.push({ role: 'system', content: `That was not valid pick JSON. ${JSON_CONTRACT}` });
    }
    throw new Error('no valid pick produced within the round budget');
}

function validatePickShape(parsed) {
    if (!parsed) return null;
    const symbol = String(parsed.symbol || '').toUpperCase().trim();
    const name = String(parsed.name || '').trim();
    const rationale = stripThink(parsed.rationale).trim();
    const philosophy = stripThink(parsed.philosophy || '').trim();
    const factors = Array.isArray(parsed.keyFactors) ? parsed.keyFactors : [];
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return null;
    if (!name || rationale.length < 120) return null;
    if (factors.filter((f) => f && f.metric && f.value).length < 2) return null;
    if (aiClient.leaksIdentity(rationale) || aiClient.leaksIdentity(philosophy)) return null;
    return {
        symbol, name, rationale: rationale.slice(0, 4000),
        philosophy: philosophy.slice(0, 2000),
        keyFactors: factors.filter((f) => f && f.metric && f.value).slice(0, 6)
            .map((f) => ({ metric: String(f.metric).slice(0, 80), value: String(f.value).slice(0, 80), why: String(f.why || '').slice(0, 160) }))
    };
}

function marketDigestBlock(digest) {
    if (!digest) return '';
    const lines = [];
    if (digest.spy) lines.push(`S&P 500 benchmark (SPY): last session ${digest.spy.session} close $${digest.spy.close}`);
    if (Array.isArray(digest.headlines)) {
        for (const h of digest.headlines.slice(0, 10)) lines.push(`- ${h}`);
    }
    return lines.length ? `MARKET DIGEST (pre-fetched for you — do not re-search for general market state):\n${lines.join('\n')}\n` : '';
}

// Owner constraints are HARD requirements injected into every mind's prompt:
// the pick must satisfy each one, and the rationale must say how. Written
// once here so the guru persona and the data minds carry the same rules.
function constraintsBlock(constraints) {
    const rows = (Array.isArray(constraints) ? constraints : []).map((c) => String(c || '').trim()).filter(Boolean);
    if (!rows.length) return '';
    return `OWNER'S HARD REQUIREMENTS (satisfy ALL of them — a pick that violates any one is rejected):\n${rows.map((c) => `- ${c}`).join('\n')}\n`;
}

function guruPersonaPrompt(guru, holdings, digest, style, constraints = []) {
    const refBlock = Array.isArray(holdings) && holdings.length
        ? `OPTIONAL REFERENCE ONLY — ${guru.name}'s latest 13F holdings (quarterly, up to 45 days stale): ${holdings.slice(0, 10).map((h) => `${h.ticker || h.name} (${h.weight ? h.weight + '%' : ''})`).join(', ')}.\nThe PHILOSOPHY is authoritative. Your pick does NOT need to match these holdings — a mismatch is fine; abandoning the philosophy is not.\n`
        : '';
    return [
        `You are a disciplined research analyst choosing ONE stock for a paper portfolio built strictly on the documented investing philosophy of ${guru.name} (${guru.fund}). This is a paper-trading experiment; no real money is involved.`,
        `YOUR PROCESS (in order):`,
        `1. PHILOSOPHY FIRST: research ${guru.name}'s documented investing philosophy — shareholder letters, books, interviews, principles they are known for. Use search_web. Research the PHILOSOPHY, not their trades or current holdings.`,
        `2. APPLY IT TO TODAY'S DATA: translate those principles into concrete screens and checks, then use the tools to find US stocks that satisfy them TODAY: screen_universe (real factor screens over ~1,500 US companies: ROE, net margin, revenue CAGR, P/E, P/B, FCF, profitable years, latest-quarter growth, sector, market cap), get_financials, get_ratios_history, get_health_checks, get_reverse_dcf, get_price_history, search_filings. Every number you rely on must come from a tool result in this conversation — never from memory.`,
        `3. PICK EXACTLY ONE STOCK whose rationale names the specific principles AND the specific fetched numbers that satisfy them.`,
        refBlock,
        marketDigestBlock(digest),
        `STYLE SEATBELT: your pick must not be an egregious mismatch for a "${style}" approach (e.g. no extreme-P/E story stock for a value philosophy).`,
        constraintsBlock(constraints),
        JSON_CONTRACT,
        `Remember: never name or hint at any AI model or provider. Output JSON only when committing your pick.`
    ].filter(Boolean).join('\n');
}

// Data-mind prompt, two slots. In a guru build only slot 2 runs (the classic
// pure-data analyst). In the pure-AI default BOTH slots run as independent
// data-only minds with different mandates (growth/momentum vs quality/value),
// so the two passes don't converge on the same thesis. Neither names an
// investor — there is no investor to reference.
function dataMindPrompt(digest, slot = 2, constraints = []) {
    const mandate = slot === 1
        ? `YOUR MANDATE: find the strongest GROWTH story the data can defend — accelerating revenue and latest-quarter earnings growth, expanding margins, and price momentum that confirms the fundamentals (read momentum from get_price_history).`
        : `YOUR MANDATE: find the strongest QUALITY-AT-A-PRICE story the data can defend — high ROE, durable margins, positive FCF, and a valuation you can justify against the growth you found.`;
    return [
        slot === 1
            ? `You are an independent quantitative research analyst choosing ONE stock for a paper portfolio. You follow NO investor, NO philosophy, NO style — only what the data says today. A second data mind is independently picking one other stock; reach your own conclusion, not a safe consensus. This is a paper-trading experiment; no real money is involved.`
            : `You are a pure quantitative research analyst choosing ONE stock for a paper portfolio. You follow NO investor, NO philosophy, NO style — only what the data says today. This is a paper-trading experiment; no real money is involved.`,
        `YOUR PROCESS (in order):`,
        `1. SCREEN THE DATA: use screen_universe (real factor screens over ~1,500 US companies: ROE, net margin, revenue CAGR, P/E, P/B, FCF, profitable years, latest-quarter earnings growth, sector, market-cap bands — combine factors freely, up to 25 rows per call) to build your candidate set. NOTE: screen_universe has NO momentum factors — read momentum from get_price_history for your shortlist. Use search_web only for today's market regime if the digest below is not enough.`,
        `2. ANALYZE: compare your finalists on the numbers that matter to your thesis — get_financials, get_ratios_history, get_health_checks, get_quote. Every number you rely on must come from a tool result in this conversation — never from memory.`,
        mandate,
        `3. PICK EXACTLY ONE STOCK whose rationale cites the specific data factors that made it the winner.`,
        marketDigestBlock(digest),
        constraintsBlock(constraints),
        JSON_CONTRACT,
        `Remember: never name or hint at any AI model or provider. Output JSON only when committing your pick.`
    ].filter(Boolean).join('\n');
}

function allocatorPrompt(mindOne, mindTwo, digest, hasGuru) {
    const pick = (label, p) => `${label}: ${JSON.stringify({
        symbol: p.symbol, name: p.name, rationale: p.rationale, keyFactors: p.keyFactors
    })}`;
    return [
        `You are the portfolio allocator for a two-stock paper-trading experiment with $100,000. ${hasGuru
            ? `One stock was picked by a persona applying a famous investor's documented philosophy; the other by a pure-data analyst with no investor reference.`
            : `Both stocks were picked by independent pure-data analysts with different mandates and no investor reference.`} Decide the dollar split between them.`,
        `Judge COHERENCE: read both rationales and their cited numbers. Tilt weight away from a pick whose reasoning does not hold up against its own data, and toward the pick with the stronger, better-evidenced case. You are not allowed to add, remove or swap stocks — only to split the $100,000 between these two.`,
        `HARD RULES (enforced by code regardless of what you output — follow them anyway): each position gets at least 10% and at most 70% of the capital; at least 80% of the capital must be invested (cash cap 20%).`,
        pick('MIND 1 PICK', mindOne),
        pick('MIND 2 PICK', mindTwo),
        marketDigestBlock(digest),
        `Output ONLY this JSON: {"guruWeight":<0-1 — the dollar share for MIND 1>,"aiWeight":<0-1 — the dollar share for MIND 2>,"rationale":"<why this split, 2-4 sentences>","newsFactors":["<any current headline/market fact that should tilt the split, with source and date>"]}`,
        `Never name or hint at any AI model or provider.`
    ].filter(Boolean).join('\n');
}

// Prewarm: deterministic market digest both personas start from, so nobody
// burns a round re-searching general market state.
async function buildDigest() {
    const digest = { headlines: [], spy: null };
    try {
        const [spy, news] = await Promise.all([
            spySeries(),
            deps.searchWeb('stock market today S&P 500').catch(() => null)
        ]);
        const dates = dailyDates(spy, 1);
        digest.spy = dates.length ? { session: dates[0], close: dailyClose(spy, dates[0]) } : null;
        const headlines = [];
        for (const h of ((news && news.headlines) || [])) {
            if (h && h.title) headlines.push(`${h.title}${h.publisher ? ` (${h.publisher}${h.published ? `, ${h.published}` : ''})` : ''}`);
        }
        for (const a of ((news && news.readableArticles) || [])) {
            if (a && a.title) headlines.push(`${a.title}${a.publisher ? ` (${a.publisher})` : ''}`);
        }
        digest.headlines = headlines.slice(0, 10);
    } catch (_) { /* digest is best-effort */ }
    return digest;
}

// ---------------------------------------------------------------------------
// create() — the ONE buying decision. SSE-friendly via onEvent; disconnects
// are tolerated (build continues server-side; buildPhase persists on the doc
// so polling /detail shows progress).
// ---------------------------------------------------------------------------

async function appendDecision(portfolio, fields) {
    const last = await AIPaperDecision().findOne({ portfolioId: portfolio._id }, { seq: 1 }).sort({ seq: -1 });
    const seq = (last && last.seq ? last.seq : 0) + 1;
    return AIPaperDecision().create({
        portfolioId: portfolio._id, seq, logVersion: LOG_SCHEMA_VERSION,
        at: new Date(), ...fields
    });
}

async function setPhase(doc, phase) {
    doc.buildPhase = phase;
    doc.updatedAt = new Date();
    await AIPaperPortfolio().updateOne({ _id: doc._id }, { $set: { buildPhase: phase, updatedAt: doc.updatedAt } });
}

async function failBuild(doc, message, usage) {
    doc.status = 'failed';
    doc.buildError = String(message || 'The build failed.').slice(0, 500);
    doc.buildPhase = '';
    await AIPaperPortfolio().updateOne(
        { _id: doc._id },
        { $set: { status: 'failed', buildError: doc.buildError, buildPhase: '', updatedAt: new Date() } }
    );
    try {
        await appendDecision(doc, {
            day: 0, type: 'build_failed', persona: 'system',
            rationale: doc.buildError, usage: usage || undefined
        });
    } catch (_) { /* logging is best-effort; the failure state above is authoritative */ }
}

// A paused build is NOT a failed build: the setup intent (guru + constraints)
// is kept on the doc so the owner can edit the plan and run it again. A fresh
// run deletes the paused doc — never a half-built ledger.
async function pauseBuild(doc) {
    doc.status = 'paused';
    doc.buildPhase = '';
    await AIPaperPortfolio().updateOne(
        { _id: doc._id },
        {
            $set: { status: 'paused', buildPhase: '', updatedAt: new Date() },
            $push: { buildLog: { $each: [logStamp('⏸ Paused — the research stopped cleanly. Edit the setup and run it again to resume.')], $slice: -BUILD_LOG_CAP } }
        }
    );
}

// Owner pressed stop on a running build. In-memory flag first (the live run
// sees it within one LLM round / tool call); when no run is registered (a
// process restart orphaned the doc) the doc is paused directly. Repeated or
// late calls are no-ops — pausing is idempotent and safe.
async function stopBuild(userId) {
    const key = String(userId);
    const handle = activeBuilds.get(key);
    if (handle) { handle.aborted = true; return { ok: true, stopping: true }; }
    const doc = await AIPaperPortfolio().findOne({ user: key, status: 'building' });
    if (!doc) return { ok: false, reason: 'No build is running right now.' };
    await pauseBuild(doc);
    return { ok: true, paused: true };
}

// Live run registry: userId -> { aborted }. create() registers itself; the
// persona loops and every stage boundary check the flag, so a pause lands
// within one LLM round / tool call. A process restart loses the registry —
// stopBuild() then pauses the doc directly (the orphaned 'building' doc would
// otherwise wait for the stale reaper).
const activeBuilds = new Map();
class PauseError extends Error {
    constructor() { super('PAUSED_BY_OWNER'); this.paused = true; }
}
function assertLive(handle) {
    if (handle && handle.aborted) throw new PauseError();
}

// ---- Live research feed (buildLog) ----------------------------------------
// Capped on-doc feed the frontend polls while a build runs — it survives
// disconnects and tab switches (the chat SSE stream dies with the answer).
// Every event (phase, per-tool-call research line, pick, pause, done, error)
// becomes one prefixed line. Server-side timestamps keep the feed honest.

const BUILD_LOG_CAP = 120;
function logStamp(text) {
    const t = new Date();
    const mmss = `${String(t.getUTCMinutes()).padStart(2, '0')}:${String(t.getUTCSeconds()).padStart(2, '0')}`;
    return `${mmss} ${String(text || '').slice(0, 240)}`;
}

// Compact one-line summaries for the research feed — never the raw payload
// (a screen_universe result can be 25 rows of fundamentals).
function toolLine(name, args, result) {
    const clean = (v) => stripThink(String(v === undefined || v === null ? '' : v));
    const argStr = Object.entries(args || {})
        .filter(([, v]) => clean(v) !== '' && !(Array.isArray(v) && !v.length))
        .slice(0, 2)
        .map(([k, v]) => `${k}=${clean(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 40)}`)
        .join(', ');
    let out;
    if (result && result.error) out = `⚠ ${clean(result.error).slice(0, 80)}`;
    else if (Array.isArray(result)) out = `${result.length} row${result.length === 1 ? '' : 's'}`;
    else if (result && typeof result === 'object') {
        const keys = Object.keys(result);
        const rows = Array.isArray(result.rows) ? `${result.rows.length} rows` : null;
        const head = clean(result.symbol || result.ticker || result.title || result.companyName || '');
        out = rows || (keys.length ? (head ? `${head}` : `${keys.slice(0, 3).join('/')}`) : 'ok');
    } else out = clean(result).slice(0, 60) || 'ok';
    return `${name}(${argStr}) → ${out}`.slice(0, 200);
}

async function create({ user, guruId, constraints, onEvent }) {
    const userId = String((user && user.id) || user || '');
    const usage = newUsage();
    // Every event goes two places: the SSE connection (instant, dies with the
    // answer) and the doc's capped buildLog (polled, survives disconnects).
    // Events fired before the doc exists (guru-resolution errors) only go to
    // the SSE connection.
    let runDocId = null;
    const emit = (e) => {
        if (runDocId) {
            // Research lines carry the mind label so the polled feed reads
            // "🧠 Buffett mind: screen_universe(…) → 241 rows" without context.
            const line = e.type === 'research' && e.label ? `${e.label}: ${e.text || ''}` : (e.text || '');
            try {
                AIPaperPortfolio().updateOne(
                    { _id: runDocId },
                    { $push: { buildLog: { $each: [logStamp(line)], $slice: -BUILD_LOG_CAP } }, $set: { updatedAt: new Date() } }
                ).catch(() => {});
            } catch (_) { /* feed is best-effort */ }
        }
        if (onEvent) { try { onEvent(e); } catch (_) { /* client gone — keep building */ } }
    };

    // Owner constraints are hard requirements for BOTH minds, validated here
    // so the prompts and the doc always carry the same cleaned list.
    const cleanedConstraints = (Array.isArray(constraints) ? constraints : [])
        .map((c) => stripThink(c).trim().slice(0, 140)).filter(Boolean).slice(0, 5);

    // Guru is OPTIONAL: absent/empty ⇒ the pure-AI default (two independent
    // data minds, no investor persona anywhere). Free text resolves through
    // the living managers + deceased legends.
    const rawGuru = String(guruId || '').trim();
    const resolved = rawGuru ? resolveGuru(rawGuru) : { matched: [] };
    const guru = resolved.matched.length === 1 ? resolved.matched[0] : null;
    const hasGuru = !!guru;
    if (rawGuru && !hasGuru) {
        const hint = resolved.matched.length
            ? `did you mean ${resolved.matched.map((g) => g.name).join(' or ')}?`
            : 'name an investor (e.g. Buffett, Charlie Munger, Peter Lynch) or leave the guru unset for the pure-data default.';
        const err = `Unknown or ambiguous investor "${rawGuru}" — ${hint}`;
        emit({ type: 'error', text: err, message: err });
        return { ok: false, error: err };
    }

    // One portfolio per user. A failed (or paused) run self-clears: the retry
    // IS the recovery path, and it starts a new logged run (the old decisions
    // remain as append-only history under the old portfolio id).
    const Portfolio = AIPaperPortfolio();
    const live = await Portfolio.findOne({ user: userId, status: { $in: ['building', 'committed', 'tracking'] } });
    if (live) {
        emit({ type: 'error', text: 'An AI Paper Portfolio already exists for this account.', message: 'An AI Paper Portfolio already exists for this account.' });
        return { ok: false, error: 'An AI Paper Portfolio already exists for this account.' };
    }
    await Portfolio.deleteMany({ user: userId, status: { $in: ['failed', 'paused'] } });

    const doc = await Portfolio.create({
        user: userId, name: 'AI Paper Portfolio', startingCapital: STARTING_CAPITAL,
        cash: 0, positions: [], personas: [], status: 'building', buildPhase: 'starting',
        buildLog: [], setup: { guruId: hasGuru ? guru.id : '', constraints: cleanedConstraints },
        guruId: hasGuru ? guru.id : '', dayCount: 0, lastTickDay: '', spyBaseline: null, buildError: ''
    });
    const docId = doc._id;
    runDocId = doc._id;
    const ownerConstraints = cleanedConstraints; // cleaned list, injected into both minds
    const handle = { aborted: false };
    activeBuilds.set(userId, handle);

    try {
        if (!aiClient.isConfigured()) throw new Error('The AI service is not configured, so the build cannot run.');
        assertLive(handle);
        emit({
            type: 'status', phase: 'starting',
            text: hasGuru
                ? `Setup: ${guru.name} mind + the data mind${ownerConstraints.length ? ` · your constraints: ${ownerConstraints.join(' · ')}` : ''}`
                : `Setup: two independent data minds${ownerConstraints.length ? ` · your constraints: ${ownerConstraints.join(' · ')}` : ''}`
        });
        emit({ type: 'status', phase: 'digest', text: 'Building the market digest (index levels, rates, breadth)…' });
        await setPhase(doc, 'fetching market digest');
        const digest = await buildDigest();

        assertLive(handle);
        emit({ type: 'status', phase: 'personas', text: 'Two independent minds begin their research…' });
        await setPhase(doc, 'researching both minds');
        const style = hasGuru ? (GURU_STYLES[guru.id] || 'value') : null;
        const holdingsDoc = hasGuru ? await gurus.holdings(guru.id).catch(() => null) : null;
        const holdings = (holdingsDoc && holdingsDoc.holdings) || [];

        // Mind 1 ('guru' slot): investor-philosophy persona when a guru was
        // chosen, otherwise an independent data mind with a growth mandate.
        // Mind 2 ('ai' slot): the classic pure-data analyst (quality mandate).
        // Owner constraints ride into EVERY mind's prompt as hard requirements.
        const promptFor = (personaId) => personaId === 'guru'
            ? (hasGuru
                ? guruPersonaPrompt(guru, holdings, digest, style, ownerConstraints)
                : dataMindPrompt(digest, 1, ownerConstraints))
            : dataMindPrompt(digest, 2, ownerConstraints);
        // The guru mind pays a research tax for the live philosophy download;
        // data minds keep the standard budget.
        const budgetFor = (personaId) => (hasGuru && personaId === 'guru')
            ? { maxToolCalls: GURU_MAX_TOOL_CALLS, wallMs: GURU_WALL_MS }
            : { maxToolCalls: PERSONA_MAX_TOOL_CALLS, wallMs: PERSONA_WALL_MS };
        const labelFor = (personaId) => personaId === 'guru'
            ? (hasGuru ? `🧠 ${guru.name} mind` : '📊 Data mind I')
            : (hasGuru ? '📊 Data mind' : '📊 Data mind II');

        const runMind = async (personaId) => {
            const b = budgetFor(personaId);
            const pick = await runPersonaLoop(personaId, promptFor(personaId), {
                usage, deadline: Date.now() + b.wallMs, maxToolCalls: b.maxToolCalls,
                check: () => handle.aborted,
                onLine: (t) => emit({ type: 'research', persona: personaId, label: labelFor(personaId), text: t })
            });
            emit({ type: 'persona', persona: personaId, label: labelFor(personaId), phase: 'picked', symbol: pick.symbol, text: `${labelFor(personaId)} picked ${pick.symbol}` });
            await setPhase(doc, `${personaId} picked ${pick.symbol}`);
            return pick;
        };

        let results = await Promise.allSettled([runMind('guru'), runMind('ai')]);
        const picks = { guru: null, ai: null };
        const errors = {};
        for (const [i, personaId] of ['guru', 'ai'].entries()) {
            const r = results[i];
            if (r.status === 'fulfilled') picks[personaId] = r.value;
            else errors[personaId] = String(r.reason && r.reason.message || r.reason).slice(0, 300);
        }
        assertLive(handle);
        // One retry per persona, run serially only for the one that failed
        // (the successful mind's work is kept, not re-rolled).
        for (const personaId of ['guru', 'ai']) {
            if (picks[personaId] || !errors[personaId]) continue;
            assertLive(handle);
            emit({ type: 'persona', persona: personaId, phase: 'retry', text: `${labelFor(personaId)} hit a snag — running its research again…` });
            try {
                const b = budgetFor(personaId);
                picks[personaId] = await runPersonaLoop(personaId, promptFor(personaId), {
                    usage, deadline: Date.now() + b.wallMs, maxToolCalls: b.maxToolCalls,
                    check: () => handle.aborted,
                    onLine: (t) => emit({ type: 'research', persona: personaId, label: labelFor(personaId), text: t })
                });
            } catch (e) {
                if (e && e.paused) throw e;
                errors[personaId] = String(e && e.message || e).slice(0, 300);
            }
        }
        if (!picks.guru || !picks.ai) {
            const who = !picks.guru ? (hasGuru ? 'The guru persona' : 'The first data mind') : 'The data persona';
            throw new Error(`${who} could not produce a valid pick (${(!picks.guru ? errors.guru : errors.ai) || 'no pick'}). Nothing was bought — the whole run is discarded; press retry to start a fresh one.`);
        }

        // Two minds converging on the same stock defeats the two-mind design:
        // re-roll mind 2 once with the collision made explicit.
        if (picks.guru.symbol === picks.ai.symbol) {
            assertLive(handle);
            emit({ type: 'persona', persona: 'ai', phase: 'retry', text: `Both minds landed on ${picks.guru.symbol} — re-rolling mind 2 so the two slots stay independent…` });
            picks.ai = await runPersonaLoop('ai', promptFor('ai')
                + `\nIMPORTANT: the first mind already committed to ${picks.guru.symbol}. Your pick must be a DIFFERENT stock — choose the next-best candidate that stands on its own data.`, {
                usage, deadline: Date.now() + PERSONA_WALL_MS,
                check: () => handle.aborted,
                onLine: (t) => emit({ type: 'research', persona: 'ai', label: labelFor('ai'), text: t })
            });
        }

        // Philosophy seatbelt on the guru pick (egregious mismatches only) —
        // a data mind has no philosophy to violate, so it never runs for
        // pure-AI builds.
        if (hasGuru) {
            assertLive(handle);
            const screen = await philosophyScreen(style, picks.guru.symbol);
            if (!screen.pass) {
                throw new Error(`The guru pick (${picks.guru.symbol}) failed the philosophy seatbelt: ${screen.flags.join('; ')}. Nothing was bought; press retry for a fresh run.`);
            }
        }

        assertLive(handle);
        emit({ type: 'status', phase: 'allocator', text: `Deciding the dollar split between ${picks.guru.symbol} and ${picks.ai.symbol}…` });
        await setPhase(doc, 'deciding the dollar split');
        let alloc = null;
        try {
            const allocMsg = await llmCallRetry(
                [{ role: 'system', content: allocatorPrompt(picks.guru, picks.ai, digest, hasGuru) }],
                usage, { task: 'allocator', round: 0, timeoutMs: ALLOCATOR_TIMEOUT_MS, maxTokens: 3000 }
            );
            alloc = parseModelJson(allocMsg.content);
        } catch (_) { alloc = null; }
        if (!alloc) { // one format retry, then the deterministic 50/50 inside sanitize
            try {
                const retryMsg = await llmCallRetry(
                    [{ role: 'system', content: allocatorPrompt(picks.guru, picks.ai, digest, hasGuru) + '\nOutput ONLY valid JSON.' }],
                    usage, { task: 'allocator', round: 1, timeoutMs: ALLOCATOR_TIMEOUT_MS, maxTokens: 3000 }
                );
                alloc = parseModelJson(retryMsg.content);
            } catch (_) { alloc = null; }
        }

        assertLive(handle);
        emit({ type: 'status', phase: 'validating', text: 'Verifying both picks against real quote data…' });
        await setPhase(doc, 'verifying picks and prices');
        let sanitized = await sanitizeAllocation(alloc, picks, STARTING_CAPITAL);
        if (!sanitized.ok) {
            // A pick that failed real-data validation re-runs that persona once
            // with the rejection reason, then the sanitizer runs again.
            const persona = sanitized.persona;
            if (persona === 'guru' || persona === 'ai') {
                assertLive(handle);
                emit({ type: 'persona', persona, phase: 'retry', text: `${labelFor(persona)}'s pick was rejected (${sanitized.reason}) — picking again…` });
                const retryPrompt = promptFor(persona)
                    + `\nIMPORTANT: your previous pick was rejected by verification: ${sanitized.reason} Pick a different stock that passes.`;
                const b = budgetFor(persona);
                picks[persona] = await runPersonaLoop(persona, retryPrompt, {
                    usage, deadline: Date.now() + b.wallMs, maxToolCalls: b.maxToolCalls,
                    check: () => handle.aborted,
                    onLine: (t) => emit({ type: 'research', persona, label: labelFor(persona), text: t })
                });
                sanitized = await sanitizeAllocation(alloc, picks, STARTING_CAPITAL);
            }
        }
        if (!sanitized.ok) throw new Error(`${sanitized.reason} Nothing was bought; press retry for a fresh run.`);

        assertLive(handle);
        emit({ type: 'status', phase: 'committing', text: 'Writing the positions and the construction decision…' });
        await setPhase(doc, 'committing positions');
        const spy = await spySeries();
        const spyDates = dailyDates(spy, 1);
        const spyClose = spyDates.length ? dailyClose(spy, spyDates[0]) : null;
        if (!Number.isFinite(spyClose)) throw new Error('Could not read the SPY benchmark close — the run was discarded rather than committed against bad data. Press retry.');

        const now = new Date();
        const personas = [
            hasGuru
                ? {
                    id: 'guru', kind: 'guru', name: guru.name, fund: guru.fund,
                    weight: sanitized.weights.guru, philosophy: picks.guru.philosophy || '',
                    cardVersion: CARD_VERSION
                }
                : {
                    id: 'guru', kind: 'ai', name: 'Data mind I', fund: 'No fund — independent data-only research (growth mandate)',
                    weight: sanitized.weights.guru, philosophy: picks.guru.philosophy || '',
                    cardVersion: CARD_VERSION
                },
            {
                id: 'ai', kind: 'ai', name: hasGuru ? 'Pure-data AI' : 'Data mind II',
                fund: hasGuru
                    ? 'No fund — screens the market on data alone'
                    : 'No fund — independent data-only research (quality mandate)',
                weight: sanitized.weights.ai, philosophy: picks.ai.philosophy || '',
                cardVersion: CARD_VERSION
            }
        ];
        // THE ONE AND ONLY write of positions in the entire codebase.
        await Portfolio.updateOne({ _id: doc._id }, {
            $set: {
                status: 'committed', positions: sanitized.positions, personas,
                cash: sanitized.cash, spyBaseline: spyClose,
                buildPhase: '', buildError: '', updatedAt: now
            }
        });
        doc.status = 'committed'; doc.positions = sanitized.positions; doc.personas = personas;
        doc.cash = sanitized.cash; doc.spyBaseline = spyClose; doc.buildPhase = ''; doc.buildError = '';

        const snap = await computeSnapshot(doc, { session: spyDates[0] });
        await AIPaperSnapshot().updateOne(
            { portfolioId: doc._id, date: snap.date },
            { $setOnInsert: { ...snap, portfolioId: doc._id, at: now } },
            { upsert: true }
        );

        await appendDecision(doc, {
            day: 0, type: 'construct', persona: 'allocator',
            rationale: [
                hasGuru
                    ? `MIND 1 (${guru.name}, ${style} philosophy): ${picks.guru.symbol} — ${picks.guru.rationale}`
                    : `MIND 1 (data-only, growth mandate, no investor reference): ${picks.guru.symbol} — ${picks.guru.rationale}`,
                hasGuru
                    ? `MIND 2 (pure data, no investor reference): ${picks.ai.symbol} — ${picks.ai.rationale}`
                    : `MIND 2 (data-only, quality mandate, no investor reference): ${picks.ai.symbol} — ${picks.ai.rationale}`,
                sanitized.fellBack
                    ? `SPLIT: deterministic 50/50 fallback (the allocator call failed; guardrails in code chose equal weight).`
                    : `SPLIT: ${Math.round(sanitized.weights.guru * 100)}% ${picks.guru.symbol} / ${Math.round(sanitized.weights.ai * 100)}% ${picks.ai.symbol} — ${sanitized.rationale}`
            ].join('\n\n'),
            newsFactors: sanitized.newsFactors,
            personaWeights: { guru: sanitized.weights.guru, ai: sanitized.weights.ai, cashPct: sanitized.cash / STARTING_CAPITAL },
            resultingPositions: sanitized.positions,
            provenance: { spyBaseline: { session: spyDates[0], close: spyClose }, picks: sanitized.provenance },
            usage
        });
        await credits.spend(userId, 'ai_paper_build', 'ai-paper build', String(doc._id));

        emit({ type: 'done', portfolioId: String(doc._id), text: '✅ Portfolio built — positions are live on the dashboard.' });
        return { ok: true, portfolioId: String(doc._id) };
    } catch (e) {
        // A pause is NOT a failure: the doc keeps its setup (guru + owner
        // constraints) so the owner can edit it and run it again. The registry
        // handle is the truth even when the throw came from somewhere that
        // swallowed the PauseError type.
        if (handle.aborted || (e && e.paused)) {
            await pauseBuild(doc);
            return { ok: false, paused: true };
        }
        await failBuild(doc, e && e.message, usage);
        emit({ type: 'error', text: doc.buildError, message: doc.buildError });
        return { ok: false, error: doc.buildError };
    } finally {
        activeBuilds.delete(userId);
    }
}

// ---------------------------------------------------------------------------
// Reads — zero AI on these paths.
// ---------------------------------------------------------------------------

async function findFor(userId) {
    return AIPaperPortfolio().findOne({ user: String(userId), status: { $in: ['building', 'paused', 'committed', 'tracking', 'failed'] } });
}

async function detailFor(userId) {
    const doc = await findFor(userId);
    if (!doc) return { exists: false };
    const out = { exists: true, portfolio: {} };
    const p = doc.toObject();
    out.portfolio = {
        id: String(p._id), name: p.name, status: p.status, buildPhase: p.buildPhase,
        buildError: p.buildError, guruId: p.guruId, dayCount: p.dayCount,
        startingCapital: p.startingCapital, cash: p.cash, spyBaseline: p.spyBaseline,
        createdAt: p.createdAt, personas: p.personas, positions: p.positions,
        buildLog: Array.isArray(p.buildLog) ? p.buildLog : [],
        setup: p.setup && typeof p.setup === 'object' ? p.setup : {},
        steeringRules: Array.isArray(p.steeringRules) ? p.steeringRules : []
    };
    if (p.status === 'committed' || p.status === 'tracking') {
        // Live quotes for the 2 positions + SPY only (60s cache inside deps).
        const syms = [...p.positions.map((x) => x.symbol), 'SPY'];
        const quotes = await Promise.all(syms.map(async (s) => {
            try { return quoteRow(await deps.quote(s)); } catch (_) { return null; }
        }));
        out.quotes = {};
        syms.forEach((s, i) => { if (quotes[i]) out.quotes[s] = quotes[i]; });
        const [snapshots, decisions] = await Promise.all([
            AIPaperSnapshot().find({ portfolioId: p._id }).sort({ date: 1 }).limit(400),
            AIPaperDecision().find({ portfolioId: p._id }).sort({ seq: -1 }).limit(20)
        ]);
        out.snapshots = snapshots.map((s) => s.toObject());
        out.decisions = decisions.map((d) => d.toObject());
        const latest = out.snapshots.length ? out.snapshots[out.snapshots.length - 1] : null;
        const spyQuote = out.quotes.SPY;
        out.totals = {
            totalValue: latest ? latest.totalValue : p.startingCapital,
            portfolioReturnPct: latest ? latest.portfolioReturnPct : 0,
            spyReturnPct: latest ? latest.spyReturnPct : (spyQuote && p.spyBaseline ? Math.round(((spyQuote.price - p.spyBaseline) / p.spyBaseline) * 10000) / 100 : null),
            spySession: spyQuote ? spyQuote.quoteDay : null
        };
    }
    return out;
}

// Compact state for the Ask AI system prompt + ai_portfolio_status tool.
async function statusFor(userId) {
    const doc = await findFor(userId);
    if (!doc) return { exists: false };
    const base = {
        exists: true, status: doc.status, buildPhase: doc.buildPhase, buildError: doc.buildError,
        guru: doc.guruId, dayCount: doc.dayCount, reviewDays: REVIEW_DAYS,
        buildLog: Array.isArray(doc.buildLog) ? doc.buildLog.slice(-12) : [],
        setup: doc.setup && typeof doc.setup === 'object' ? doc.setup : {}
    };
    if (doc.status !== 'committed' && doc.status !== 'tracking') return base;
    const snaps = await AIPaperSnapshot().find({ portfolioId: doc._id }).sort({ date: -1 }).limit(1);
    const last = snaps[0];
    return {
        ...base,
        steeringRules: Array.isArray(doc.steeringRules) ? doc.steeringRules : [],
        personas: doc.personas.map((x) => ({
            id: x.id, kind: x.kind, name: x.name, weight: x.weight, philosophy: (x.philosophy || '').slice(0, 600)
        })),
        positions: doc.positions.map((x) => ({
            symbol: x.symbol, name: x.name, shares: x.shares, avgPrice: x.avgPrice, personaId: x.personaId
        })),
        cash: doc.cash,
        latest: last ? {
            date: last.date, totalValue: last.totalValue, portfolioReturnPct: last.portfolioReturnPct,
            spyReturnPct: last.spyReturnPct, perPersona: last.perPersona
        } : null
    };
}

// ---------------------------------------------------------------------------
// Daily tick — results first, then (days 1-2 only) the advisory review.
// ---------------------------------------------------------------------------

// Last 24h headline digest for the held symbols + an 8-K cross-check per
// symbol. Zero LLM — pure tool reads, logged into the decision as newsFactors.
// Timestamp discipline: a headline with NO timestamp is excluded — an
// undatable claim can't be verified as recent (incomplete info is safer than
// confidently-wrong info). Google News dates are day-granular, so the cutoff
// is compared on the day.
async function newsDigest(positions) {
    const cutoffDay = utcDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const factors = [];
    for (const p of positions) {
        try {
            const news = await deps.searchWeb(`${p.symbol} stock news`);
            const rows = [((news && news.headlines) || []), ((news && news.readableArticles) || [])].flat();
            let kept = 0;
            for (const h of rows) {
                if (!h || !h.title || kept >= 5) continue;
                // Google News rows carry `published` ('YYYY-MM-DD'); Yahoo RSS
                // rows carry providerPublishTime (epoch seconds).
                const tsDay = h.published
                    ? String(h.published).slice(0, 10)
                    : (h.providerPublishTime ? utcDay(new Date(h.providerPublishTime * 1000)) : null);
                if (!tsDay || tsDay < cutoffDay) continue; // timestamp-filtered to the last 24h
                factors.push(`${p.symbol}: ${h.title}${h.publisher ? ` (${h.publisher}, ${tsDay})` : ` (${tsDay})`}`);
                kept++;
            }
        } catch (_) { /* one symbol's news failing never skips the day */ }
        try {
            const filings = await deps.searchFilings({ query: p.symbol, ticker: p.symbol, forms: '8-K', limit: 5 });
            for (const f of (Array.isArray(filings && filings.results) ? filings.results : [])) {
                if (f && f.filed && String(f.filed) >= cutoffDay) {
                    factors.push(`${p.symbol}: 8-K filed ${f.filed}`);
                }
            }
        } catch (_) { /* optional cross-check */ }
    }
    return factors.slice(0, 12);
}

const REVIEW_RULES = [
    'Positions change ONLY by an explicit logged owner command (steering) — nothing a review says is ever executed. Your job is an advisory review only.',
    'Never claim to have bought, sold or changed anything. You are recording what you WOULD change and why, for the experiment log.',
    'Base everything on the numbers given here (today\'s official closes, P&L, SPY benchmark) and the headlines below. Attribute headline claims to their source. If a material claim appears in only one outlet and cannot be checked against a filing, call it out as unverified context.',
    `Output ONLY JSON: {"rationale":"<3-6 sentences: how the two picks did and what the news means for each>","newsFactors":["<specific headline, source + date>"],"wouldChange":[{"symbol":"<ticker>","action":"buy_more|trim|exit|hold","rationale":"<advisory note — never executed>"}]}`,
    'Never name or hint at any AI model or provider.'
].join('\n');

async function tickPortfolioOnce(p, { dryRun = false } = {}) {
    const Portfolio = AIPaperPortfolio();
    const today = utcDay(new Date());
    // Atomic double-run/restart lock: claim today's tick before any work.
    const claimed = await Portfolio.findOneAndUpdate(
        { _id: p._id, lastTickDay: { $ne: today } },
        { $set: { lastTickDay: today, updatedAt: new Date() } },
        { new: true }
    );
    if (!claimed) return { noop: true, reason: 'already ticked' };
    if (dryRun) return { claimed: true };

    // Trading-day gate: SPY's daily series is the session calendar. No new
    // closed session since the last snapshot => no-op (no snapshot, no review,
    // no dayCount) — a weekend or market holiday never burns a review slot.
    const spy = await spySeries();
    const spyDates = dailyDates(spy, 1);
    const session = spyDates[0];
    if (!session) return { noop: true, reason: 'no session data' };
    const lastSnap = await AIPaperSnapshot().find({ portfolioId: p._id }).sort({ date: -1 }).limit(1);
    const lastDate = lastSnap[0] && lastSnap[0].date;
    if (lastDate && session <= lastDate) {
        return { noop: true, reason: `no new trading day (last ${lastDate}, session ${session})` };
    }

    // 1. RESULTS FIRST: mark to market at official closes, visible immediately.
    const fresh = await Portfolio.findById(p._id);
    const snap = await computeSnapshot(fresh, { session });
    await AIPaperSnapshot().updateOne(
        { portfolioId: fresh._id, date: session },
        { $setOnInsert: { ...snap, portfolioId: fresh._id, at: new Date() } },
        { upsert: true }
    );

    // 2. Advisory review — days 1..2 only, after results are on the record.
    if (fresh.status === 'committed' && fresh.dayCount < REVIEW_DAYS) {
        const usage = newUsage();
        const factors = await newsDigest(fresh.positions);
        let review = null;
        try {
            const prior = await AIPaperDecision().find({ portfolioId: fresh._id }).sort({ seq: 1 }).limit(10);
            const priorLog = prior.map((d) => `[day ${d.day} ${d.type}] ${String(d.rationale || '').slice(0, 900)}`).join('\n---\n');
            const positionLines = fresh.positions.map((x) => {
                const mark = (snap.perPersona || []).find((pp) => pp.id === x.personaId) || {};
                const cost = x.shares * x.avgPrice;
                return `${x.symbol} (${x.personaId} pick): ${x.shares} shares @ $${x.avgPrice} cost basis $${Math.round(cost)}; marked at today's close, position value $${mark.value || '?'}, P&L ${mark.plPct || '?'}%`;
            }).join('\n');
            const reviewPrompt = [
                `Nightly advisory review of the two-stock AI Paper Portfolio (day ${fresh.dayCount + 1} of ${REVIEW_DAYS}).`,
                `TODAY'S OFFICIAL RESULTS (already recorded, immutable):`,
                `Portfolio total value: $${snap.totalValue} (${snap.portfolioReturnPct}% since inception) vs SPY ${snap.spyReturnPct !== null ? snap.spyReturnPct + '%' : 'benchmark unavailable'} since inception (baseline $${fresh.spyBaseline}, today's SPY close $${snap.spyClose}).`,
                `Cash: $${fresh.cash}.`,
                positionLines,
                factors.length ? `LAST 24H NEWS DIGEST:\n${factors.map((f) => `- ${f}`).join('\n')}` : 'No material news found in the last 24h.',
                `FULL PRIOR DECISION LOG (learn from it — this is the iteration substrate):\n${priorLog || '(none — this is the first review)'}`,
                ...(Array.isArray(fresh.steeringRules) && fresh.steeringRules.length
                    ? [`OWNER'S STANDING RULES (set explicitly by the owner of this experiment — honor them in the review and in anything you say):\n${fresh.steeringRules.map((r) => `- ${String(r).slice(0, 160)}`).join('\n')}`]
                    : []),
                REVIEW_RULES
            ].join('\n\n');
            const msg = await llmCallRetry(
                [{ role: 'system', content: reviewPrompt }],
                usage, { task: 'review', round: 0, timeoutMs: 60 * 1000, maxTokens: 3000 }
            );
            const parsed = parseModelJson(msg.content);
            if (parsed && !aiClient.leaksIdentity(String(parsed.rationale || ''))) review = parsed;
        } catch (_) { review = null; }

        const dayCount = fresh.dayCount + 1;
        const now = new Date();
        const reviewDecision = {
            day: dayCount, type: 'review', persona: 'system',
            rationale: review && review.rationale
                ? stripThink(review.rationale).slice(0, 4000)
                : 'Review unavailable — the day was snapshotted and logged without AI commentary (recorded honestly rather than skipped).',
            newsFactors: review && Array.isArray(review.newsFactors)
                ? review.newsFactors.map((f) => String(f).slice(0, 300)).slice(0, 8)
                : factors.slice(0, 8),
            wouldChange: review && Array.isArray(review.wouldChange)
                ? review.wouldChange
                    .filter((w) => w && w.symbol && ['buy_more', 'trim', 'exit', 'hold'].includes(w.action))
                    .map((w) => ({ symbol: String(w.symbol).slice(0, 10), action: w.action, rationale: String(w.rationale || '').slice(0, 500) }))
                    .slice(0, 4)
                : [],
            resultingPositions: fresh.positions,
            provenance: { session, marks: snap.marks },
            usage: usage.calls.length ? usage : undefined
        };
        await appendDecision(fresh, reviewDecision);
        await credits.spend(fresh.user, 'ai_paper_daily', `ai-paper review day ${dayCount}`, String(fresh._id));

        // 3. Reviews exhausted -> tracking forever, zero AI from here on.
        if (dayCount >= REVIEW_DAYS) {
            await Portfolio.updateOne({ _id: fresh._id }, { $set: { dayCount, status: 'tracking', updatedAt: now } });
            await appendDecision(fresh, {
                day: dayCount, type: 'end_reviews', persona: 'system',
                rationale: `Advisory review window complete after ${REVIEW_DAYS} trading days. The portfolio is now permanently fixed: daily snapshots and the SPY benchmark continue; the AI never runs on this portfolio again.`,
                resultingPositions: fresh.positions
            });
        } else {
            await Portfolio.updateOne({ _id: fresh._id }, { $set: { dayCount, updatedAt: now } });
        }
        return { ticked: true, day: dayCount, session };
    }

    return { ticked: true, snapshotOnly: true, session };
}

// Boot sweep: a deploy during a ~2-min build kills the run mid-flight; this
// marks it failed so the one-tap Retry flow recovers it on the next boot.
async function markStaleBuilding() {
    const cutoff = new Date(Date.now() - BUILD_PHASE_STALE_MS);
    const res = await AIPaperPortfolio().updateMany(
        { status: 'building', updatedAt: { $lt: cutoff } },
        { $set: { status: 'failed', buildError: 'The build was interrupted (the service restarted mid-build). Press retry to start a fresh run.', buildPhase: '', updatedAt: new Date() } }
    );
    if (res && res.modifiedCount) console.log(`[ai-paper] marked ${res.modifiedCount} interrupted build(s) failed`);
}

// ---------------------------------------------------------------------------
// start() — hourly-ish sweep, wired at boot next to startDigest().
// ---------------------------------------------------------------------------

let _sweepTimer = null;
function sweep() {
    (async () => {
        await markStaleBuilding().catch(() => {});
        const live = await AIPaperPortfolio().find({ status: { $in: ['committed', 'tracking'] } }).catch(() => []);
        for (const p of live) {
            if (!nextTickDue(p)) continue;
            try {
                const r = await tickPortfolioOnce(p);
                if (r && r.ticked) console.log(`[ai-paper] tick ${p._id}: ${JSON.stringify(r)}`);
            } catch (e) {
                console.error(`[ai-paper] tick failed for ${p._id}:`, e && e.message);
            }
        }
    })().catch((e) => console.error('[ai-paper] sweep error:', e && e.message));
}

function start() {
    if (!betaEnabled()) return; // feature fully off unless the beta env is set
    if (String(process.env.DISABLE_BACKGROUND_JOBS || '') === '1') return;
    if (_sweepTimer) return;
    sweep();
    _sweepTimer = setInterval(sweep, SWEEP_MS);
    console.log(`[ai-paper] daily sweep scheduled every ${Math.round(SWEEP_MS / 60000)} min (tick hour ${tickUtcHour()}:00 UTC)`);
}

// ---------------------------------------------------------------------------
// Reset — the only removal path, and it only ever removes the portfolio doc.
// Old decisions/snapshots stay as append-only history under their old ids.
// ---------------------------------------------------------------------------

async function resetRun(userId) {
    const doc = await findFor(userId);
    if (!doc) return { ok: false, reason: 'No AI Paper Portfolio exists for this account.' };
    if (doc.status === 'building') return { ok: false, reason: 'A build is still in progress — pause or stop it first before resetting.' };
    await AIPaperPortfolio().deleteOne({ _id: doc._id });
    console.log(`[ai-paper] reset by user ${String(userId).slice(0, 8)}… (old run ${doc._id} kept in the decision history)`);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Owner steering — the ONLY code path besides the construction commit that
// writes positions, and only on an explicit owner command from chat, gated to
// committed/tracking. Guardrails are the same ones construction answers to:
// ≥10% and ≤70% per slot, ≤20% cash, official closes (never intraday marks),
// stocks-only verified symbols. Every action is logged as a 'steering'
// decision under persona 'owner' — the decision log stays the full story.
// ---------------------------------------------------------------------------

async function applySteering(userId, action, params = {}) {
    const Portfolio = AIPaperPortfolio();
    const doc = await findFor(userId);
    if (!doc) return { ok: false, reason: 'No AI Paper Portfolio exists for this account.' };
    if (doc.status === 'building' || doc.status === 'paused') {
        return { ok: false, reason: 'Steering needs a built portfolio — wait for (or finish) the build first.' };
    }
    if (doc.status !== 'committed' && doc.status !== 'tracking') {
        return { ok: false, reason: 'Steering needs a built portfolio.' };
    }
    const act = String(action || '').trim().toLowerCase();

    // ---- rules: standing instructions the nightly review must honor --------
    if (act === 'rules') {
        const rules = (Array.isArray(params.rules) ? params.rules : [params.rule])
            .map((r) => stripThink(String(r || '')).trim().slice(0, 160)).filter(Boolean).slice(0, 5);
        await Portfolio.updateOne({ _id: doc._id }, { $set: { steeringRules: rules, updatedAt: new Date() } });
        await appendDecision(doc, {
            day: doc.dayCount, type: 'steering', persona: 'owner',
            rationale: rules.length
                ? `Owner set standing rules for future reviews:\n${rules.map((r) => `- ${r}`).join('\n')}`
                : 'Owner cleared all standing rules for future reviews.',
            resultingPositions: doc.positions
        });
        return { ok: true, steeringRules: rules };
    }

    // ---- allocate: move dollars between the two slots at official closes ---
    // The invested total never changes, so cash stays put; each slot is
    // re-sized to its target share of invested dollars. A slot that grows
    // buys the delta at today's official close (weighted-average cost basis);
    // a slot that shrinks sells the delta at the same close.
    // Positions read back from a mongoose doc are subdocuments — spreading one
    // copies its internal _doc state and the $set then writes stale values.
    // Every steering write starts from a PLAIN object.
    const plainPos = (p) => (p && typeof p.toObject === 'function'
        ? p.toObject()
        : { symbol: p.symbol, name: p.name, shares: p.shares, avgPrice: p.avgPrice, personaId: p.personaId, openedAt: p.openedAt });

    if (act === 'allocate') {
        const gPct = Number(params.guruPct);
        const aPct = Number(params.aiPct);
        if (!Number.isFinite(gPct) || !Number.isFinite(aPct) || gPct < 0 || aPct < 0 || gPct + aPct > 100.5) {
            return { ok: false, reason: 'Give the split as guruPct and aiPct percentages of the portfolio (they must sum to 100 or less; the rest stays cash).' };
        }
        // Same weight guardrails as construction, in code: each slot 10-70%,
        // idle cash capped at 20% (under-allocation is invested back up to
        // that floor). Weights are shares of TOTAL capital, like construction.
        const { g, a } = fixWeights(gPct / 100, aPct / 100);
        const guruPos = doc.positions.find((p) => p.personaId === 'guru');
        const aiPos = doc.positions.find((p) => p.personaId === 'ai');
        if (!guruPos || !aiPos) return { ok: false, reason: 'The portfolio is missing a position — steering cannot proceed.' };
        const prices = {};
        for (const p of [guruPos, aiPos]) {
            const row = quoteRow(await deps.quote(p.symbol, { bypassCache: true }));
            if (!row || !Number.isFinite(row.price) || row.price <= 0) {
                return { ok: false, reason: `No usable price quote for ${p.symbol} right now — try again shortly.` };
            }
            prices[p.personaId] = row.price;
        }
        const mk = (pos, weight, price) => {
            const base = plainPos(pos);
            const targetDollars = weight * doc.startingCapital;
            const newShares = Math.max(Math.round((targetDollars / price) * 10000) / 10000, 0.0001);
            const delta = newShares - base.shares;
            const avgPrice = delta >= 0
                ? Math.round(((base.shares * base.avgPrice + delta * price) / newShares) * 10000) / 10000
                : base.avgPrice;
            return { ...base, shares: newShares, avgPrice };
        };
        const positions = [mk(guruPos, g, prices.guru), mk(aiPos, a, prices.ai)];
        const newInvested = positions.reduce((s, p) => s + p.shares * p.avgPrice, 0);
        const cash = Math.round((doc.startingCapital - newInvested) * 100) / 100;
        if (cash < 0 || cash > MAX_CASH_PCT * doc.startingCapital + 1) {
            return { ok: false, reason: 'The requested allocation failed the cash guardrail in code — nothing changed.' };
        }
        await Portfolio.updateOne({ _id: doc._id }, { $set: { positions, cash, updatedAt: new Date() } });
        await appendDecision(doc, {
            day: doc.dayCount, type: 'steering', persona: 'owner',
            rationale: `Owner reallocated the split to ${Math.round(g * 100)}% ${positions[0].symbol} / ${Math.round(a * 100)}% ${positions[1].symbol}, priced at official closes (guardrails applied in code).`,
            resultingPositions: positions
        });
        return { ok: true, positions, cash };
    }

    // ---- override: swap one slot's stock for another, priced at the close --
    if (act === 'override') {
        const slot = String(params.slot || '').trim().toLowerCase();
        if (slot !== 'guru' && slot !== 'ai') {
            return { ok: false, reason: 'Say which slot to override: guru or ai (the two portfolio slots).' };
        }
        const other = doc.positions.find((p) => p.personaId !== slot);
        const target = doc.positions.find((p) => p.personaId === slot);
        if (!other || !target) return { ok: false, reason: 'The portfolio is missing a position — steering cannot proceed.' };
        const check = await validateSymbol(params.symbol);
        if (!check.ok) return { ok: false, reason: check.reason };
        if (check.symbol === other.symbol) {
            return { ok: false, reason: `${check.symbol} is already the other slot's stock — the two slots must stay different.` };
        }
        const dollars = target.shares * target.avgPrice;
        const shares = Math.max(Math.round((dollars / check.price) * 10000) / 10000, 0.0001);
        const positions = doc.positions.map((p) => p.personaId === slot
            ? { ...plainPos(p), symbol: check.symbol, name: check.name, shares, avgPrice: check.price, openedAt: new Date() }
            : plainPos(p));
        await Portfolio.updateOne({ _id: doc._id }, { $set: { positions, updatedAt: new Date() } });
        await appendDecision(doc, {
            day: doc.dayCount, type: 'steering', persona: 'owner',
            rationale: `Owner override: the ${slot} slot's pick was replaced ${target.symbol} → ${check.symbol} at $${check.price} (${shares} shares). Reason: ${stripThink(String(params.reason || 'owner request')).slice(0, 400)}`,
            resultingPositions: positions
        });
        return { ok: true, positions };
    }

    return { ok: false, reason: 'Unknown steering action — use allocate (move dollars between slots), override (swap one slot for a different stock) or rules (set standing review rules).' };
}

// ---------------------------------------------------------------------------
// Ask AI chat tools — exposed ONLY when the requesting user is a beta user
// AND aiPaperMode is on (app.js enforces that gate and injects these per
// request via ctx.aiPaperTools). status is a zero-AI read; setup kicks the
// one construction build (paused runs re-run with edited constraints);
// reset only deletes the portfolio doc; steer applies an EXPLICIT owner
// command to an already-built portfolio (reallocation / pick swap / standing
// rules) through the guardrailed applySteering path. The model itself can
// still never trade on its own: every steering call must carry the owner's
// instruction verbatim from the conversation.
// ---------------------------------------------------------------------------

const CHAT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'ai_portfolio_status',
            description: "Current state of the user's AI Paper Portfolio experiment: build status, both persona picks with weights and P&L, cash, the vs-SPY benchmark, the latest snapshot, recent decision-log entries and (while building/paused) the live research feed tail. Use for any question about how the experiment is doing, why a persona picked its stock, or what a nightly review said. Deterministic read — narrate from this data, never invent numbers.",
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ai_portfolio_setup',
            description: "Start (or retry after a failed/paused build) the AI Paper Portfolio. DEFAULT: call with NO arguments — both minds are independent pure-data analysts. If the user names an investor — living (e.g. Buffett, Ackman, Burry, Druckenmiller) or deceased (e.g. Charlie Munger, Benjamin Graham, Peter Lynch) — pass that name as guru and one mind applies that philosophy, researched live. If the user states requirements for the research (e.g. 'avoid financials', 'focus on healthcare', 'only dividend payers'), pass each as a separate entry in constraints. After a pause, confirm the edited setup (guru and/or constraints) with the user, then call this once to run the research again. The build runs in the background (2-3 minutes) and its progress streams into this conversation. Reply that setup is underway; never call it twice or wait for it.",
            parameters: {
                type: 'object',
                properties: {
                    guru: { type: 'string', description: "The investor the user asked for, verbatim — a name ('Charlie Munger', 'T. Rowe Price') or id ('berkshire'). Omit entirely for the pure-data default." },
                    constraints: { type: 'array', items: { type: 'string' }, description: "The user's hard requirements for the research, one short clause each (max 5, e.g. 'avoid financial sector', 'market cap above $10B'). Omit when the user gave none." }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ai_portfolio_steer',
            description: "Apply an EXPLICIT instruction the owner just gave about their already-built AI Paper Portfolio. Three actions: 'allocate' (rebalance the two slots — pass guruPct and aiPct as percentages of the portfolio, e.g. 60/30), 'override' (replace one slot's stock — pass slot 'guru'|'ai', the new ticker symbol, and the owner's reason), 'rules' (set standing rules the nightly review must honor — pass the rules array). Only call when the owner clearly asked for this specific change; confirm the change and its result in your reply. Never call it to speculate, and never invent a ticker the owner did not give.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['allocate', 'override', 'rules'] },
                    guruPct: { type: 'number', description: "allocate: the guru slot's percentage of the portfolio (0-100)." },
                    aiPct: { type: 'number', description: "allocate: the data-mind slot's percentage of the portfolio (0-100)." },
                    slot: { type: 'string', enum: ['guru', 'ai'], description: 'override: which slot to replace.' },
                    symbol: { type: 'string', description: 'override: the new US-listed stock ticker the owner asked for.' },
                    reason: { type: 'string', description: 'override: the owner’s reason, in their words.' },
                    rules: { type: 'array', items: { type: 'string' }, description: 'rules: the standing rules, one short clause each (max 5). Pass the full final list — it replaces the previous rules. Pass an empty list to clear all rules.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ai_portfolio_reset',
            description: "Delete the user's current AI Paper Portfolio so a fresh run can be built (the old decision log stays as history; nothing is ever traded). Only call after the user has explicitly confirmed they want to reset.",
            parameters: { type: 'object', properties: {} }
        }
    }
];

// Ensure indexes (called from app.js's boot block, idempotent).
async function ensureIndexes() {
    const col = (n) => mongoose.connection.collection(n);
    await Promise.all([
        col('ai_paper_portfolios').createIndex({ user: 1, status: 1 }, { name: 'ai_paper_user_status' }),
        col('ai_paper_decisions').createIndex({ portfolioId: 1, seq: -1 }, { name: 'ai_paper_decisions_run' }),
        col('ai_paper_snapshots').createIndex({ portfolioId: 1, date: -1 }, { name: 'ai_paper_snapshots_run' })
    ]).catch((e) => console.warn('[ai-paper] index creation unavailable:', e && e.message));
}

module.exports = {
    betaEnabled, betaGate, isBetaUser,
    create, detailFor, statusFor, start, sweep, tickPortfolioOnce, resetRun,
    stopBuild, applySteering,
    sanitizeAllocation, parseModelJson, computeSnapshot, nextTickDue,
    ensureIndexes, fixWeights, latestSession, markStaleBuilding, CHAT_TOOLS,
    resolveGuru, LEGACY_GURUS,
    PERSONA_TOOL_NAMES, LOG_SCHEMA_VERSION, CARD_VERSION, REVIEW_DAYS,
    __setDeps, __resetDeps
};