'use strict';

// The AI Paper Portfolio's money has to add up.
//
// Audit of 2026-10-10, measured with the real functions: swapping out a stock
// that had halved put a −25% portfolio back to 0%, trimming a winner erased
// the gain on the shares sold, a rebalance after gains was refused, and a
// stock split would have read as a crash. These tests state the rule those
// all broke: a steering trade or a split never changes what the portfolio is
// worth, and nothing is charged or counted that did not happen.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
process.env.OLLAMA_API_KEY = 'test-only-key';
const paper = require('../ai-paper-portfolio');
const credits = require('../credits');

const DAY = '2026-10-09', PREV = '2026-10-08';
let px, splits, failing, spent;
const realSpend = credits.spend;
function wire(extra = {}) {
    px = { AAA: 100, BBB: 100, CCC: 50, SPY: 500 }; splits = {}; failing = new Set(); spent = [];
    credits.spend = async (userId, cost) => { spent.push(cost); };
    paper.__setDeps({
        quote: async (s) => ({ 'Global Quote': { '01. symbol': s, '05. price': String(px[s]), '07. latest trading day': DAY } }),
        daily: async (s) => { if (failing.has(s)) throw new Error('feed down'); return { 'Time Series (Daily)': { [DAY]: { '4. close': String(px[s]) }, [PREV]: { '4. close': String(px[s]) } } }; },
        symbolSearch: async (s) => ({ bestMatches: [{ '1. symbol': s, '2. name': s + ' Inc', '3. type': 'EQUITY' }] }),
        splits: async (s) => splits[s] || [],
        searchWeb: async () => ({ headlines: [] }),
        llm: async () => ({ content: JSON.stringify({ rationale: 'Both positions are within plan.', newsFactors: [], wouldChange: [] }), _usage: { total_tokens: 10 } }),
        ...extra
    });
}
afterEach(() => { paper.__resetDeps(); credits.spend = realSpend; });

async function withMongo(fn) {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    try { await fn(mongoose.connection.collection('ai_paper_portfolios')); }
    finally { await mongoose.disconnect().catch(() => {}); await server.stop(); }
}
async function seed(col, fields = {}) {
    await col.deleteMany({});
    await col.insertOne({ user: 'u1', name: 'AI Paper Portfolio', startingCapital: 100000, cash: 0, status: 'tracking', dayCount: 2, lastTickDay: '', spyBaseline: 500,
        positions: [{ symbol: 'AAA', name: 'AAA', shares: 500, avgPrice: 100, personaId: 'guru', openedAt: new Date('2026-09-01'), realizedPl: 0 },
            { symbol: 'BBB', name: 'BBB', shares: 500, avgPrice: 100, personaId: 'ai', openedAt: new Date('2026-09-01'), realizedPl: 0 }],
        createdAt: new Date('2026-09-01'), updatedAt: new Date(), ...fields });
}
async function worth(col) {
    const doc = await col.findOne({ user: 'u1' });
    return { doc, snap: await paper.computeSnapshot(doc, { session: DAY }) };
}
const near = (actual, expected, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('swapping out a loser keeps the loss: the total is the same before and after', async () => {
    await withMongo(async (col) => {
        wire(); await seed(col); px.AAA = 50;
        assert.equal((await worth(col)).snap.totalValue, 75000);
        const out = await paper.applySteering('u1', 'override', { slot: 'guru', symbol: 'CCC', reason: 'test' });
        assert.equal(out.ok, true);
        const after = await worth(col);
        near(after.snap.totalValue, 75000); near(after.snap.portfolioReturnPct, -25, 0.01);
        const swapped = after.doc.positions.find((p) => p.personaId === 'guru');
        assert.equal(swapped.symbol, 'CCC'); assert.equal(swapped.shares, 500); assert.equal(swapped.avgPrice, 50);
        assert.equal(swapped.realizedPl, -25000, 'the loss on the stock that was sold stays on the record');
    });
});

test('trimming a winner keeps the gain, and a rebalance after gains is allowed', async () => {
    await withMongo(async (col) => {
        wire(); await seed(col); px.AAA = 120;
        assert.equal((await worth(col)).snap.totalValue, 110000);
        assert.equal((await paper.applySteering('u1', 'allocate', { guruPct: 40, aiPct: 50 })).ok, true);
        let after = await worth(col);
        near(after.snap.totalValue, 110000);
        near(after.doc.cash, 11000); // the 10% left out of a $110,000 portfolio
        const trimmed = after.doc.positions.find((p) => p.personaId === 'guru');
        near(trimmed.shares * 120, 44000); assert.equal(trimmed.avgPrice, 100);
        near(trimmed.realizedPl, (500 - trimmed.shares) * 20);

        // A stock that doubled: 50/50 of what it is worth now, not of the starting $100,000.
        await seed(col); px.AAA = 200; px.BBB = 100;
        const out = await paper.applySteering('u1', 'allocate', { guruPct: 50, aiPct: 50 });
        assert.equal(out.ok, true, out.reason);
        after = await worth(col);
        near(after.snap.totalValue, 150000);
        for (const p of after.doc.positions) near(p.shares * px[p.symbol], 75000);
    });
});

test('a stock split changes the share count and the cost per share, never the value', async () => {
    await withMongo(async (col) => {
        wire(); await seed(col, { status: 'tracking' });
        const before = JSON.stringify((await col.findOne({ user: 'u1' })).positions);
        // An ordinary day leaves the positions exactly as they were.
        assert.deepEqual((await paper.applySplits(await col.findOne({ user: 'u1' }), PREV)).applied, []);
        assert.equal(JSON.stringify((await col.findOne({ user: 'u1' })).positions), before);
        // 10-for-1 on DAY: the unadjusted close drops from 100 to 10.
        px.AAA = 10; splits.AAA = [{ day: DAY, ratio: 10 }];
        const out = await paper.tickPortfolioOnce(await col.findOne({ user: 'u1' }));
        assert.equal(out.ticked, true);
        const doc = await col.findOne({ user: 'u1' });
        const split = doc.positions.find((p) => p.symbol === 'AAA');
        assert.equal(split.shares, 5000); assert.equal(split.avgPrice, 10); assert.equal(doc.splitsThrough, DAY);
        const snap = await mongoose.connection.collection('ai_paper_snapshots').findOne({ portfolioId: doc._id, date: DAY });
        assert.equal(snap.totalValue, 100000); assert.equal(snap.portfolioReturnPct, 0);
        const logged = await mongoose.connection.collection('ai_paper_decisions').findOne({ portfolioId: doc._id, type: 'corporate_action' });
        assert.match(logged.rationale, /AAA split 10-for-1/);
        // The same split is never applied twice.
        assert.deepEqual((await paper.applySplits(doc, DAY)).applied, []);
        // A lookup that fails is tried again next time instead of being skipped.
        await seed(col); paper.__setDeps({ splits: async () => { throw new Error('down'); } });
        assert.deepEqual((await paper.applySplits(await col.findOne({ user: 'u1' }), DAY)).unchecked, ['AAA', 'BBB']);
        assert.equal((await col.findOne({ user: 'u1' })).splitsThrough || '', '');
    });
});

test('a position with no readable close is carried at cost and flagged, not passed off as priced', async () => {
    await withMongo(async (col) => {
        wire(); await seed(col); failing.add('BBB');
        const { snap } = await worth(col);
        assert.deepEqual(snap.unpriced, ['BBB']);
        assert.equal(snap.marks.find((m) => m.symbol === 'BBB').unpriced, true);
        assert.equal(snap.marks.find((m) => m.symbol === 'AAA').unpriced, undefined);
    });
});

test('a day with no price data yet is tried again; a review that fails is not charged or counted', async () => {
    await withMongo(async (col) => {
        wire(); await seed(col, { status: 'committed', dayCount: 0 }); failing.add('SPY');
        const first = await paper.tickPortfolioOnce(await col.findOne({ user: 'u1' }));
        assert.equal(first.noop, true);
        assert.equal((await col.findOne({ user: 'u1' })).lastTickDay, '', 'the day was handed back');

        // Prices arrive, but the review cannot be written.
        failing.delete('SPY'); paper.__setDeps({ ...currentDeps(), llm: async () => { throw new Error('provider down'); } });
        const second = await paper.tickPortfolioOnce(await col.findOne({ user: 'u1' }));
        assert.equal(second.reviewDeferred, 'unavailable');
        let doc = await col.findOne({ user: 'u1' });
        assert.equal(doc.dayCount, 0, 'a review day was not used up'); assert.equal(doc.reviewFailures, 1); assert.deepEqual(spent, []);
        assert.ok(await mongoose.connection.collection('ai_paper_snapshots').findOne({ portfolioId: doc._id, date: DAY }), 'the day was still snapshotted');
    });
});
function currentDeps() {
    return { quote: async (s) => ({ 'Global Quote': { '01. symbol': s, '05. price': String(px[s]), '07. latest trading day': DAY } }),
        daily: async (s) => { if (failing.has(s)) throw new Error('feed down'); return { 'Time Series (Daily)': { [DAY]: { '4. close': String(px[s]) }, [PREV]: { '4. close': String(px[s]) } } }; },
        symbolSearch: async (s) => ({ bestMatches: [{ '1. symbol': s, '2. name': s + ' Inc', '3. type': 'EQUITY' }] }), splits: async () => [], searchWeb: async () => ({ headlines: [] }) };
}

test('a successful review is charged once; without credits there is no review and no build', async () => {
    await withMongo(async (col) => {
        wire(); await seed(col, { status: 'committed', dayCount: 0 });
        const out = await paper.tickPortfolioOnce(await col.findOne({ user: 'u1' }));
        assert.equal(out.day, 1); assert.deepEqual(spent, ['ai_paper_daily']);

        wire({ canAfford: async () => false }); await seed(col, { status: 'committed', dayCount: 0 });
        const broke = await paper.tickPortfolioOnce(await col.findOne({ user: 'u1' }));
        assert.equal(broke.reviewDeferred, 'credits'); assert.deepEqual(spent, []);
        assert.equal((await col.findOne({ user: 'u1' })).dayCount, 0);

        await col.deleteMany({});
        const events = [];
        const build = await paper.create({ user: { id: 'u2' }, guruId: '', constraints: [], onEvent: (e) => events.push(e) });
        assert.equal(build.ok, false); assert.equal(build.code, 'INSUFFICIENT_CREDITS');
        assert.equal(await col.countDocuments({ user: 'u2' }), 0, 'nothing was started');
        assert.match(events[0].message, /Not enough AI credits/);
    });
});

test('Stop throws a build away; Pause and Resume on a built portfolio skip and restore the nightly work', async () => {
    await withMongo(async (col) => {
        // A build that is still marked as running (its process is gone) is removed outright.
        wire(); await col.insertOne({ user: 'u1', status: 'building', positions: [], buildLog: [], createdAt: new Date(), updatedAt: new Date() });
        assert.deepEqual(await paper.discardBuild('u1'), { ok: true, discarded: true });
        assert.equal(await col.countDocuments({ user: 'u1' }), 0);
        assert.equal((await paper.discardBuild('u1')).ok, false, 'nothing left to stop');

        // A built portfolio is never removed by Stop.
        await seed(col, { status: 'committed', dayCount: 0 });
        assert.equal((await paper.discardBuild('u1')).ok, false);
        assert.equal(await col.countDocuments({ user: 'u1' }), 1);

        // Pause: logged, positions untouched, and the sweep leaves it alone.
        const before = JSON.stringify((await col.findOne({ user: 'u1' })).positions);
        assert.deepEqual(await paper.setTrackingPaused('u1', true), { ok: true, trackingPaused: true });
        assert.equal((await paper.detailFor('u1')).portfolio.trackingPaused, true);
        assert.equal(JSON.stringify((await col.findOne({ user: 'u1' })).positions), before);
        paper.sweep(); await new Promise((r) => setTimeout(r, 300));
        assert.equal(await mongoose.connection.collection('ai_paper_snapshots').countDocuments({}), 0, 'no snapshot while paused');
        assert.deepEqual(spent, [], 'nothing charged while paused');
        const log = await mongoose.connection.collection('ai_paper_decisions').find({ type: 'steering' }).toArray();
        assert.match(log[0].rationale, /Owner paused the experiment/);
        // Resume: the same call the other way; pausing twice changes nothing.
        assert.equal((await paper.setTrackingPaused('u1', false)).trackingPaused, false);
        assert.equal((await paper.setTrackingPaused('u1', false)).unchanged, true);
        assert.equal((await paper.setTrackingPaused('nobody', true)).ok, false);
    });
});
