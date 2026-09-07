'use strict';

// AI Paper Portfolio — module core tests. Real in-memory Mongo (the atomic
// lastTickDay lock and the append-only decision log are exactly the parts a
// hand-rolled fake would get subtly wrong), scripted LLM + market-data deps
// via the module's injection seams — no network, no real AI provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const paper = require('../ai-paper-portfolio');

// ---- Scripted market data -------------------------------------------------
//
// A fixed session calendar: the latest completed session is '2026-09-04'
// (Friday); the tick-hour boundary is 02:00 UTC. Prices are per-symbol maps.
const SESSION = '2026-09-04';
const PREV_SESSION = '2026-09-03';

function makeDeps({ quotePrices, searchTypes, dailySeries } = {}) {
    const quotes = quotePrices || {
        AAAA: { price: 50, quoteDay: SESSION },
        BBBB: { price: 100, quoteDay: SESSION },
        STALE: { price: 7, quoteDay: '2026-08-25' }, // 8 sessions stale
        SPY: { price: 560, quoteDay: SESSION }
    };
    const types = searchTypes || {
        AAAA: 'EQUITY', BBBB: 'EQUITY', STALE: 'EQUITY',
        SPY: 'ETF', QQQQ: 'ETF'
    };
    const series = dailySeries || {};
    const spySeries = {
        'Time Series (Daily)': Object.fromEntries(
            ['2026-08-28', '2026-09-01', '2026-09-02', PREV_SESSION, SESSION]
                .map((d) => [d, { '4. close': '550', '5. adjusted close': '550' }])
        )
    };
    return {
        quote: async (symbol) => {
            const q = quotes[symbol];
            if (!q) throw new Error('no quote');
            return {
                'Global Quote': {
                    '01. symbol': symbol,
                    '05. price': String(q.price),
                    '07. latest trading day': q.quoteDay,
                    '08. previous close': String(q.price)
                }
            };
        },
        daily: async (symbol) => {
            if (symbol === 'SPY') return spySeries;
            const s = series[symbol] || {
                'Time Series (Daily)': {
                    [PREV_SESSION]: { '4. close': String(quotes[symbol] ? quotes[symbol].price : 10) },
                    [SESSION]: { '4. close': String(quotes[symbol] ? quotes[symbol].price : 10) }
                }
            };
            return s;
        },
        symbolSearch: async (symbol) => ({
            bestMatches: [{
                '1. symbol': symbol,
                '2. name': `${symbol} Corp`,
                '3. type': types[symbol] || 'EQUITY'
            }]
        }),
        searchWeb: async () => ({ headlines: [], readableArticles: [] }),
        searchFilings: async () => ({ results: [] }),
        llm: async () => ({ content: '{}', _usage: null })
    };
}

// Scripted LLM: persona loops return the pick JSON immediately; the allocator
// returns a fixed split. taskName lets tests override per task.
function makeLlm({ guruPick = 'AAAA', aiPick = 'BBBB', alloc = null } = {}) {
    const pickJson = (symbol, persona) => JSON.stringify({
        symbol,
        name: `${symbol} Corp`,
        rationale: `A detailed ${persona} rationale that quotes fetched numbers: ROE 21.4%, net margin 18.2%, 5y revenue CAGR 12.1%, P/E 16.4 — all from tool results in this conversation, well above the 120 character minimum for a defensible pick.`,
        philosophy: persona === 'guru'
            ? 'Buy wonderful businesses at fair prices; durable moats; management with skin in the game.'
            : 'Quality at a reasonable price: high ROE, positive FCF, latest-quarter growth accelerating.',
        keyFactors: [
            { metric: 'ROE', value: '21.4%', why: 'moat evidence' },
            { metric: 'P/E', value: '16.4', why: 'reasonable price' }
        ],
        confidence: 'medium'
    });
    const calls = [];
    return {
        calls,
        llm: async (messages, opts) => {
            const system = messages[0] && messages[0].content || '';
            calls.push({ system: system.slice(0, 60), tools: opts && opts.tools ? opts.tools.length : 0 });
            if (/allocator/i.test(system.slice(0, 120)) || /dollar split/i.test(system)) {
                if (alloc) return { content: JSON.stringify(alloc), _usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 } };
                return { content: 'not json at all', _usage: null };
            }
            if (/pure quantitative/i.test(system)) {
                return { content: pickJson(aiPick, 'ai'), _usage: { prompt_tokens: 2000, completion_tokens: 400, total_tokens: 2400 } };
            }
            return { content: pickJson(guruPick, 'guru'), _usage: { prompt_tokens: 2000, completion_tokens: 400, total_tokens: 2400 } };
        }
    };
}

async function withMongo(fn) {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    // create() refuses to run unless an AI provider is configured; point it at
    // a fake key — the injected llm dep never touches the real provider.
    const savedKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = 'test-only-key';
    try {
        await fn();
    } finally {
        if (savedKey === undefined) delete process.env.OLLAMA_API_KEY;
        else process.env.OLLAMA_API_KEY = savedKey;
        await mongoose.disconnect().catch(() => {});
        await server.stop();
    }
}

// Fresh env per test block: beta on for rin@example.com, feature on.
function betaEnvOn() {
    process.env.AI_PAPER_PORTFOLIO = '1';
    process.env.AI_PORTFOLIO_BETA_EMAILS = 'rin@example.com';
    process.env.AI_PORTFOLIO_TICK_UTC_HOUR = '2';
}
function betaEnvOff() {
    delete process.env.AI_PAPER_PORTFOLIO;
    delete process.env.AI_PORTFOLIO_BETA_EMAILS;
}

const USER = { id: 'u-123', email: 'rin@example.com' };

// ---- Pure helpers ----------------------------------------------------------

test('parseModelJson: fences, prose-wrapped, and junk', () => {
    const obj = { symbol: 'AAPL', name: 'Apple' };
    assert.deepEqual(paper.parseModelJson(JSON.stringify(obj)), obj);
    assert.deepEqual(paper.parseModelJson('```json\n' + JSON.stringify(obj) + '\n```'), obj);
    assert.deepEqual(paper.parseModelJson('Here is my pick:\n```\n' + JSON.stringify(obj) + '\n```\nDone.'), obj);
    assert.deepEqual(paper.parseModelJson('The pick is ' + JSON.stringify(obj) + ' as requested.'), obj);
    assert.equal(paper.parseModelJson('no json here'), null);
    assert.equal(paper.parseModelJson(''), null);
    assert.deepEqual(paper.parseModelJson('```json {"symbol":"X"} ``` trailing'), { symbol: 'X' });
});

test('fixWeights: guardrails enforced in code, whatever the model said', () => {
    // 80/20 -> guru capped at 70
    assert.deepEqual(paper.fixWeights(0.8, 0.2), { g: 0.7, a: 0.3 });
    // one mind tries to take everything -> clamped
    assert.deepEqual(paper.fixWeights(0.95, 0.05), { g: 0.7, a: 0.3 });
    // a persona zeroed out -> both minds stay in the book
    assert.deepEqual(paper.fixWeights(1, 0), { g: 0.7, a: 0.3 });
    assert.deepEqual(paper.fixWeights(0, 1), { g: 0.3, a: 0.7 });
    // too much idle cash -> invested up to the 80% floor
    let w = paper.fixWeights(0.4, 0.2);
    assert.ok(Math.abs(w.g + w.a - 0.8) < 1e-9, 'cash capped at 20%');
    // sum > 1 renormalized
    w = paper.fixWeights(0.7, 0.7);
    assert.ok(Math.abs(w.g + w.a - 1) < 1e-9);
    // missing/null weights -> deterministic 50/50
    assert.deepEqual(paper.fixWeights(null, undefined), { g: 0.5, a: 0.5 });
    // equal split passes through
    assert.deepEqual(paper.fixWeights(0.5, 0.5), { g: 0.5, a: 0.5 });
});

test('beta gate: env parsing and email matching', () => {
    betaEnvOff();
    assert.equal(paper.betaEnabled(), false, 'unset env = fully off');
    assert.equal(paper.isBetaUser({ email: 'rin@example.com' }), false);

    betaEnvOn();
    assert.equal(paper.betaEnabled(), true);
    assert.equal(paper.isBetaUser({ email: 'rin@example.com' }), true);
    assert.equal(paper.isBetaUser({ email: 'RIN@Example.com' }), true, 'case-insensitive');
    assert.equal(paper.isBetaUser({ email: 'other@example.com' }), false);
    assert.equal(paper.isBetaUser(null), false);
    betaEnvOff();
});

// ---- sanitizeAllocation ----------------------------------------------------

test('sanitizeAllocation: valid picks, weights, shares, provenance', async () => {
    paper.__setDeps(makeDeps());
    try {
        const picks = { guru: { symbol: 'AAAA' }, ai: { symbol: 'BBBB' } };
        const out = await paper.sanitizeAllocation({ guruWeight: 0.6, aiWeight: 0.4, rationale: 'Guru case is stronger.' }, picks, 100000);
        assert.equal(out.ok, true);
        assert.equal(out.fellBack, false);
        assert.deepEqual(out.weights, { guru: 0.6, ai: 0.4 });
        assert.equal(out.positions.length, 2);
        const [g, a] = out.positions;
        assert.equal(g.symbol, 'AAAA'); assert.equal(g.personaId, 'guru');
        assert.equal(g.shares, 1200); // 60000 / 50
        assert.equal(a.symbol, 'BBBB'); assert.equal(a.shares, 400); // 40000 / 100
        assert.equal(g.name, 'AAAA Corp', 'name comes from the exchange, not the model');
        const invested = g.shares * g.avgPrice + a.shares * a.avgPrice;
        assert.equal(out.cash, Math.round((100000 - invested) * 100) / 100);
        assert.equal(out.provenance.guru.session, SESSION, 'session recorded as provenance');
        assert.equal(out.provenance.guru.price, 50);
    } finally {
        paper.__resetDeps();
    }
});

test('sanitizeAllocation: allocator junk -> deterministic 50/50, still validated', async () => {
    paper.__setDeps(makeDeps());
    try {
        const picks = { guru: { symbol: 'AAAA' }, ai: { symbol: 'BBBB' } };
        const out = await paper.sanitizeAllocation(null, picks, 100000);
        assert.equal(out.ok, true);
        assert.equal(out.fellBack, true);
        assert.deepEqual(out.weights, { guru: 0.5, ai: 0.5 });
    } finally {
        paper.__resetDeps();
    }
});

test('sanitizeAllocation: ETFs and stale quotes are rejected — accuracy over availability', async () => {
    paper.__setDeps(makeDeps());
    try {
        const picks = { guru: { symbol: 'SPY' }, ai: { symbol: 'BBBB' } };
        const out = await paper.sanitizeAllocation({ guruWeight: 0.5, aiWeight: 0.5 }, picks, 100000);
        assert.equal(out.ok, false);
        assert.equal(out.persona, 'guru');
        assert.match(out.reason, /ETF/);

        const stale = await paper.sanitizeAllocation({ guruWeight: 0.5, aiWeight: 0.5 },
            { guru: { symbol: 'STALE' }, ai: { symbol: 'BBBB' } }, 100000);
        assert.equal(stale.ok, false);
        assert.match(stale.reason, /stale/);

        const same = await paper.sanitizeAllocation({ guruWeight: 0.5, aiWeight: 0.5 },
            { guru: { symbol: 'AAAA' }, ai: { symbol: 'AAAA' } }, 100000);
        assert.equal(same.ok, false);
        assert.match(same.reason, /two different stocks/);
    } finally {
        paper.__resetDeps();
    }
});

test('sanitizeAllocation: guardrails survive a lying allocator', async () => {
    paper.__setDeps(makeDeps());
    try {
        const picks = { guru: { symbol: 'AAAA' }, ai: { symbol: 'BBBB' } };
        // 95/5 -> 70/30. 10/0 -> both minds in the book. 30/30 -> cash capped.
        let out = await paper.sanitizeAllocation({ guruWeight: 0.95, aiWeight: 0.05 }, picks, 100000);
        assert.deepEqual(out.weights, { guru: 0.7, ai: 0.3 });
        out = await paper.sanitizeAllocation({ guruWeight: 0.1, aiWeight: 0.0 }, picks, 100000);
        assert.ok(out.weights.ai >= 0.1 - 1e-9, 'zeroed mind restored to minimum');
        out = await paper.sanitizeAllocation({ guruWeight: 0.3, aiWeight: 0.3 }, picks, 100000);
        assert.ok(Math.abs(out.weights.guru + out.weights.ai - 0.8) < 1e-9, 'idle cash invested to the floor');
        assert.ok(out.cash <= 0.2 * 100000 + 1);
    } finally {
        paper.__resetDeps();
    }
});

// ---- computeSnapshot -------------------------------------------------------

test('computeSnapshot: raw closes, per-persona P&L, SPY benchmark', async () => {
    paper.__setDeps(makeDeps({
        dailySeries: {
            AAAA: { 'Time Series (Daily)': { [SESSION]: { '4. close': '55' } } },
            BBBB: { 'Time Series (Daily)': { [SESSION]: { '4. close': '90' } } },
            // CCCC's series stops one session early -> the mark lags.
            CCCC: { 'Time Series (Daily)': { [PREV_SESSION]: { '4. close': '9' } } }
        }
    }));
    try {
        const doc = {
            _id: new mongoose.Types.ObjectId(),
            cash: 1000, startingCapital: 100000, spyBaseline: 500,
            positions: [
                { symbol: 'AAAA', name: 'AAAA Corp', shares: 1000, avgPrice: 50, personaId: 'guru' },
                { symbol: 'BBBB', name: 'BBBB Corp', shares: 400, avgPrice: 100, personaId: 'ai' }
            ]
        };
        const snap = await paper.computeSnapshot(doc, { session: SESSION });
        assert.equal(snap.positionsValue, 55000 + 36000);
        assert.equal(snap.totalValue, 92000);
        assert.equal(snap.portfolioReturnPct, -8);
        assert.equal(snap.spyClose, 550);
        assert.equal(snap.spyReturnPct, 10);
        const g = snap.perPersona.find((p) => p.id === 'guru');
        const a = snap.perPersona.find((p) => p.id === 'ai');
        assert.equal(g.plPct, 10); // 55/50
        assert.equal(a.plPct, -10); // 90/100
        // lagged mark: position series missing the session -> falls back to its newest close
        const doc2 = {
            ...doc, positions: [{ symbol: 'CCCC', name: 'CCCC', shares: 10, avgPrice: 10, personaId: 'guru' }]
        };
        const snap2 = await paper.computeSnapshot(doc2, { session: SESSION });
        assert.equal(snap2.marks[0].lagged, true);
    } finally {
        paper.__resetDeps();
    }
});

// ---- nextTickDue -----------------------------------------------------------

test('nextTickDue: hour boundary, creation boundary, lock consumption', () => {
    // 2026-09-07 is a Monday; 02:00 UTC boundary.
    const at = (h, m = 0) => new Date(Date.UTC(2026, 8, 7, h, m));
    const base = { status: 'committed', lastTickDay: '', createdAt: new Date(Date.UTC(2026, 8, 6, 12)) };
    assert.equal(paper.nextTickDue(base, at(1)), false, 'before the tick hour');
    assert.equal(paper.nextTickDue(base, at(2)), true);
    assert.equal(paper.nextTickDue({ ...base, lastTickDay: '2026-09-07' }, at(3)), false, 'already ticked today');
    assert.equal(paper.nextTickDue({ ...base, status: 'building' }, at(2)), false);
    assert.equal(paper.nextTickDue({ ...base, status: 'tracking' }, at(2)), true, 'tracking still snapshots forever');
    // created after today's boundary -> not due today
    const fresh = { status: 'committed', lastTickDay: '', createdAt: at(2, 30) };
    assert.equal(paper.nextTickDue(fresh, at(3)), false);
    assert.equal(paper.nextTickDue(fresh, at(1, 59)), false);
});

// ---- resolveGuru: free-text investor matching -------------------------------

test('resolveGuru: exact id/name, partial names, ambiguity, dead legends', () => {
    // exact legacy id and full name (dead legends resolve like anyone else)
    const munger = paper.resolveGuru('munger');
    assert.equal(munger.matched.length, 1);
    assert.equal(munger.matched[0].id, 'munger');
    assert.equal(paper.resolveGuru('Charlie Munger').matched[0].name, 'Charlie Munger');
    const lynch = paper.resolveGuru('peter lynch');
    assert.equal(lynch.matched.length, 1);
    assert.equal(lynch.matched[0].fund, 'Fidelity Magellan Fund');
    assert.equal(paper.resolveGuru('graham').matched[0].name, 'Benjamin Graham');
    // partial name against a LIVING manager
    const buff = paper.resolveGuru('buffett');
    assert.equal(buff.matched.length, 1);
    assert.equal(buff.matched[0].id, 'berkshire');
    // "john" is deliberately ambiguous: living John Rogers + dead John
    // Templeton and John Neff — the surface must come back so the assistant
    // can ask instead of guessing.
    const johns = paper.resolveGuru('john');
    assert.ok(johns.matched.length >= 2, 'ambiguous first name yields candidates');
    assert.ok(johns.matched.some((g) => g.id === 'templeton'));
    assert.ok(johns.matched.some((g) => g.id === 'ariel'));
    // nothing matches: empty, too-short, and nonsense queries
    assert.equal(paper.resolveGuru('').matched.length, 0);
    assert.equal(paper.resolveGuru('ab').matched.length, 0);
    assert.equal(paper.resolveGuru('zzzz-not-an-investor').matched.length, 0);
});

// ---- create + tick end-to-end (scripted deps) ------------------------------

test('create: two minds, one buy, immutable commit, day-0 snapshot, logged decision', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        process.env.AI_PAPER_PORTFOLIO = '1';
        const scripted = makeLlm({ guruPick: 'AAAA', aiPick: 'BBBB', alloc: { guruWeight: 0.6, aiWeight: 0.4, rationale: 'Guru case is stronger.', newsFactors: ['Rates steady (Reuters, 2026-09-04)'] } });
        paper.__setDeps({ ...makeDeps(), llm: scripted.llm });
        try {
            const events = [];
            const res = await paper.create({ user: USER, guruId: 'berkshire', onEvent: (e) => events.push(e) });
            assert.equal(res.ok, true, res.error || 'build should succeed');

            const Portfolio = mongoose.model('AIPaperPortfolio');
            const doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.status, 'committed');
            assert.equal(doc.positions.length, 2);
            assert.deepEqual(doc.positions.map((p) => p.symbol).sort(), ['AAAA', 'BBBB']);
            assert.equal(doc.personas.length, 2);
            assert.equal(doc.personas.find((x) => x.id === 'guru').name, 'Warren Buffett');
            assert.equal(doc.personas.find((x) => x.id === 'ai').kind, 'ai');
            assert.equal(doc.spyBaseline, 550);
            const invested = doc.positions.reduce((s, p) => s + p.shares * p.avgPrice, 0);
            assert.equal(doc.cash, Math.round((100000 - invested) * 100) / 100);
            assert.ok(doc.cash >= 0 && doc.cash <= 20001);
            const maxWeight = Math.max(...doc.positions.map((p) => p.shares * p.avgPrice)) / 100000;
            assert.ok(maxWeight <= 0.7 + 1e-6, 'max single position 70%');

            const Decision = mongoose.model('AIPaperDecision');
            const decisions = await Decision.find({}).sort({ seq: 1 });
            assert.equal(decisions.length, 1);
            const d = decisions[0];
            assert.equal(d.type, 'construct');
            assert.equal(d.day, 0);
            assert.equal(d.seq, 1);
            assert.equal(d.logVersion, paper.LOG_SCHEMA_VERSION);
            assert.ok(d.rationale.includes('AAAA') && d.rationale.includes('BBBB'));
            assert.equal(d.personaWeights.guru, 0.6);
            assert.ok(Array.isArray(d.usage.calls) && d.usage.calls.length >= 3, 'usage rollup logged');
            assert.ok(!JSON.stringify(d).match(/glm|ollama/i), 'no identity leak in the log');

            const Snapshot = mongoose.model('AIPaperSnapshot');
            const snaps = await Snapshot.find({});
            assert.equal(snaps.length, 1, 'day-0 snapshot');
            assert.equal(snaps[0].date, SESSION);

            // Second portfolio for the same user -> refused while live. create
            // returns { ok:false } before writing anything; nothing half-built
            // is left behind.
            const again = await paper.create({ user: USER, guruId: 'akre' });
            assert.equal(again.ok, false);
            assert.match(again.error, /already exists/i);

            // detailFor is zero-AI and reflects the same numbers.
            const detail = await paper.detailFor('u-123');
            assert.equal(detail.exists, true);
            assert.equal(detail.portfolio.status, 'committed');
            assert.equal(detail.portfolio.positions.length, 2);
            assert.ok(detail.totals && Number.isFinite(detail.totals.totalValue));
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('create: a bad guru id fails clean; nothing committed', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        try {
            const res = await paper.create({ user: USER, guruId: 'not-a-guru' });
            assert.equal(res.ok, false);
            assert.match(res.error, /unknown or ambiguous investor/i);
            const Portfolio = mongoose.model('AIPaperPortfolio');
            assert.equal(await Portfolio.countDocuments({}), 0, 'no doc left behind');
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('create: pure-AI default (no guru) — two data minds, no investor persona anywhere', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        process.env.AI_PAPER_PORTFOLIO = '1';
        // Slot 1's prompt opens "independent quantitative" and slot 2's opens
        // "pure quantitative", so the fake returns guruPick for slot 1 and
        // aiPick for slot 2 — two distinct picks with no re-roll.
        const scripted = makeLlm({ guruPick: 'AAAA', aiPick: 'BBBB', alloc: { guruWeight: 0.55, aiWeight: 0.45, rationale: 'Growth case is stronger.', newsFactors: [] } });
        paper.__setDeps({ ...makeDeps(), llm: scripted.llm });
        try {
            const events = [];
            const res = await paper.create({ user: USER, onEvent: (e) => events.push(e) });
            assert.equal(res.ok, true, res.error || 'pure-AI build should succeed');

            const Portfolio = mongoose.model('AIPaperPortfolio');
            const doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.status, 'committed');
            assert.equal(doc.guruId, '', 'no investor stored');
            assert.deepEqual(doc.positions.map((p) => p.symbol).sort(), ['AAAA', 'BBBB']);
            // both slots are data minds; the ids stay 'guru'/'ai' (internal shape)
            assert.equal(doc.personas.length, 2);
            const slotOne = doc.personas.find((x) => x.id === 'guru');
            const slotTwo = doc.personas.find((x) => x.id === 'ai');
            assert.equal(slotOne.kind, 'ai');
            assert.equal(slotTwo.kind, 'ai');
            assert.equal(slotOne.name, 'Data mind I');
            assert.equal(slotTwo.name, 'Data mind II');
            assert.ok(!JSON.stringify(doc).match(/buffett|investor's documented philosophy/i), 'no guru persona leaked into the run');

            const Decision = mongoose.model('AIPaperDecision');
            const d = await Decision.findOne({ type: 'construct' });
            assert.ok(d, 'construct decision logged');
            assert.equal(d.personaWeights.guru, 0.55);
            assert.ok(d.rationale.includes('MIND 1') && d.rationale.includes('MIND 2'), 'mind-agnostic rationale lines');
            assert.ok(!d.rationale.match(/glm|ollama/i), 'no identity leak');
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('create: a dead legend (Munger) builds a guru-flavored run with no 13F block', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        process.env.AI_PAPER_PORTFOLIO = '1';
        const scripted = makeLlm({ guruPick: 'AAAA', aiPick: 'BBBB', alloc: { guruWeight: 0.7, aiWeight: 0.3, rationale: 'Munger case is stronger.', newsFactors: [] } });
        paper.__setDeps({ ...makeDeps(), llm: scripted.llm });
        try {
            // free text, not a 13F id — resolveGuru inside create() maps it
            const res = await paper.create({ user: USER, guruId: 'Charlie Munger' });
            assert.equal(res.ok, true, res.error || 'legacy-guru build should succeed');

            const Portfolio = mongoose.model('AIPaperPortfolio');
            const doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.status, 'committed');
            assert.equal(doc.guruId, 'munger');
            const slotOne = doc.personas.find((x) => x.id === 'guru');
            assert.equal(slotOne.kind, 'guru');
            assert.equal(slotOne.name, 'Charlie Munger');
            assert.equal(slotOne.fund, 'Daily Journal Corporation');
            assert.equal(doc.personas.find((x) => x.id === 'ai').kind, 'ai');
            assert.equal(doc.positions.length, 2);
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('tick: results first, review days 1-2, trading-day gate, append-only log, byte-identical positions', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        const scripted = makeLlm({
            guruPick: 'AAAA', aiPick: 'BBBB',
            alloc: { guruWeight: 0.5, aiWeight: 0.5, rationale: 'Even split.', newsFactors: [] }
        });
        // Dynamic session calendar: the daily closure reads this state at CALL
        // time, so mutating `closes` below advances the market without needing
        // to re-inject deps (the injected object holds this one function).
        const closes = {
            SPY: { [PREV_SESSION]: 540, [SESSION]: 550 },
            AAAA: { [SESSION]: 52 },
            BBBB: { [SESSION]: 104 }
        };
        const deps = makeDeps();
        deps.daily = async (symbol) => ({
            'Time Series (Daily)': Object.fromEntries(
                Object.entries(closes[symbol] || {}).map(([d, c]) => [d, { '4. close': String(c) }])
            )
        });
        deps.llm = scripted.llm;
        paper.__setDeps(deps);
        try {
            await paper.create({ user: USER, guruId: 'berkshire' });
            const Portfolio = mongoose.model('AIPaperPortfolio');
            const Decision = mongoose.model('AIPaperDecision');
            const Snapshot = mongoose.model('AIPaperSnapshot');
            let doc = await Portfolio.findOne({ user: 'u-123' });
            const positionsBefore = JSON.stringify(doc.positions);

            // --- Trading-day gate: same session as day-0 -> no-op tick.
            let r = await paper.tickPortfolioOnce({ ...doc.toObject(), _id: doc._id });
            assert.equal(r.noop || r.ticked, true);
            // (session === day-0 date => gate may or may not have claimed the lock;
            // assert the snapshot set did not grow.)
            assert.equal(await Snapshot.countDocuments({}), 1, 'no duplicate snapshot on the same session');
            doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.dayCount, 0, 'a no-op tick never burns a review slot');

            // --- Day 1: session advances to 09-07.
            closes.SPY['2026-09-07'] = 555;
            closes.AAAA['2026-09-07'] = 54;
            closes.BBBB['2026-09-07'] = 102;
            doc = await Portfolio.findOne({ user: 'u-123' });
            doc.lastTickDay = ''; // simulate the next day's sweep
            await Portfolio.updateOne({ _id: doc._id }, { $set: { lastTickDay: '' } });
            r = await paper.tickPortfolioOnce(doc.toObject());
            assert.equal(r.ticked, true);
            assert.equal(r.day, 1);
            doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.dayCount, 1);
            assert.equal(doc.status, 'committed', 'still in the review window');
            const snaps = await Snapshot.find({}).sort({ date: 1 });
            assert.equal(snaps.length, 2, 'day-1 snapshot written FIRST');
            assert.equal(snaps[1].date, '2026-09-07');
            const reviews = await Decision.find({ type: 'review' });
            assert.equal(reviews.length, 1);
            assert.equal(reviews[0].day, 1);
            assert.ok(Array.isArray(reviews[0].newsFactors));
            assert.equal(JSON.stringify(doc.positions), positionsBefore, 'positions byte-identical after the tick');

            // Re-running the same day is a no-op (atomic lock).
            const again = await paper.tickPortfolioOnce(doc.toObject());
            assert.equal(again.noop, true);

            // --- Day 2: review 2, then tracking forever.
            closes.SPY['2026-09-08'] = 565;
            closes.AAAA['2026-09-08'] = 56;
            closes.BBBB['2026-09-08'] = 100;
            await Portfolio.updateOne({ _id: doc._id }, { $set: { lastTickDay: '' } });
            doc = await Portfolio.findOne({ user: 'u-123' });
            r = await paper.tickPortfolioOnce(doc.toObject());
            assert.equal(r.day, 2);
            doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.status, 'tracking', 'reviews end after day 2');
            assert.equal(doc.dayCount, 2);
            const endReviews = await Decision.find({ type: 'end_reviews' });
            assert.equal(endReviews.length, 1);
            assert.equal((await Decision.find({ type: 'review' })).length, 2, 'exactly 2 reviews, ever');
            assert.equal(JSON.stringify(doc.positions), positionsBefore, 'still byte-identical');

            // --- Day 3: tracking = snapshot only, zero AI, forever.
            const llmCalls = scripted.calls.length;
            closes.SPY['2026-09-09'] = 570;
            closes.AAAA['2026-09-09'] = 58;
            closes.BBBB['2026-09-09'] = 99;
            await Portfolio.updateOne({ _id: doc._id }, { $set: { lastTickDay: '' } });
            doc = await Portfolio.findOne({ user: 'u-123' });
            r = await paper.tickPortfolioOnce(doc.toObject());
            assert.equal(r.snapshotOnly, true, 'tracking ticks are snapshot-only');
            assert.equal((await Snapshot.countDocuments({})), 4, 'snapshots continue forever');
            assert.equal((await Decision.find({ type: 'review' })).length, 2, 'no review ever again');
            assert.equal(scripted.calls.length, llmCalls, 'zero AI calls once tracking');
            assert.equal(JSON.stringify(doc.positions), positionsBefore);
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('reset: removes only the portfolio doc; decisions stay as history', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        paper.__setDeps({ ...makeDeps(), llm: makeLlm().llm });
        try {
            await paper.create({ user: USER, guruId: 'berkshire' });
            const Portfolio = mongoose.model('AIPaperPortfolio');
            const Decision = mongoose.model('AIPaperDecision');
            const decisionsBefore = await Decision.countDocuments({});
            assert.ok(decisionsBefore >= 1);

            const res = await paper.resetRun('u-123');
            assert.equal(res.ok, true);
            assert.equal(await Portfolio.countDocuments({}), 0);
            assert.equal(await Decision.countDocuments({}), decisionsBefore, 'append-only log untouched');

            // A failed build self-clears: create is allowed again immediately.
            const again = await paper.create({ user: USER, guruId: 'berkshire' });
            assert.equal(again.ok, true, 'retry after reset starts a new logged run');
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('create: a persona that never produces a pick fails the build cleanly', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        // The AI persona never returns valid JSON in this script; the guru
        // persona succeeds, so only the AI mind fails (then its retry fails).
        const badLlm = async (messages) => {
            const system = messages[0] && messages[0].content || '';
            if (/pure quantitative/i.test(system)) return { content: 'I cannot decide.', _usage: null };
            if (/allocator/i.test(system.slice(0, 120)) || /dollar split/i.test(system)) {
                return { content: '{"guruWeight":0.5,"aiWeight":0.5}', _usage: null };
            }
            return {
                content: JSON.stringify({
                    symbol: 'AAAA', name: 'AAAA Corp',
                    rationale: 'ROE 21.4%, margin 18.2%, P/E 16.4 from tools — a wonderful business at a fair price with a durable moat and consistent owner earnings growth.',
                    philosophy: 'moats, ROE, fair price',
                    keyFactors: [{ metric: 'ROE', value: '21.4%', why: 'moat' }, { metric: 'P/E', value: '16.4', why: 'price' }]
                }), _usage: null
            };
        };
        paper.__setDeps({ ...makeDeps(), llm: badLlm });
        try {
            const res = await paper.create({ user: USER, guruId: 'berkshire' });
            assert.equal(res.ok, false);
            const Portfolio = mongoose.model('AIPaperPortfolio');
            const doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.status, 'failed');
            assert.ok(doc.buildError.length > 10, 'plain-language build error');
            assert.equal(doc.positions.length, 0, 'no half-built portfolio');
            const Decision = mongoose.model('AIPaperDecision');
            assert.equal((await Decision.find({ type: 'build_failed' })).length, 1, 'failed run logged');
            // Self-clear: a retry is allowed immediately (no live doc blocks it).
            const retry = await paper.create({ user: USER, guruId: 'berkshire' });
            assert.equal(retry.ok, false, 'the broken script still fails the same way');
            assert.ok(!/already exists/i.test(retry.error || ''), 'no 409-trap for failed runs');
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});
// ---- Pause & resume ---------------------------------------------------------

function pickJsonFor(symbol, persona) {
    return JSON.stringify({
        symbol,
        name: `${symbol} Corp`,
        rationale: `A detailed ${persona} rationale that quotes fetched numbers: ROE 21.4%, net margin 18.2%, 5y revenue CAGR 12.1%, P/E 16.4 — all from tool results in this conversation, well above the 120 character minimum for a defensible pick.`,
        philosophy: 'Quality at a reasonable price: high ROE, positive FCF, latest-quarter growth accelerating.',
        keyFactors: [{ metric: 'ROE', value: '21.4%', why: 'moat evidence' }, { metric: 'P/E', value: '16.4', why: 'reasonable price' }],
        confidence: 'medium'
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('stopBuild pauses a running build; the setup is kept, nothing is bought, then it resumes', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        // The guru mind's first LLM round blocks until the test has pressed
        // stop; the pause must land at the next round/stage boundary — and
        // the doc must end up 'paused', not 'failed'.
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const gatedLlm = async (messages) => {
            const system = messages[0] && messages[0].content || '';
            if (/allocator/i.test(system.slice(0, 120)) || /dollar split/i.test(system)) {
                return { content: '{"guruWeight":0.5,"aiWeight":0.5}', _usage: null };
            }
            if (/pure quantitative/i.test(system)) return { content: pickJsonFor('BBBB', 'ai'), _usage: null };
            await gate; // the guru mind waits here
            return { content: pickJsonFor('AAAA', 'guru'), _usage: null };
        };
        paper.__setDeps({ ...makeDeps(), llm: gatedLlm });
        try {
            const build = paper.create({ user: USER, guruId: 'berkshire', constraints: ['avoid financials'], onEvent: () => {} });
            // Wait for the run registry to carry this build…
            let stopping = false;
            for (let i = 0; i < 200 && !stopping; i++) {
                const s = await paper.stopBuild('u-123');
                if (s.stopping) stopping = true;
                else await sleep(15);
            }
            assert.ok(stopping, 'the running build registered itself');
            // …then stop it and let the blocked LLM call finish.
            await release();
            const res = await build;
            assert.equal(res.paused, true, 'the build reports paused, not a generic failure');

            const Portfolio = mongoose.model('AIPaperPortfolio');
            const doc = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(doc.status, 'paused', 'a pause is its own status');
            assert.equal(doc.buildError, '', 'a pause is never recorded as a failure');
            assert.deepEqual(doc.setup, { guruId: 'berkshire', constraints: ['avoid financials'] }, 'the setup intent survives');
            assert.ok(doc.buildLog.length >= 2, 'the live feed captured the run');
            assert.match(doc.buildLog[doc.buildLog.length - 1], /Paused/, 'the pause lands in the feed');

            const Decision = mongoose.model('AIPaperDecision');
            assert.equal((await Decision.find({ type: 'construct' })).length, 0, 'nothing was bought');
            assert.equal((await Decision.find({ type: 'build_failed' })).length, 0, 'a pause is not a failure record');

            // Registry cleanup: a second stop has nothing to stop.
            const again = await paper.stopBuild('u-123');
            assert.equal(again.ok, false, 'the finished (paused) run is no longer registered');

            // RESUME: the owner confirms the edited setup; the paused doc is
            // deleted and the research runs again from scratch.
            const resumed = await paper.create({ user: USER, guruId: 'berkshire', constraints: ['prefer dividend payers'] });
            assert.equal(resumed.ok, true, 'a paused run re-runs with the edited setup');
            const fresh = await Portfolio.findOne({ user: 'u-123' });
            assert.equal(fresh.status, 'committed', 'the resumed run commits');
            assert.deepEqual(fresh.setup, { guruId: 'berkshire', constraints: ['prefer dividend payers'] }, 'the edited setup is what ran');
            assert.equal(await Portfolio.countDocuments({ user: 'u-123' }), 1, 'the paused doc was cleared, not stacked');
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

test('constraints: injected into every mind, cleaned and persisted', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        const systems = [];
        const captureLlm = async (messages, opts) => {
            const system = messages[0] && messages[0].content || '';
            systems.push(system);
            if (/allocator/i.test(system.slice(0, 120)) || /dollar split/i.test(system)) {
                return { content: '{"guruWeight":0.5,"aiWeight":0.5}', _usage: null };
            }
            if (/pure quantitative/i.test(system)) return { content: pickJsonFor('BBBB', 'ai'), _usage: null };
            return { content: pickJsonFor('AAAA', 'guru'), _usage: null };
        };
        paper.__setDeps({ ...makeDeps(), llm: captureLlm });
        try {
            // 7 entries with an empty one: cleaned to 5 non-empty clauses.
            const res = await paper.create({
                user: USER,
                constraints: ['avoid financial sector', '', 'only dividend payers', 'market cap above $10B', 'no tobacco', 'us-listed only', 'low debt']
            });
            assert.equal(res.ok, true);
            const doc = await mongoose.model('AIPaperPortfolio').findOne({ user: 'u-123' });
            assert.equal(doc.setup.constraints.length, 5, 'capped at 5');
            assert.ok(doc.setup.constraints.every((c) => c.length > 0), 'empty clauses dropped');

            const withRules = systems.filter((s) => /OWNER'S HARD REQUIREMENTS/.test(s));
            assert.equal(withRules.length, 2, 'both minds got the constraints');
            for (const s of withRules) {
                assert.match(s, /avoid financial sector/);
                assert.match(s, /only dividend payers/);
                assert.ok(!/low debt/.test(s), 'the 7th clause was dropped');
            }
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});

// ---- Owner steering ---------------------------------------------------------

function seedCommitted({ status = 'committed' } = {}) {
    const now = new Date();
    return {
        user: 'u-123', name: 'AI Paper Portfolio', startingCapital: 100000, cash: 0,
        positions: [
            { symbol: 'AAAA', name: 'AAAA Corp', shares: 1200, avgPrice: 50, personaId: 'guru', openedAt: now },
            { symbol: 'BBBB', name: 'BBBB Corp', shares: 400, avgPrice: 100, personaId: 'ai', openedAt: now }
        ],
        personas: [
            { id: 'guru', kind: 'ai', name: 'Data mind I', fund: 'independent', weight: 0.6 },
            { id: 'ai', kind: 'ai', name: 'Pure-data AI', fund: 'independent', weight: 0.4 }
        ],
        status, guruId: '', dayCount: 0, lastTickDay: '', spyBaseline: 550, buildError: ''
    };
}

test('steering: rules, allocation guardrails, override — every action logged as owner', { timeout: 60000 }, async () => {
    await withMongo(async () => {
        betaEnvOn();
        paper.__setDeps(makeDeps({ quotePrices: {
            AAAA: { price: 50, quoteDay: SESSION }, BBBB: { price: 100, quoteDay: SESSION },
            CCCC: { price: 80, quoteDay: SESSION }, SPY: { price: 560, quoteDay: SESSION }
        } }));
        try {
            await paper.statusFor('u-123'); // registers the models
            const Portfolio = mongoose.model('AIPaperPortfolio');
            const Decision = mongoose.model('AIPaperDecision');

            // Gate: a building doc cannot be steered.
            await Portfolio.create(seedCommitted({ status: 'building' }));
            assert.equal((await paper.applySteering('u-123', 'rules', { rules: ['x'] })).ok, false, 'no steering during a build');
            await Portfolio.deleteMany({});
            await Portfolio.create(seedCommitted());

            // rules: standing owner instructions, persisted + logged
            const rules = await paper.applySteering('u-123', 'rules', { rules: ['prefer dividend payers', ''] });
            assert.equal(rules.ok, true);
            assert.deepEqual(rules.steeringRules, ['prefer dividend payers'], 'blank clauses dropped');
            assert.ok((await Decision.find({ type: 'steering', persona: 'owner' })).length === 1);

            // allocate 70/10: both slots resized at official closes, cash cap kept
            const alloc = await paper.applySteering('u-123', 'allocate', { guruPct: 70, aiPct: 10 });
            assert.equal(alloc.ok, true);
            const [g, a] = alloc.positions;
            assert.equal(g.shares, 1400, 'guru resized to 70% of capital');   // 70000 / 50
            assert.equal(a.shares, 100, 'ai resized to 10% of capital');      // 10000 / 100
            assert.equal(g.avgPrice, 50, 'growth keeps the weighted cost basis');
            assert.equal(alloc.cash, 20000, 'cash lands exactly at the 20% cap');

            // junk allocation refused, nothing changed
            const before = (await Portfolio.findOne({ user: 'u-123' })).positions;
            const junk = await paper.applySteering('u-123', 'allocate', { guruPct: 250, aiPct: 250 });
            assert.equal(junk.ok, false);
            assert.equal(JSON.stringify((await Portfolio.findOne({ user: 'u-123' })).positions), JSON.stringify(before));

            // override the guru slot for CCCC at the fresh official close
            const swap = await paper.applySteering('u-123', 'override', { slot: 'guru', symbol: 'CCCC', reason: 'owner prefers CCCC' });
            assert.equal(swap.ok, true);
            const swapped = swap.positions.find((p) => p.personaId === 'guru');
            assert.equal(swapped.symbol, 'CCCC');
            assert.equal(swapped.avgPrice, 80, 'override prices at the official close');
            assert.equal(swapped.shares, 875, 'same dollars, new price'); // 70000 / 80

            // the two slots must stay different stocks
            const same = await paper.applySteering('u-123', 'override', { slot: 'ai', symbol: 'CCCC' });
            assert.equal(same.ok, false);
            assert.match(same.reason, /already the other slot/);

            // unverifiable symbols are refused, exactly like construction
            const bad = await paper.applySteering('u-123', 'override', { slot: 'ai', symbol: 'nope!!' });
            assert.equal(bad.ok, false);

            // every SUCCESSFUL steering action is one owner decision; refused
            // requests are never logged (nothing changed)
            const ownerDecisions = await Decision.find({ type: 'steering', persona: 'owner' }).sort({ seq: 1 });
            assert.equal(ownerDecisions.length, 3, 'rules + allocate + override logged; refusals are not');

            // statusFor surfaces the standing rules + the feed tail
            const st = await paper.statusFor('u-123');
            assert.deepEqual(st.steeringRules, ['prefer dividend payers']);
            assert.ok(Array.isArray(st.buildLog));
        } finally {
            paper.__resetDeps();
            betaEnvOff();
        }
    });
});
