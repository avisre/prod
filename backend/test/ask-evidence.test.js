'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY = '1';
process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
process.env.DISABLE_BACKGROUND_JOBS = '1';
process.env.OLLAMA_API_KEY = 'test-only-key';
const e = require('../ask-evidence');
const ask = require('../ai-chat');
const cache = require('../fundamentals-cache');
const originalLoad = cache.loadFundamentals;
const appleFixture = require('./fixtures/ask-apple-verified.json');
function useAppleFixture() {
    // Pin the audited periods so normal daily data refreshes cannot change
    // the expected regression figures or move the fixture's reporting clock.
    cache.loadFundamentals = symbol => symbol === 'AAPL' ? structuredClone(appleFixture) : originalLoad(symbol);
}
afterEach(() => { ask.__resetDeps(); cache.loadFundamentals = originalLoad; });

function row(end, start, revenue, currency = 'USD', extra = {}) {
    return { fiscalDateEnding: end, periodStart: start, periodType: 'quarterly', reportedCurrency: currency,
        totalRevenue: revenue, _sources: { totalRevenue: ['fact-' + end] }, _scopes: { totalRevenue: 'consolidated' }, ...extra };
}
const quarters = () => [row('2026-06-27', '2026-03-29', 109417), row('2025-09-27', '2025-06-29', 102466),
    row('2025-06-28', '2025-03-30', 94036), row('2026-03-28', '2025-12-28', 100000)];

test('quarterly comparisons match actual dates despite missing and unordered rows', () => {
    const c = e.quarterlyComparisons(quarters(), ['totalRevenue']);
    assert.equal(c.yoy.periodEnd, '2025-06-28');
    assert.equal(c.qoq.periodEnd, '2026-03-28');
    assert.ok(Math.abs(c.yoy.metrics.totalRevenue.changePct - 16.3565017653) < 1e-8);
    assert.deepEqual(c.yoy.metrics.totalRevenue.sourceIds, ['fact-2026-06-27', 'fact-2025-06-28']);
});

test('53-week quarters qualify; annual/YTD and wrong-quarter comparators do not', () => {
    const latest = row('2026-07-04', '2026-03-29', 10);
    const prior = row('2025-06-28', '2025-03-30', 5);
    assert.equal(e.quarterlyComparisons([latest, prior], ['totalRevenue']).yoy.metrics.totalRevenue.changePct, 100);
    prior.periodStart = '2025-01-01';
    assert.equal(e.quarterlyComparisons([latest, prior], ['totalRevenue']).yoy.periodEnd, null);
    assert.equal(e.quarterlyComparisons(quarters().slice(0, 2), ['totalRevenue']).yoy.periodEnd, null);
});

test('missing, zero, negative, foreign-currency and ambiguous comparison bases stay truthful', () => {
    for (const value of [null, 0, -5]) {
        const rows = quarters(); rows[2].totalRevenue = value;
        assert.equal(e.quarterlyComparisons(rows, ['totalRevenue']).yoy.metrics.totalRevenue.changePct, null);
    }
    const rows = quarters(); rows[0].totalRevenue = 0;
    assert.equal(e.quarterlyComparisons(rows, ['totalRevenue']).yoy.metrics.totalRevenue.changePct, -100);
    rows[2].reportedCurrency = 'JPY';
    assert.equal(e.quarterlyComparisons(rows, ['totalRevenue']).yoy.periodEnd, null);
    const ambiguous = quarters(); ambiguous.push(row('2025-06-27', '2025-03-29', 8));
    assert.equal(e.quarterlyComparisons(ambiguous, ['totalRevenue']).yoy.periodEnd, null);
});

test('source-free provider numbers cannot become verified observations', () => {
    const r = row('2025-06-28', '2025-03-30', 5); r._sources = {};
    assert.equal(e.observation(r, 'totalRevenue').value, null);
});

test('FCF uses capex magnitude, zero remains valid, missing inputs stay null', () => {
    const r = row('2025-09-27', '2024-09-29', null, 'USD', { operatingCashflow: 111482, capitalExpenditures: 12715,
        _sources: { operatingCashflow: ['ocf'], capitalExpenditures: ['capex'] } });
    assert.equal(e.freeCashFlow(r).value, 98767);
    r.capitalExpenditures = -12715; assert.equal(e.freeCashFlow(r).value, 98767);
    assert.deepEqual(e.freeCashFlow(r).sourceIds, ['ocf', 'capex']);
    r.capitalExpenditures = 0; assert.equal(e.freeCashFlow(r).value, 111482);
    r.capitalExpenditures = null; assert.equal(e.freeCashFlow(r).value, null);
});

// AppLovin FY2024 read a 65% FCF margin: revenue restated to continuing
// operations against operating cash flow that still held the sold apps business.
test('a year with discontinued operations sets only continuing cash flow against revenue', async () => {
    const withDiscontinued = (continuing) => {
        const d = structuredClone(appleFixture), inc = d.income.annualReports[0];
        const cash = d.cash.annualReports.find(r => r.fiscalDateEnding === inc.fiscalDateEnding);
        Object.assign(inc, { discontinuedOperations: -9748000 }); inc._sources = { ...inc._sources, discontinuedOperations: ['disc'] };
        if (continuing !== undefined) { cash.operatingCashflowContinuing = continuing; cash._sources = { ...cash._sources, operatingCashflowContinuing: ['cont'] }; cash._scopes = { ...cash._scopes, operatingCashflowContinuing: cash._scopes?.capitalExpenditures }; }
        cache.loadFundamentals = symbol => symbol === 'AAPL' ? structuredClone(d) : originalLoad(symbol);
        return { inc, cash };
    };
    const { inc } = withDiscontinued();
    let r = await ask.runTool('get_ratios_history', { symbol: 'AAPL', limit: 2, metrics: ['fcfMarginPct', 'capexPctRevenue', 'ocfToNetIncome'] });
    let latest = r.observations.find(o => o.periodEnd === inc.fiscalDateEnding).metrics;
    assert.equal(latest.fcfMarginPct.value, null);
    assert.equal(latest.capexPctRevenue.value, null);
    assert.match(latest.fcfMarginPct.missingReason, /discontinued operations/);
    assert.notEqual(latest.ocfToNetIncome.value, null);
    assert.notEqual(r.observations.find(o => o.periodEnd !== inc.fiscalDateEnding).metrics.fcfMarginPct.value, null);
    const { cash } = withDiscontinued(100000000000);
    r = await ask.runTool('get_ratios_history', { symbol: 'AAPL', limit: 1, metrics: ['fcfMarginPct'] });
    latest = r.observations[0].metrics.fcfMarginPct;
    assert.equal(latest.inputs.numerator.formula, 'operatingCashflowContinuing - abs(capitalExpenditures)');
    assert.equal(latest.value, (1e11 - Math.abs(cash.capitalExpenditures)) / inc.totalRevenue * 100);
    // A reported zero is no discontinued business.
    assert.deepEqual(e.revenueCashBasis({ discontinuedOperations: 0, _sources: { discontinuedOperations: ['d'] } }, {}), { operatingCashflow: 'operatingCashflow' });
});

test('calculated ratios require period, unit and optional scope compatibility', () => {
    const a = e.observation(row('2025-06-28', '2025-03-30', 5), 'totalRevenue');
    const calculate = b => e.calculate({ a, b }, 'a / b', (x, y) => x / y, { sameScope: true }).value;
    assert.equal(calculate({ ...a, value: 10 }), 0.5);
    assert.equal(calculate({ ...a, scope: 'parent' }), null);
    assert.equal(calculate({ ...a, currency: 'JPY' }), null);
    assert.equal(calculate({ ...a, periodEnd: '2025-07-01' }), null);
    assert.equal(calculate({ ...a, periodStart: '2025-01-01' }), null);
});

test('Apple fixture through the real tool supplies correct growth even with limit 1', async () => {
    useAppleFixture();
    const r = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', basis: 'quarterly', limit: 1 });
    assert.equal(r.observations.length, 1);
    assert.equal(r.comparisons.periodEnd, '2026-06-27');
    assert.equal(r.comparisons.yoy.periodEnd, '2025-06-28');
    assert.ok(Math.abs(r.comparisons.yoy.metrics.totalRevenue.changePct - 16.3565017653) < 1e-8);
    assert.ok(Math.abs(r.comparisons.yoy.metrics.netIncome.changePct - 27.1187163950) < 1e-8);
});

test('two-year Apple income is compact and every populated field has its exact sources', async () => {
    useAppleFixture();
    const r = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', limit: 2 });
    // 24KB since 10-17: the weighted basic and diluted share counts were added, each with its filing.
    // The model reads the lean view from ask-report-evidence, not this payload.
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 24 * 1024);
    const referenced = new Set();
    for (const observation of r.observations) for (const field of Object.values(observation.fields)) {
        if (field.value === null) continue;
        assert.ok(field.sourceIds.length);
        for (const id of field.sourceIds) { assert.ok(r.provenance.sources[id]); referenced.add(id); }
    }
    assert.deepEqual(new Set(Object.keys(r.provenance.sources)), referenced);
});

test('Apple annual cash keeps actual fiscal dates and calculated FCF', async () => {
    useAppleFixture();
    const r = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'cash', limit: 2 });
    assert.equal(r.observations[0].periodEnd, '2025-09-27');
    assert.equal(r.observations[1].periodEnd, '2024-09-28');
    assert.equal(r.calculations[0].value, 98767000000);
    assert.equal(r.calculations[1].value, 108807000000);
    assert.equal(r.observations[0].fields.capitalExpenditures.transformation.multiplier, -1);
});

test('ratio history fits budget, discloses omitted rows and supports older windows', async () => {
    const r = await ask.runTool('get_ratios_history', { symbol: 'AAPL', limit: 20 });
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= e.MAX_RESULT_BYTES);
    assert.ok(r.history.omittedReason);
    assert.equal(r.history.returnedPeriods, r.observations.length);
    const oldest = r.observations.at(-1).periodEnd;
    const older = await ask.runTool('get_ratios_history', { symbol: 'AAPL', limit: 2, before: oldest });
    assert.ok(older.observations[0].periodEnd < oldest);
    assert.ok(r.observations[0].metrics.roePct.sourceIds.length);
});

test('foreign financial and health tools use native currency and compact exact provenance', async () => {
    for (const tool of ['get_financials', 'get_health_checks']) {
        const r = await ask.runTool(tool, { symbol: 'MUFG', statement: 'income', limit: 2 });
        assert.equal(r.currency, 'JPY');
        assert.ok(r.coverage);
        assert.ok(Object.keys(r.provenance.sources).length);
        assert.ok(Buffer.byteLength(JSON.stringify(r)) <= e.MAX_RESULT_BYTES);
    }
    assert.doesNotMatch(ask.ASK_SYSTEM, /their statements are converted to USD|row four down/);
    assert.match(ask.ASK_SYSTEM, /comparisons\.yoy/);
});

test('quote tools and shared adapter suppress ambiguous share-class and ADR ratios', async () => {
    for (const symbol of ['BRK.B', 'GOOGL', 'MUFG']) {
        const d = ask.loadFund(symbol);
        assert.equal(d.coverage.perShareAllowed, false);
        assert.equal(d.marketData?.trailingPE ?? null, null);
        assert.equal(d.marketData?.sharesOutstanding ?? null, null);
        const r = await ask.runTool('get_quote', { symbol });
        assert.equal(r.peRatio, null); assert.equal(r.eps, null);
        assert.equal(r.fundamentalsAsOf, d.income.annualReports[0].fiscalDateEnding);
        assert.equal(r.currency, d.marketData?.currency || null);
        if (d.marketData) assert.equal(r.asOf, d.marketData.asOf);
        assert.ok(r.missingReasons.perShare);
    }
});

test('partial, historical and unavailable stocks preserve coverage and missing facts', async () => {
    for (const symbol of ['AAMI', 'OZK', 'CLX']) {
        const r = await ask.runTool('get_financials', { symbol, statement: 'income', limit: 1 });
        const d = ask.loadFund(symbol);
        if (r.error) { assert.ok(r.code || r.coverage); continue; }
        assert.equal(r.coverage.financialCoverage, d.coverage.financialCoverage);
        if (r.verifiedObservations) {
            // No SEC rows (e.g. a bank holding company): only attributed supplemental figures, within the period limit.
            assert.equal(r.verifiedObservations.length, 0);
            assert.ok(new Set(r.supplementalObservations.map(f => f.periodEnd)).size <= 1);
            for (const f of r.supplementalObservations) assert.ok(f.sourceName && f.sourceUrl);
            continue;
        }
        for (const field of Object.values(r.observations[0].fields)) if (!field.sourceIds.length) assert.equal(field.value, null);
    }
});

test('oversized context is explicitly unavailable, never silently truncated', () => {
    const result = { table: 'x'.repeat(e.MAX_RESULT_BYTES) };
    assert.equal(JSON.parse(e.serializeResult(result, e.MAX_CONTEXT_BYTES)).code, 'TOOL_CONTEXT_LIMIT');
    assert.equal(JSON.parse(e.serializeResult({ price: 1 }, 0)).code, 'TOOL_CONTEXT_LIMIT');
});

const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function scripted(responses, streaming = false) {
    const calls = [];
    const chatRaw = async messages => { calls.push(JSON.parse(JSON.stringify(messages))); return responses.shift(); };
    const chatRawStream = async (messages, opts, delta) => { const r = await chatRaw(messages); if (streaming && r.content) delta(r.content); return r; };
    ask.__setDeps({ chatRaw, chatRawStream });
    return calls;
}

test('unit and right failures are per-tool replies; supported company research continues', async () => {
    const calls = scripted([
        { tool_calls: [tc('unit', 'get_financials', { symbol: 'HCACU' }), tc('right', 'get_financials', { symbol: 'GENVR' }),
            tc('stock', 'get_financials', { symbol: 'AAPL', statement: 'income', limit: 1 })] },
        { content: 'Units and rights do not have company financial analysis. Apple annual revenue is available.' }
    ]);
    const r = await ask.ask({ question: 'Compare AAPL, HCACU and GENVR revenue.', ctx: {} });
    assert.equal(r.source, 'ai');
    assert.deepEqual(r.toolsUsed.map(t => t.ok), [false, false, true]);
    const replies = calls[1].filter(m => m.role === 'tool'); assert.equal(replies.length, 3);
    assert.equal(JSON.parse(replies[0].content).code, 'UNSUPPORTED_SECURITY_TYPE');
    assert.equal(JSON.parse(replies[1].content).code, 'UNSUPPORTED_SECURITY_TYPE');
    assert.match(r.answer, /https:\/\/www\.sec\.gov\/Archives/);
});

test('failed tools redact upstream secrets and still reach synthesis', async () => {
    const calls = scripted([{ tool_calls: [tc('fail', 'ai_portfolio_probe', {})] }, { content: 'That data is unavailable.' }]);
    const r = await ask.ask({ question: 'Research my portfolio.', ctx: {
        aiPaperTools: [], aiPaperRunTool: () => { throw new Error('secret-provider-token'); }
    } });
    assert.equal(r.source, 'ai');
    assert.equal(JSON.parse(calls[1].find(m => m.role === 'tool').content).code, 'TOOL_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(calls), /secret-provider-token/);
});

test('numeric financial answer without research retries once and fails truthfully', async () => {
    const calls = scripted([{ content: 'Apple revenue was USD 999 trillion.' }, { content: 'Apple revenue was USD 999 trillion.' }]);
    const r = await ask.ask({ question: 'What was Apple latest revenue?', ctx: {} });
    assert.equal(calls.length, 2);
    assert.equal(r.source, 'partial'); assert.doesNotMatch(r.answer, /999/);
});

test('unverified calculator numbers alone cannot authorize a financial claim', async () => {
    scripted([{ tool_calls: [tc('calc', 'calculator', { expression: '999' })] }, { content: 'Apple revenue was 999 trillion.' },
        { content: 'Apple revenue was 999 trillion.' }]);
    const r = await ask.ask({ question: 'What was Apple revenue?', ctx: {} });
    assert.equal(r.source, 'partial');
});

test('streaming ungrounded output rolls back; streaming citations match final answer', async () => {
    const events = [];
    scripted([{ content: 'Apple revenue was 999 trillion.' }, { content: 'Apple revenue was 999 trillion.' }], true);
    const bad = await ask.ask({ question: 'Apple revenue?', ctx: {}, onEvent: e => events.push(e) });
    assert.equal(bad.source, 'partial'); assert.equal(events.filter(e => e.type === 'rollback').length, 2);
    const nextEvents = [];
    scripted([{ tool_calls: [tc('data', 'get_financials', { symbol: 'AAPL', statement: 'income', limit: 1 })] },
        { content: 'Apple figures are in USD.\n> Next: What changed?' }], true);
    const good = await ask.ask({ question: 'Apple revenue?', ctx: {}, onEvent: e => nextEvents.push(e) });
    assert.equal(good.source, 'ai'); assert.ok(good.answer.endsWith('> Next: What changed?'));
    assert.equal(nextEvents.at(-1).text, good.answer);
});

test('concept definitions and explicit hypothetical inputs are not blocked', () => {
    assert.equal(e.requiresEvidence('What is net margin?', 'It is net income / revenue times 100.'), false);
    assert.equal(e.requiresEvidence('Suppose revenue is 200 and costs are 100.', 'Profit is 100.'), false);
    assert.equal(e.requiresEvidence("What is Apple's latest revenue?", '999 trillion.'), true);
    assert.equal(e.requiresEvidence('AAPL?', 'Apple revenue was USD 999 trillion.'), true);
    assert.equal(e.requiresEvidence('Apple revenue?', '```viz\n{"unit":"USD","series":[{"points":[["2025",999]]}]}\n```'), true);
});

test('aggregate tool results stay bounded and still reply to each call', async () => {
    const calls = scripted([{ tool_calls: Array.from({ length: 12 }, (_, i) => tc('t' + i, 'ai_portfolio_probe', {})) }, { content: 'Some results exceeded the research budget.' }]);
    const r = await ask.ask({ question: 'Research my portfolio.', ctx: { aiPaperRunTool: () => ({ text: 'x'.repeat(60 * 1024) }) } });
    assert.equal(r.source, 'ai');
    const replies = calls[1].filter(m => m.role === 'tool'); assert.equal(replies.length, 12);
    assert.ok(replies.reduce((sum, reply) => sum + Buffer.byteLength(reply.content), 0) <= e.MAX_CONTEXT_BYTES);
    assert.ok(replies.some(reply => JSON.parse(reply.content).code === 'TOOL_CONTEXT_LIMIT'));
});

test('native-currency Ask charts render ISO currency and per-share labels', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');
    const formatter = source.slice(source.indexOf('    function vizFmt('), source.indexOf('    function vizBlock('));
    const box = { money: v => String(v), fixed: (v, dp) => Number(v).toFixed(dp) };
    vm.runInNewContext(formatter + '\nthis.format = vizFmt;', box);
    assert.equal(box.format('JPY')(100), 'JPY 100');
    assert.equal(box.format('EUR/share')(1.5), 'EUR 1.50/share');
    assert.equal(box.format('%')(16.3565), '16.4%');
    assert.equal(box.format('$ps')(2), '$2.00');
});

test('Ask charts keep missing observations as gaps and retain reported zero', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');
    const parser = source.slice(source.indexOf('    function num('), source.indexOf('    // Compact money:'));
    const charts = source.slice(source.indexOf('    function vizFmt('), source.indexOf('    // A completed answer'));
    let captured;
    const box = { money: v => String(v), fixed: (v, dp) => Number(v).toFixed(dp), esc: v => String(v),
        chart: series => { captured = series; return '<svg></svg>'; } };
    vm.runInNewContext(parser + charts + '\nthis.line = vizBlock; this.bars = barsBlock;', box);
    const html = box.line(JSON.stringify({ unit: 'JPY', series: [{ name: 'Example', points: [['2021', 1], ['2022', null], ['2023', ' '], ['2024', 0]] }] }));
    assert.match(html, /<svg/);
    assert.deepEqual(Array.from(captured[0].values), [1, null, null, 0]);
    const bars = box.bars(JSON.stringify({ unit: 'JPY', rows: [['Missing', null], ['Placeholder', 'None'], ['Zero', 0], ['Negative', -1]] }));
    assert.doesNotMatch(bars, /Missing|Placeholder/);
    assert.match(bars, /Zero/); assert.match(bars, /Negative/);
});

function appleYears(n) {
    // n copies of the audited year, each moved back a year with its own sources, so history is long enough to hit the budget.
    const f = structuredClone(appleFixture), base = f.income.annualReports[0];
    const shift = (d, i) => d && (Number(d.slice(0, 4)) - i) + d.slice(4);
    f.income.annualReports = Array.from({ length: n }, (_, i) => {
        const r = structuredClone(base);
        r.fiscalDateEnding = shift(r.fiscalDateEnding, i); r.periodStart = shift(r.periodStart, i);
        for (const [k, ids] of Object.entries(r._sources)) r._sources[k] = ids.map(id => {
            const s = { ...f.provenance.sources[id] }, nid = id + 'y' + i;
            s.periodStart = shift(s.periodStart, i); s.periodEnd = shift(s.periodEnd, i); s.filingDate = shift(s.filingDate, i);
            f.provenance.sources[nid] = s; return nid;
        });
        return r;
    });
    return f;
}

test('an added column no Apple year fills is listed once as unavailable, not as blank cells', async () => {
    useAppleFixture();
    const r = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', limit: 2 });
    assert.ok(r.unavailableFields.includes('depreciationAndAmortization'));
    assert.ok(!r.table.split('\n')[0].includes('depreciationAndAmortization'));
    for (const o of r.observations) {
        assert.ok(!('depreciationAndAmortization' in o.fields));
        assert.equal(typeof o.fields.weightedAverageSharesDiluted.value, 'number');
    }
    // Asked for by name, a blank column is shown as blank rather than dropped.
    const asked = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', limit: 2, fields: ['totalRevenue', 'depreciationAndAmortization'] });
    assert.equal(asked.unavailableFields, undefined);
    assert.equal(asked.observations[0].fields.depreciationAndAmortization.value, null);
});

test('a full report keeps to the core columns, and long history keeps its periods by dropping the added ones', async () => {
    useAppleFixture();
    const report = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', limit: 2 }, { companyReportEvidence: true });
    assert.ok(!('weightedAverageSharesDiluted' in report.observations[0].fields));
    assert.ok('totalRevenue' in report.observations[0].fields);
    cache.loadFundamentals = symbol => symbol === 'AAPL' ? appleYears(12) : originalLoad(symbol);
    const five = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', limit: 5 });
    assert.equal(five.history.returnedPeriods, 5);
    assert.ok('weightedAverageSharesDiluted' in five.observations[0].fields);
    assert.equal(five.moreFields, undefined);
    const eight = await ask.runTool('get_financials', { symbol: 'AAPL', statement: 'income', limit: 8 });
    assert.equal(eight.history.returnedPeriods, 8);
    assert.ok(eight.moreFields.includes('weightedAverageSharesDiluted'));
    assert.ok(!('weightedAverageSharesDiluted' in eight.observations[0].fields));
});
