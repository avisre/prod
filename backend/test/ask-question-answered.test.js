'use strict';

// Ask answers the question that was asked.
//
// 2026-10-10: "make a swing trade for frgth" came back as a full company
// report on a different company. Once a tool call had named a company, any
// question typed without punctuation and without one of a fixed list of
// keywords was re-selected as an open-ended company report. No test asked an
// ordinary question without a question mark, so it shipped green on 10-05.
// These tests pin the behaviour from the reader's side: which questions get a
// report, which get their own answer, and what a trade and an economic figure
// must carry.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.OLLAMA_API_KEY = 'test-only-key';
process.env.SEC_COVERAGE_READ_ONLY = '1'; process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
process.env.FRED_API_KEY = 'test-fred-key'; process.env.BLS_API_KEY = '';
const policy = require('../ask-report-policy'), quality = require('../ask-answer-quality'), evidence = require('../ask-evidence');
const trade = require('../ask-trade-model'), macro = require('../ask-macro-data'), aiChat = require('../ai-chat');

afterEach(() => { aiChat.__resetDeps(); trade.__resetDeps(); macro.__resetDeps(); });

const AMD = { symbol: 'AMD', name: 'Advanced Micro Devices', securityType: 'stock' };
const ASKED = ['make a swing trade for amd', 'should i buy amd or wait', 'who is the ceo of amd', 'why did amd fall today', 'is amd a good investment',
    'what are the risks for amd', 'what is the unemployment rate', 'what did the fed do at its last meeting', 'write me a haiku about rain',
    'how would a long term position in amd look with downside protection', 'model a short term trade on amd', 'frgth'];

test('a particular question never becomes the company report, with or without a question mark, once a company is known', () => {
    for (const mode of ['normal', 'analyst']) for (const base of ASKED) for (const question of [base, base + '?']) {
        assert.notEqual(policy.select(question, mode).kind, 'company_report', question);
        assert.notEqual(policy.select(question, mode, { company: AMD }).kind, 'company_report', question + ' (after a tool named AMD)');
        assert.equal(aiChat.frameworkApplies(question), false, question);
    }
});

test('a bare name or an explicit report request still gets the full report', () => {
    for (const question of ['amd', 'AMD', 'tell me about amd', 'how is amd doing', 'What do you think about AMD?', 'frgt'])
        assert.equal(policy.select(question).kind, 'company_report', question);
    for (const question of ['Explain AMD business', 'give me a deep dive on amd', 'full analysis of amd'])
        assert.equal(policy.select(question, 'analyst', { company: AMD }).kind, 'company_report', question);
});

test('trade requests select the trade answer and never require a chart', () => {
    for (const question of ['make a swing trade for amd', 'swing trade for amd on robinhood', 'model a short term trade on amd', 'give me a long term trade in nvda',
        'where should my stop loss be on amd', 'how would a long term position in amd look with downside protection', 'position sizing for tsla']) {
        const selected = policy.select(question, 'normal', { company: AMD });
        assert.equal(selected.kind, 'trade', question); assert.equal(selected.visualRequired, false, question);
        assert.match(policy.prompt(selected), /TRADE REQUEST/); assert.match(policy.prompt(selected), /BROKER/);
    }
    for (const question of ['AMD revenue last quarter', 'compare amd and nvda', 'amd']) assert.notEqual(policy.select(question).kind, 'trade', question);
});

test('a ticker nobody lists is named with its nearest listing, never swapped for another company', () => {
    for (const question of ['make a swing trade for frgth', 'frgth', 'what is $frgth']) {
        const selected = policy.select(question);
        assert.equal(selected.unknownTicker?.typed, 'FRGTH', question);
        assert.deepEqual(selected.unknownTicker.nearest.map(c => c.symbol), ['FRGT'], question);
        assert.match(policy.prompt(selected), /"FRGTH", which is not a listed symbol/); assert.match(policy.prompt(selected), /Never answer about a different company/);
    }
    for (const question of ['make a swing trade for amd', 'long term trade on banks', 'trade for tesla']) assert.equal(policy.select(question).unknownTicker, null, question);
});

// A scripted provider, as in ask-tool-loop.test.js.
function scripted(responses, runTool) {
    const calls = [];
    const chatRaw = async (messages, opts) => {
        calls.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
        return { role: 'assistant', content: '', ...(responses[calls.length - 1] || { content: 'Fallback answer so the loop terminates.' }) };
    };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o), runTool });
    return calls;
}
const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const systemText = calls => calls.flatMap(c => c.messages).filter(m => m.role === 'system').map(m => m.content).join('\n');

test('a focused question whose first lookup names a company is answered, not replaced by eleven report pulls', async () => {
    const pulled = [];
    const calls = scripted([
        { tool_calls: [toolCall('a', 'get_key_points', { symbol: 'AMD' })] },
        { content: 'Lisa Su is the chair and chief executive of Advanced Micro Devices.' }
    ], async (name, args) => { pulled.push(name); return { symbol: 'AMD', name: 'Advanced Micro Devices', sections: [{ title: 'Management', text: 'Lisa Su, Chair and Chief Executive Officer.' }] }; });
    const out = await aiChat.ask({ question: 'who is the ceo of amd', history: [], ctx: {}, mode: 'normal' });
    assert.match(out.answer, /Lisa Su/);
    assert.deepEqual(pulled, ['get_key_points']);
    assert.equal(out.quality.terminalReason, 'answered');
    assert.equal(out.quality.policy.kind, 'focused');
    assert.doesNotMatch(systemText(calls), /REPORT FORMAT|ANSWER FRAMEWORK|ANSWER SHAPE — full company report/);
});

// 60 trading days of prices that drift upward with a steady daily range.
function bars(start = 100, days = 60) {
    return Array.from({ length: days }, (_, i) => {
        const close = start + i * 0.5, date = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10);
        return { date, high: close + 2, low: close - 2, close };
    });
}
const chain = (strikes, expiry = '2026-10-16') => ({ expirationDates: [new Date(expiry + 'T00:00:00Z')],
    options: [{ expirationDate: new Date(expiry + 'T00:00:00Z'), puts: strikes.map(strike => ({ strike, bid: 1.9, ask: 2.1, openInterest: 500, impliedVolatility: 0.4 })),
        calls: strikes.map(strike => ({ strike, bid: 1.4, ask: 1.6, openInterest: 400, impliedVolatility: 0.38 })) }] });

test('model_trade: protection is on unless declined, levels are ordered, and size never risks more than the budget', async () => {
    trade.__setDeps({ fetchBars: async () => ({ currency: 'USD', bars: bars() }), fetchOptions: async () => chain([110, 115, 120, 125, 130]) });
    for (const horizon of ['short_term', 'swing', 'long_term']) {
        const t = await trade.modelTrade({ symbol: 'AMD', horizon, account_size: 20000, risk_pct: 1 });
        assert.equal(t.error, undefined, horizon); assert.equal(t.horizon, horizon);
        assert.ok(t.protection.stop.price < t.entry.reference, horizon);
        assert.ok(t.targets[0].price > t.entry.reference && t.targets[1].price > t.targets[0].price, horizon);
        assert.equal(t.protection.option.available, true); assert.equal(t.protection.option.type, 'protective put');
        assert.ok(t.protection.option.strike <= t.entry.reference);
        assert.ok(t.positionSize.lossAtStop <= t.positionSize.riskBudget + 1e-9, horizon);
        assert.ok(t.positionSize.positionValue <= 20000);
        assert.match(t.disclaimer, /AI-generated/); assert.match(t.disclaimer, /Do your own research/i);
    }
    const tighter = await trade.modelTrade({ symbol: 'AMD', horizon: 'short_term' }), wider = await trade.modelTrade({ symbol: 'AMD', horizon: 'long_term' });
    assert.ok(tighter.riskPerShare < wider.riskPerShare);
    const declined = await trade.modelTrade({ symbol: 'AMD', downside_protection: false });
    assert.equal(declined.protection, null); assert.match(declined.protectionNote, /declined/);
    const short = await trade.modelTrade({ symbol: 'AMD', direction: 'short' });
    assert.ok(short.protection.stop.price > short.entry.reference); assert.ok(short.targets[0].price < short.entry.reference);
    assert.equal(short.protection.option.type, 'protective call');
});

test('model_trade: no listed options means a stop only; an unknown symbol is refused with its nearest listing', async () => {
    trade.__setDeps({ fetchBars: async () => ({ currency: 'USD', bars: bars(0.9, 60).map(b => ({ ...b, high: b.close * 1.2, low: b.close * 0.8 })) }), fetchOptions: async () => ({ expirationDates: [], options: [] }) });
    const thin = await trade.modelTrade({ symbol: 'FRGT' });
    assert.equal(thin.protection.option.available, false); assert.match(thin.protection.option.reason, /No listed options/);
    assert.ok(thin.protection.stop.price > 0); assert.ok(thin.warnings.some(w => /volatile/i.test(w)));
    trade.__setDeps({ fetchBars: async () => { throw new Error('not found'); } });
    const unknown = await trade.modelTrade({ symbol: 'FRGTH' });
    assert.match(unknown.error, /not a listed symbol/); assert.equal(unknown.unknownSymbol, true);
    assert.deepEqual(unknown.didYouMean.map(c => c.symbol), ['FRGT']);
});

test('a trade answer keeps the tool\'s levels through the numerical review and always ends with the disclaimer', async () => {
    trade.__setDeps({ fetchBars: async () => ({ currency: 'USD', bars: bars() }), fetchOptions: async () => chain([110, 115, 120, 125, 130]) });
    const t = await trade.modelTrade({ symbol: 'AMD', horizon: 'swing', account_size: 20000 });
    const text = `Swing trade on AMD, prices as of ${t.asOf}.\n\n| Level | Price |\n|---|---|\n| Entry | $${t.entry.reference} |\n| Stop | $${t.protection.stop.price} |\n| Target | $${t.targets[0].price} |\n\n` +
        `The stop sits ${t.protection.stop.distancePct}% below entry. Buy ${t.positionSize.shares} shares for $${t.positionSize.positionValue}, risking $${t.positionSize.lossAtStop}. ` +
        `A put at the $${t.protection.option.strike} strike costs $${t.protection.option.premiumMid} a share.`;
    assert.deepEqual(quality.audit(text, [{ tool: 'model_trade', result: t }], { question: 'make a swing trade for amd', mode: 'normal' }), []);
    assert.match(quality.audit(text + ' It should reach $999.99.', [{ tool: 'model_trade', result: t }], { question: 'make a swing trade for amd', mode: 'normal' }).join(' '), /\$999\.99 is not a figure any tool result supplies/);
    const calls = scripted([{ tool_calls: [toolCall('a', 'model_trade', { symbol: 'AMD', horizon: 'swing', account_size: 20000 })] }, { content: text }],
        (name, args, ctx) => trade.modelTrade(args, ctx));
    const out = await aiChat.ask({ question: 'make a swing trade for amd', history: [], ctx: {}, mode: 'normal' });
    assert.equal(out.quality.policy.kind, 'trade'); assert.equal(out.quality.fallback, false);
    assert.match(out.answer, new RegExp('\\$' + String(t.protection.stop.price).replace('.', '\\.')));
    assert.match(out.answer.trim().split('\n').pop(), /AI-generated trade model, not financial advice.*Do your own research/);
    assert.match(systemText(calls), /TRADE REQUEST/); assert.doesNotMatch(systemText(calls), /REPORT FORMAT/);
});

test('an answer about the nearest listing says first that the typed symbol does not exist', async () => {
    trade.__setDeps({ fetchBars: async () => ({ currency: 'USD', bars: bars() }), fetchOptions: async () => ({ expirationDates: [], options: [] }) });
    scripted([{ tool_calls: [toolCall('a', 'model_trade', { symbol: 'FRGT' })] }, { content: 'Swing trade on FRGT: a stop order is the only protection because no options are listed.' }],
        (name, args, ctx) => trade.modelTrade(args, ctx));
    const out = await aiChat.ask({ question: 'make a swing trade for frgth', history: [], ctx: {}, mode: 'normal' });
    assert.match(out.answer, /^"FRGTH" is not a listed symbol, so this answer is for the nearest listing, FRGT \(Freight Technologies/);
    // Never claimed when the answer is about some other company.
    scripted([{ tool_calls: [toolCall('a', 'model_trade', { symbol: 'AMD' })] }, { content: 'Swing trade on AMD with a stop order.' }], (name, args, ctx) => trade.modelTrade(args, ctx));
    const other = await aiChat.ask({ question: 'make a swing trade for frgth', history: [], ctx: {}, mode: 'normal' });
    assert.doesNotMatch(other.answer, /nearest listing/);
});

const fredRows = [['2025-08-01', 4.3], ['2025-09-01', 4.4], ['2026-07-01', 4.3], ['2026-08-01', 4.1], ['2026-09-01', 4.2]];
function upstream({ api = true, csv = true } = {}) {
    const seen = [];
    const http = async url => {
        seen.push(url);
        if (/api\.stlouisfed\.org/.test(url)) { if (!api) throw new Error('HTTP 429'); return { json: async () => ({ observations: fredRows.map(([date, value]) => ({ date, value: String(value) })) }) }; }
        if (/fredgraph\.csv/.test(url)) { if (!csv) throw new Error('HTTP 503'); return { text: async () => 'observation_date,UNRATE\n' + fredRows.map(r => r.join(',')).join('\n') }; }
        throw new Error('unexpected ' + url);
    };
    return { seen, http };
}

test('get_economic_data: dated official figures, one upstream request however many people ask, and a fallback when the key is refused', async () => {
    let clock = Date.UTC(2026, 9, 10);
    const first = upstream();
    macro.__setDeps({ http: first.http, now: () => clock });
    const a = await macro.getEconomicData({ indicators: ['unemployment_rate'] });
    const u = a.series[0];
    assert.equal(u.latest.period, 'September 2026'); assert.equal(u.latest.value, 4.2); assert.equal(u.publishedBy, 'Bureau of Labor Statistics');
    assert.equal(u.previous.changePoints, 0.1); assert.equal(u.yearAgo.period, 'September 2025'); assert.equal(u.yearAgo.changePoints, -0.2);
    assert.match(u.sourceUrl, /fred\.stlouisfed\.org\/series\/UNRATE/); assert.ok(a.claimable.percentages.includes(4.2));
    for (let i = 0; i < 50; i++) await macro.getEconomicData({ indicators: ['unemployment_rate'] });
    assert.equal(first.seen.length, 1, 'fifty-one questions, one request');

    macro.__resetDeps();
    const refused = upstream({ api: false });
    macro.__setDeps({ http: refused.http, now: () => clock });
    const b = await macro.getEconomicData({ indicators: ['unemployment_rate'] });
    assert.equal(b.series[0].latest.value, 4.2); assert.equal(refused.seen.length, 2); assert.match(refused.seen[1], /fredgraph\.csv/);

    // Past the refresh window with every source down: the kept value, dated, with a warning.
    clock += macro.TTL_MS + 1000;
    const down = upstream({ api: false, csv: false });
    macro.__setDeps({ http: down.http, now: () => clock });
    const c = await macro.getEconomicData({ indicators: ['unemployment_rate'] });
    assert.equal(c.series[0].latest.period, 'September 2026'); assert.match(c.series[0].stalenessWarning, /could not be reached/);

    macro.__resetDeps();
    macro.__setDeps({ http: upstream({ api: false, csv: false }).http, now: () => clock });
    const d = await macro.getEconomicData({ indicators: ['unemployment_rate', 'not_a_series'] });
    assert.match(d.error, /never state one from memory/);
});

test('an economic answer passes the review on the tool\'s figures and carries the FRED notice', async () => {
    macro.__setDeps({ http: upstream().http, now: () => Date.UTC(2026, 9, 10) });
    const calls = scripted([{ tool_calls: [toolCall('a', 'get_economic_data', { indicators: ['unemployment_rate'] })] },
        { content: 'The unemployment rate was 4.2% in September 2026, up from 4.1% in August, according to the Bureau of Labor Statistics.' }],
    (name, args) => macro.getEconomicData(args));
    const out = await aiChat.ask({ question: 'what is the unemployment rate', history: [], ctx: {}, mode: 'normal' });
    assert.match(out.answer, /4\.2% in September 2026/); assert.equal(out.quality.fallback, false);
    assert.match(out.answer, /uses the FRED® API but is not endorsed/);
    assert.equal(calls.length, 2);
});

test('the prompt answers any lawful question, models trades, and offers both new tools', () => {
    assert.doesNotMatch(aiChat.ASK_SYSTEM, /you ONLY answer|NO ADVICE|decline in one sentence and steer back/);
    assert.match(aiChat.ASK_SYSTEM, /any other lawful subject/); assert.match(aiChat.ASK_SYSTEM, /model_trade/); assert.match(aiChat.ASK_SYSTEM, /get_economic_data/);
    assert.match(aiChat.ASK_SYSTEM, /TRADE SECRET/);
    const names = aiChat.TOOLS.map(t => t.function.name);
    assert.ok(names.includes('model_trade') && names.includes('get_economic_data'));
});

test('a general-knowledge answer is not withheld as an unsourced financial claim; a financial one still is', () => {
    assert.equal(evidence.requiresEvidence('who won the 1966 world cup', 'England won in 1966, beating West Germany 4-2 after extra time in the final quarter of an hour.'), false);
    assert.equal(evidence.requiresEvidence('write me a haiku about rain', 'Rain on the tin roof / 17 syllables falling / margin of the night'), false);
    assert.equal(evidence.requiresEvidence('what was amd revenue last quarter', 'Revenue was $7.4bn.'), true);
    assert.equal(evidence.requiresEvidence('how is amd', 'Its market cap is $990bn.'), true);
});
