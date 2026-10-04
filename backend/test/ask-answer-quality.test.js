'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.OLLAMA_API_KEY = 'test-only-key';
process.env.SEC_COVERAGE_READ_ONLY = '1';
process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
const q = require('../ask-answer-quality');
const evidence = require('../ask-evidence');
const ask = require('../ai-chat');
const fixture = require('./fixtures/ask-apple-verified.json');
const cache = require('../fundamentals-cache');
const originalLoad = cache.loadFundamentals;
afterEach(() => { ask.__resetDeps(); cache.loadFundamentals = originalLoad; });
function useFixture() { cache.loadFundamentals = symbol => symbol === 'AAPL' ? structuredClone(fixture) : originalLoad(symbol); }
const tool = (id, statement) => ({ id, type: 'function', function: { name: 'get_financials', arguments: JSON.stringify({ symbol: 'AAPL', statement, limit: 2 }) } });
const spec = (points, unit = 'USD', type = 'viz', name = 'Revenue') => '```' + type + '\n' + JSON.stringify(type === 'viz' ? { unit, series: [{ name, points }] } : { unit, rows: points }) + '\n```';
const get = async statement => { useFixture(); return [{ tool: 'get_financials', result: await ask.runTool('get_financials', { symbol: 'AAPL', statement, limit: 2 }) }]; };

test('capital-return coverage preserves exact inputs and does not invent missing payouts', async () => {
    const [{ result }] = await get('cash'), c = result.capitalReturns[0];
    assert.equal(c.totalDistributions, 106132000000);
    assert.equal(c.surplusAfterDistributions, -7365000000);
    assert.equal(c.coveredByFreeCashflow, false);
    assert.equal(c.inputs.freeCashflow.value, 98767000000);
    for (const id of c.sourceIds) assert.ok(result.provenance.sources[id]);
    const row = structuredClone(fixture.cash.annualReports[0]);
    row.dividendPayout = 0; row.paymentsForRepurchaseOfCommonStock = 0;
    assert.equal(evidence.capitalReturns(row).coveredByFreeCashflow, true);
    row.paymentsForRepurchaseOfCommonStock = null;
    assert.equal(evidence.capitalReturns(row).coveredByFreeCashflow, null);
});

test('observed false FCF coverage assertion is rejected, accurate shortfall is allowed', async () => {
    const data = await get('cash');
    assert.match(q.audit('FY2025 free cash flow comfortably covers dividends and buybacks.', data).join(' '), /shortfall 7365000000/);
    assert.deepEqual(q.audit('FY2025 free cash flow does not cover dividends and buybacks; the shortfall is USD 7.365bn.', data), []);
});

test('incorrect reported money and growth cannot pass because a tool was called', async () => {
    const income = await get('income');
    assert.match(q.audit('Revenue was USD 999 billion.', income).join(' '), /Monetary claim/);
    const cash = await get('cash');
    assert.match(q.audit('Capex rose 34.3%.', cash).join(' '), /Percentage claim/);
    assert.deepEqual(q.audit('Capex rose 34.6%, or $3.3bn. Operating cash flow fell $6.8bn.', cash), []);
    const bad = structuredClone(cash); bad[0].result.observations[0].fields.operatingCashflow.value = -111482000000;
    bad[0].result.comparisons = null;
    assert.match(q.audit('Operating cash flow was $111.482bn.', bad).join(' '), /Monetary claim/);
});

test('raw category bars match evidence; millionfold scale and wrong currencies fail', async () => {
    const data = await get('cash');
    const points = [['Operating cash flow', 111482000000], ['Capex', 12715000000], ['Free cash flow', 98767000000]];
    assert.deepEqual(q.audit(spec(points, 'USD', 'bars'), data), []);
    assert.match(q.audit(spec(points.map(([label, value]) => [label, value / 1e6]), 'USD', 'bars'), data).join(' '), /raw unscaled/);
    assert.match(q.audit(spec(points, 'JPY', 'bars'), data).join(' '), /declared unit/);
    assert.match(q.audit(spec(points, 'USD', 'viz'), data).join(' '), /time sequence/);
});

test('chart metric labels and actual dates must match the sourced observation', async () => {
    const data = await get('income');
    const good = spec([['2024-09-28', 391035000000], ['2025-09-27', 416161000000]]);
    assert.deepEqual(q.audit(good, data), []);
    assert.match(q.audit(good.replace('2025-09-27', '2025-09-30'), data).join(' '), /date/);
    assert.match(q.audit(good.replace('Revenue', 'Net income'), data).join(' '), /metric label/);
});

test('chart gaps, zero, unsupported numbers and duplicate labels remain truthful', () => {
    const data = [{ observations: [{ fields: { totalRevenue: { value: 0, unit: 'USD', sourceIds: ['zero'] } } }] }];
    assert.deepEqual(q.audit(spec([['2024', null], ['2025', 0]]), data), []);
    assert.match(q.audit(spec([['2024', 99], ['2025', 0]]), data).join(' '), /no exact supplied source/);
    assert.match(q.audit(spec([['2025', 0], ['2025', 0]]), data).join(' '), /unique/);
    assert.match(q.audit('```viz\n{"unit":"USD"}', data).join(' '), /incomplete/);
});

test('calculated percentages and dimensionless ratios retain their own units', () => {
    const data = [{ observations: [{ periodEnd: '2025-12-31', currency: 'JPY', metrics: {
        netMarginPct: { value: 12.5, sourceIds: ['income', 'revenue'] },
        currentRatio: { value: 1.5, sourceIds: ['assets', 'liabilities'] }
    } }] }];
    assert.deepEqual(q.audit(spec([['2024', null], ['2025-12-31', 12.5]], '%', 'viz', 'Net margin'), data), []);
    assert.deepEqual(q.audit(spec([['2024', null], ['2025-12-31', 1.5]], 'x', 'viz', 'Current ratio'), data), []);
});

test('share-basis suppression cannot be described as absent issuer XBRL', () => {
    const data = [{ coverage: { perShareAllowed: false } }];
    assert.match(q.audit('EPS is not populated in filed XBRL.', data).join(' '), /security\/ADR basis/);
    assert.deepEqual(q.audit('EPS is unavailable because the ADR basis is unverified.', data), []);
});

test('unsupported investment causation fails; explicit unknown causes and retrieved narrative are allowed', () => {
    assert.match(q.audit('Capex rose, likely tied to AI/data-centre investment.', []).join(' '), /supporting retrieved narrative/);
    assert.deepEqual(q.audit('Capex rose; its cause is not established by these cash-flow facts.', []), []);
    assert.deepEqual(q.audit('Capex rose due to AI infrastructure, according to the retrieved filing.', [{ tool: 'fetch_page', result: { text: 'Filing narrative' } }]), []);
});

test('length counts visible prose, not chart JSON/URLs; explicit and detailed requests are respected', () => {
    assert.equal(q.wordCount('[Source](https://example.com/very-long-url) hello ' + spec([['2024', 1], ['2025', 2]])), 2);
    assert.equal(q.wordLimit('Keep it under 150 words.', 'normal'), 150);
    assert.equal(q.wordLimit('A detailed analysis.', 'normal'), 550);
    assert.match(q.audit('word '.repeat(251), [], { mode: 'normal' }).join(' '), /250/);
});

test('financial chart prose cannot describe line series as bars', async () => {
    const data = await get('income');
    const chart = spec([['2024-09-28', 391035000000], ['2025-09-27', 416161000000]]);
    assert.match(q.audit(chart + '\nEach bar shows reported revenue.', data).join(' '), /line chart/);
});

test('fallback discloses payout coverage and labels instruments without exposing tool instructions', async () => {
    const data = await get('cash');
    data.push({ result: { code: 'UNSUPPORTED_SECURITY_TYPE', symbol: 'HCACU', securityType: 'unit', error: 'Explain the instrument and continue research.' } });
    const text = q.fallback(data, 'Does Apple annual free cash flow cover dividends plus buybacks?');
    assert.match(text, /106\.132bn/); assert.match(text, /shortfall USD 7\.365bn/);
    assert.match(text, /HCACU is a unit/); assert.doesNotMatch(text, /Explain the instrument/);
    assert.match(text, /98\.767bn/);
});

test('valid cash magnitudes and precise deficit calculations are not rejected', async () => {
    const cash = await get('cash');
    assert.deepEqual(q.numericClaims('Distributions exceeded FCF by $7.365bn, a shortfall of 7.5% of FCF. Financing showed a $120.686bn net outflow.', cash), []);
    const negative = [{ observations: [{ fields: { operatingCashflow: { value: -2400000, unit: 'USD', sourceIds: ['fact'] } } }] }];
    assert.deepEqual(q.numericClaims('Operating cash flow was negative $2.4m; operations consumed $2.4m.', negative), []);
});

test('annual comparisons expose capex growth with verified magnitude inputs', async () => {
    const [{ result }] = await get('cash');
    assert.ok(Math.abs(result.comparisons.yoy.metrics.capitalExpenditures.changePct - 34.5929924844) < 1e-8);
    assert.ok(result.comparisons.yoy.metrics.freeCashflow.changePct < -9);
    assert.equal(result.comparisons.yoy.metrics.freeCashflow.current.derivation.formula, 'operatingCashflow - abs(capitalExpenditures)');
    for (const c of Object.values(result.comparisons.yoy.metrics)) for (const id of c.sourceIds) assert.ok(result.provenance.sources[id]);
});

test('upstream synthesis failure preserves successful financial evidence', async () => {
    useFixture(); let count = 0;
    ask.__setDeps({ chatRaw: async () => {
        if (++count === 1) return { tool_calls: [tool('cash', 'cash')] };
        throw new Error('request rejected');
    } });
    const r = await ask.ask({ question: 'Apple free cash flow?', ctx: {} });
    assert.equal(r.source, 'partial'); assert.ok(r.quality.synthesisUnavailable);
    assert.match(r.answer, /98\.767bn/); assert.doesNotMatch(r.answer, /request rejected/);
});

test('actual tool missing fields carry share-basis reasons', async () => {
    const r = await ask.runTool('get_financials', { symbol: 'MUFG', statement: 'income', limit: 1 });
    assert.equal(r.observations[0].fields.eps.value, null);
    assert.match(r.observations[0].fields.eps.missingReason, /ADR basis/);
});

test('failed answer validation gets one rewrite and truthful partial fallback', async () => {
    useFixture(); let calls = 0;
    const bad = 'FY2025 free cash flow comfortably covers dividends and buybacks.';
    ask.__setDeps({ chatRaw: async () => { calls++; return calls === 1 ? { tool_calls: [tool('cash', 'cash')] } : { content: bad }; } });
    const r = await ask.ask({ question: 'Apple annual free cash flow, capex and operating cash flow?', mode: 'normal', ctx: {} });
    assert.equal(calls, 3); assert.equal(r.source, 'partial'); assert.equal(r.quality.fallback, true);
    assert.doesNotMatch(r.answer, /comfortably covers/); assert.match(r.answer, /98\.767bn/);
});

test('rewrite corrects a bad chart; streamed financial output is held until validation', async () => {
    useFixture(); let calls = 0; const events = [];
    const good = spec([['Operating cash flow', 111482000000], ['Free cash flow', 98767000000]], 'USD', 'bars');
    const bad = good.replace('111482000000', '111482').replace('98767000000', '98767');
    const next = async () => { calls++; return calls === 1 ? { tool_calls: [tool('cash', 'cash')] } : { content: calls === 2 ? bad : good }; };
    ask.__setDeps({ chatRaw: next, chatRawStream: async (messages, opts, delta) => { const r = await next(); if (r.content) delta(r.content); return r; } });
    const r = await ask.ask({ question: 'Apple annual operating cash flow and free cash flow chart?', mode: 'normal', ctx: {}, onEvent: e => events.push(e) });
    assert.equal(calls, 3); assert.equal(r.source, 'ai'); assert.equal(r.quality.rewritten, true);
    assert.equal(events.filter(e => e.type === 'delta').length, 1); assert.equal(events.at(-1).text, r.answer);
    assert.ok(!events.some(e => e.type === 'delta' && e.text.includes('111482,')));
});

test('rewrite failures and identity leaks cannot publish rejected content', async () => {
    useFixture(); let calls = 0;
    ask.__setDeps({ chatRaw: async () => {
        calls++;
        if (calls === 1) return { tool_calls: [tool('cash', 'cash')] };
        if (calls === 2) return { content: 'FY2025 free cash flow covers dividends and buybacks.' };
        throw new Error('upstream failure');
    } });
    const r = await ask.ask({ question: 'Apple free cash flow?', ctx: {} });
    assert.equal(r.source, 'partial'); assert.ok(r.quality.fallback); assert.doesNotMatch(r.answer, /upstream failure/);
});

test('mobile financial charts abbreviate axes, adapt viewBox and provide accessible dates', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');
    const code = source.slice(source.indexOf('    function chart('), source.indexOf('    // A completed answer'));
    const box = { num: v => v == null ? null : Number(v), money: v => Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : String(v), fixed: (v, dp) => Number(v).toFixed(dp), esc: v => String(v), document: { documentElement: { clientWidth: 390 }, querySelector: () => ({ clientWidth: 342 }) } };
    vm.runInNewContext(code + '\nthis.render = vizBlock; this.bars = barsBlock;', box);
    const html = box.render(JSON.stringify({ unit: 'USD', series: [{ name: 'Revenue', points: [['2024-09-28', 391035000000], ['2025-09-27', 416161000000]] }] }));
    assert.match(html, /viewBox="0 0 310 260"/); assert.match(html, /font-size="12"/);
    assert.match(html, /USD 400.0B/); assert.match(html, /<desc>Revenue: 2024-09-28/);
    assert.doesNotMatch(html, />400,000,000,000</);
    const annual = box.render(JSON.stringify({ unit: 'JPY', series: [{ name: 'Revenue', points: [['FY ended 31 Mar 2025', 10e12], ['FY ended 31 Mar 2026', 11e12]] }] }));
    assert.match(annual, />FY2025<\/text>/); assert.match(annual, />FY2026<\/text>/);
    assert.doesNotMatch(annual, />FY ended 31 Mar 2025<\/text>/);
    const bars = box.bars(JSON.stringify({ unit: 'USD', rows: [['Zero', 0], ['Outflow', -5]] }));
    assert.match(bars, /width:0.0%/); assert.match(bars, /is-negative/);
});
