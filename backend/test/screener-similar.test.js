'use strict';

// The "companies like X" screen (screen_universe's similar_to) and the
// browser-args whitelist behind "Use this screen on the page". Deliberately
// never asserts which tickers come back — frontend/data/screen-index.json is
// regenerated monthly, so a ticker list would go red for the snapshot rather
// than for a regression. The synthetic-row tests pin the logic; the
// integration tests pin the shape and the invariants against the real index.

const test = require('node:test');
const assert = require('node:assert/strict');
const aiChat = require('../ai-chat');

const row = (o) => ({ symbol: 'SYN', name: 'Synthetic Co', cik: '0001', ...o });
const DIMS = { revCagr5Pct: 20, netMarginPct: 25, roePct: 30, qtrNetIncomeYoYPct: 40 };

test('similarityDistance: identical rows score 0 on every shared factor', () => {
    const a = row(DIMS);
    const d = aiChat.similarityDistance(a, { ...a });
    assert.equal(d.distance, 0);
    assert.equal(d.dims, 4);
});

test('similarityDistance: symmetric, and ignores factors either side does not report', () => {
    const a = row(DIMS);
    const b = row({ revCagr5Pct: 5, netMarginPct: null, roePct: 80, qtrNetIncomeYoYPct: 1 });
    const ab = aiChat.similarityDistance(a, b);
    const ba = aiChat.similarityDistance(b, a);
    assert.equal(ab.dims, 3, 'net margin is null on b and must not count');
    assert.ok(Math.abs(ab.distance - ba.distance) < 1e-12, 'distance is a metric');
    assert.ok(ab.distance > 0);
});

test('similarityDistance: fewer than two comparable factors is no score at all', () => {
    const a = row(DIMS);
    const b = row({ revCagr5Pct: 20, netMarginPct: null, roePct: null, qtrNetIncomeYoYPct: null });
    assert.equal(aiChat.similarityDistance(a, b), null);
});

test('similarityDistance: sign is respected — a loss is not close to a profit of the same size', () => {
    const a = row({ revCagr5Pct: 10, netMarginPct: 20, roePct: 30, qtrNetIncomeYoYPct: 40 });
    const flipped = row({ revCagr5Pct: -10, netMarginPct: -20, roePct: -30, qtrNetIncomeYoYPct: -40 });
    assert.ok(aiChat.similarityDistance(a, flipped).distance > aiChat.similarityDistance(a, { ...a, netMarginPct: 0 }).distance);
});

test('resolveScreenAnchor: ticker, exact name, then a unique name fragment', () => {
    const rows = [row({ symbol: 'AAA', name: 'Alpha Corp' }), row({ symbol: 'BBB', name: 'Beta Inc' }), row({ symbol: 'CCC', name: 'Gamma Holdings' })];
    assert.equal(aiChat.resolveScreenAnchor(rows, 'aaa').row.symbol, 'AAA', 'ticker is case-insensitive');
    assert.equal(aiChat.resolveScreenAnchor(rows, 'beta inc').row.symbol, 'BBB');
    assert.equal(aiChat.resolveScreenAnchor(rows, 'gamma').row.symbol, 'CCC');
});

test('resolveScreenAnchor: an ambiguous fragment names candidates instead of guessing', () => {
    const rows = [row({ symbol: 'AAA', name: 'Alpha Corp' }), row({ symbol: 'BBB', name: 'Alpha Beta' }), row({ symbol: 'CCC', name: 'Alpha Gamma' }), row({ symbol: 'DDD', name: 'Alpha Delta' })];
    const out = aiChat.resolveScreenAnchor(rows, 'Alpha');
    assert.ok(out.error, 'ambiguous input is an error, never a silent pick');
    assert.ok(Array.isArray(out.candidates) && out.candidates.length <= 3);
    assert.match(out.error, /ticker/i);
});

test('resolveScreenAnchor: an unknown company explains why the universe ends there', () => {
    const out = aiChat.resolveScreenAnchor([row({ symbol: 'AAA', name: 'Alpha Corp' })], 'ZZZZZ');
    assert.ok(out.error);
    assert.match(out.error, /funds|private|foreign/i);
});

test('resolveScreenAnchor: empty input asks for the argument', () => {
    assert.ok(aiChat.resolveScreenAnchor([], '').error);
    assert.ok(aiChat.resolveScreenAnchor([], '   ').error);
});

test('screenArgsFromClient: whitelist only, and limit/sort_by/maxLimit can never come through', () => {
    const out = aiChat.screenArgsFromClient(JSON.stringify({
        similar_to: 'APP', min_net_margin_pct: '25', require_positive_fcf: 'true',
        exclude_secondary_listings: 1, limit: 999, maxLimit: 999, sort_by: 'pe', nonsense: 'x'
    }));
    assert.deepEqual(Object.keys(out).sort(), ['exclude_secondary_listings', 'min_net_margin_pct', 'require_positive_fcf', 'similar_to']);
    assert.equal(out.min_net_margin_pct, 25, 'numeric strings are coerced');
    assert.equal(out.require_positive_fcf, true);
    assert.equal(out.exclude_secondary_listings, true);
});

test('screenArgsFromClient: false booleans survive, junk never throws', () => {
    assert.equal(aiChat.screenArgsFromClient('{"require_positive_fcf":false}').require_positive_fcf, false);
    assert.deepEqual(aiChat.screenArgsFromClient('not json'), {});
    assert.deepEqual(aiChat.screenArgsFromClient(null), {});
    assert.deepEqual(aiChat.screenArgsFromClient('["similar_to"]'), {}, 'arrays are not an args object');
    assert.deepEqual(aiChat.screenArgsFromClient('{"similar_to":"' + 'x'.repeat(5000) + '"}'), {}, 'oversize payload is dropped whole');
    assert.equal(aiChat.screenArgsFromClient('{"similar_to":"  APP  "}').similar_to, 'APP', 'trimmed');
});

// ---- integration against the real index (shape and invariants only) --------

function pickAnchor() {
    const rows = aiChat.buildScreenIndex();
    const usable = rows.filter((r) => r.symbol && !r.symbol.includes('-') && Object.keys(DIMS).every((k) => r[k] !== null && r[k] !== undefined));
    assert.ok(usable.length > 100, 'the index still has a deep set of fully-reported companies');
    usable.sort((a, b) => (b.marketCapB || 0) - (a.marketCapB || 0));
    return usable[0];
}

test('similar screen: anchor excluded, ranking is monotone, factors are copied not mutated', () => {
    const anchor = pickAnchor();
    const probe = aiChat.buildScreenIndex().find((r) => r.symbol !== anchor.symbol);
    const res = aiChat.screenRows({ similar_to: anchor.symbol });
    assert.ok(res.matched > 0);
    assert.equal(res.rows.length, Math.min(10, res.matched), 'default limit is 10');
    assert.ok(!res.rows.some((r) => r.symbol === anchor.symbol), 'the anchor itself never comes back');
    const sims = res.rows.map((r) => r.similarity);
    for (const s of sims) assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, `similarity ${s} out of range`);
    for (let i = 1; i < sims.length; i++) assert.ok(sims[i] <= sims[i - 1], 'rows are ranked by proximity');
    // The index is a module-level cache shared by every caller — a screen that
    // wrote its similarity onto cached rows would leak into every later screen.
    assert.ok(!('similarity' in probe), 'cached index rows are never mutated');
    assert.equal(aiChat.metricsFor(anchor.symbol).similarity, undefined);
});

test('similar screen: the evidence block dates the factors and refuses the peer-classification reading', () => {
    const anchor = pickAnchor();
    const res = aiChat.screenRows({ similar_to: anchor.symbol });
    const s = res.similarTo;
    assert.equal(s.symbol, anchor.symbol);
    assert.equal(s.excludedSymbol, anchor.symbol);
    assert.equal(s.sectorConstrained, false);
    for (const k of Object.keys(DIMS)) assert.ok(k in s.factors, k);
    assert.equal(typeof s.rankedBy, 'string');
    assert.ok(s.rankedBy.length > 20);
    assert.match(s.note, /not an industry-peer classification/i);
    assert.ok(Number.isInteger(s.skipped.belowMarketCapFloor));
    assert.ok(Number.isInteger(s.skipped.tooFewComparableFactors));
    assert.ok(Array.isArray(s.skippedAnchorDims));
});

test('similar screen: an unknown anchor is an honest error, never an empty table', () => {
    const res = aiChat.screenRows({ similar_to: 'ZZZZZZZZ' });
    assert.ok(res.error);
    assert.equal(res.matched, 0);
    assert.deepEqual(res.rows, []);
    const tool = aiChat.runTool('screen_universe', { similar_to: 'ZZZZZZZZ' });
    assert.ok(tool.error, 'the tool result carries the error, not a blank list');
});

test('similar screen: caller filters compose, and page-side limit/maxLimit are honoured', () => {
    const anchor = pickAnchor();
    const base = aiChat.screenRows({ similar_to: anchor.symbol, maxLimit: 100 });
    const floor = aiChat.screenRows({ similar_to: anchor.symbol, min_market_cap_billions: 50, maxLimit: 100 });
    assert.ok(floor.matched <= base.matched, 'a floor can only narrow the set');
    for (const r of floor.rows) assert.ok(r.marketCapB >= 50);
    const wide = aiChat.screenRows({ similar_to: anchor.symbol, limit: 100, maxLimit: 100 });
    assert.equal(wide.rows.length, Math.min(100, wide.matched));
});

test('similar screen through the tool: the table gains a similarity column and the payload the evidence block', () => {
    const anchor = pickAnchor();
    const out = aiChat.runTool('screen_universe', { similar_to: anchor.symbol, limit: 3 });
    assert.equal(out.similarTo.symbol, anchor.symbol);
    assert.equal(out.returned, Math.min(3, out.matched));
    const lines = out.table.split('\n');
    assert.match(lines[0], /similarity/i, 'the header names the column');
    assert.equal(lines.length - 1, out.returned, 'one body line per returned row');
    assert.match(out.note, /resemblance/i);
});

test('the tool schema tells the model when to reach for similar_to', () => {
    const tool = aiChat.TOOLS.find((t) => t.function.name === 'screen_universe');
    assert.ok(tool.function.parameters.properties.similar_to);
    assert.match(tool.function.description, /companies like X/i);
    // The filters the shared core always supported must be expressible.
    for (const k of ['max_revenue_cagr_5y_pct', 'max_roe_pct', 'max_market_cap_billions', 'max_peg', 'min_price_to_book', 'max_price_to_book', 'exclude_secondary_listings']) {
        assert.ok(tool.function.parameters.properties[k], `${k} is missing from the schema`);
    }
    assert.ok(tool.function.parameters.properties.sort_by.enum.includes('fcfAbs'));
});
