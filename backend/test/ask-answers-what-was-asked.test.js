'use strict';

// Ask answers what was asked, and keeps working until it has.
//
// 2026-10-11: asked for one stock with more than 35% growth in the last four
// quarters, low SBC and buybacks, Ask named a company growing 8%, wrote that it
// "cleared every bar", and that was released: every figure in it had a source,
// and nothing compared the answer with the question. A hard question was also
// cut off after ten rounds whatever it needed.
//
// These tests pin the harness from the reader's side: what was asked is written
// down first; a draft that misses a part is not released and the model is sent
// back; a signed-in reader's run has no fixed length and ends when the question
// is answered or their credits are spent.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.OLLAMA_API_KEY = 'test-only-key';
const aiChat = require('../ai-chat');
const requirements = require('../ask-requirements');

afterEach(() => aiChat.__resetDeps());

const QUESTION = 'pick one stock tha is growing very fast and has low sbc stock buybacks and greater thatn 35 % growth in the last 4 quarters';
const ASKS = { asks: [
    { text: 'greater than 35% growth in the last 4 quarters', kind: 'number', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))', op: '>', value: 35 },
    { text: 'low sbc', kind: 'number', formula: 'pct(ttm(sbc), ttm(revenue))' },
    { text: 'a moat that is defensible', kind: 'judgement' },
    { text: 'pick one stock', kind: 'deliverable' }
] };
const ends = ['2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31', '2024-12-31', '2024-09-30'];
const fact = (s, revenue) => ({ s, c: 'USD', q: { ends, f: { revenue, sbc: revenue.map(() => 1) } } });
const facts = (() => { const rows = [fact('FAST', [150, 140, 130, 120, 100, 100, 100, 100]), fact('SLOW', [108, 108, 108, 108, 100, 100, 100, 100])];
    return { v: 1, asOf: '2026-07-15', rows, bySymbol: new Map(rows.map(r => [r.s, r])) }; })();
const screenRows = [{ symbol: 'FAST', name: 'Fast Co', sector: 'Information Technology', marketCapB: 9 }, { symbol: 'SLOW', name: 'Slow Co', sector: 'Consumer Discretionary', marketCapB: 120 }];

const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
// main: the research loop's replies, in order. aux: the two short reads.
function scripted({ main, aux = [], overrides = {} }) {
    const calls = { main: [], aux: [], tools: [] };
    const chatRaw = async (messages, opts) => {
        calls.main.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
        const r = main[calls.main.length - 1];
        return { role: 'assistant', content: '', ...(r || { content: 'Fallback answer so the loop terminates.' }) };
    };
    const chatAux = async (messages) => {
        calls.aux.push(JSON.parse(JSON.stringify(messages)));
        const r = aux[calls.aux.length - 1];
        return { role: 'assistant', content: typeof r === 'string' ? r : JSON.stringify(r === undefined ? {} : r) };
    };
    const runTool = async (name, args) => { calls.tools.push({ name, args }); return { table: 'symbol|g\nFAST|35.0\nSLOW|8.0', matched: 2 }; };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o), chatAux, runTool, universe: () => ({ screenRows, facts }), ...overrides });
    return calls;
}
const ask = (opts = {}) => aiChat.ask({ question: QUESTION, history: [], ctx: {}, ...opts });
// An answer that states the pick's own figures (35.0% growth, share-based pay 0.7% of revenue).
const GOOD = 'Fast Co (FAST) is the pick: revenue over the last four quarters grew 35.0, share-based pay is 0.7 of revenue, and switching costs give it a moat.';
const passAll = picks => ({ picks, admitsNoFullMatch: false, results: [1, 2, 3, 4].map(id => ({ id, ok: true })) });

test('the 2026-10-11 answer is not released: the pick fails the reader\'s growth condition and the model is sent back', async () => {
    const calls = scripted({
        main: [
            { tool_calls: [toolCall('c1', 'query_universe', { where: 'pe < 40' })] },
            { content: 'The pick: Slow Co (SLOW). It cleared every bar at once.' },
            { tool_calls: [toolCall('c2', 'query_universe', { where: 'growth_pct(ttm(revenue), ttm(revenue, 4)) > 35' })] },
            { content: 'The pick: Fast Co (FAST). Its revenue over the last four quarters is 35.0 above the four before, share-based pay is 0.7 of revenue, and it has a network moat.' }
        ],
        aux: [ASKS, passAll(['SLOW']), passAll(['FAST'])]
    });
    const out = await ask();

    assert.equal(out.source, 'ai');
    assert.match(out.answer, /Fast Co \(FAST\)/);
    assert.doesNotMatch(out.answer, /SLOW|cleared every bar/);
    assert.equal(out.quality.sendBacks, 1);
    assert.deepEqual(out.quality.unfinished, []);
    // What was asked reached the model before any research…
    const first = calls.main[0].messages.map(m => m.content).join('\n');
    assert.match(first, /WHAT THE USER ASKED FOR/);
    assert.match(first, /greater than 35% growth in the last 4 quarters.*\(growth_pct\(ttm\(revenue\), ttm\(revenue, 4\)\)\) > 35/);
    // …and the rejected draft came back with the failing figure and the companies that do pass.
    const sentBack = calls.main[2].messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(sentBack, /ANSWER NOT RELEASED/);
    assert.match(sentBack, /SLOW does not meet "greater than 35% growth in the last 4 quarters": .* is 8, and the test is .* > 35/);
    assert.match(sentBack, /1 company passes every measured condition/);
    assert.match(sentBack, /^FAST\|/m);
});

test('the companies that pass are found by the harness before the model writes anything', async () => {
    const calls = scripted({ main: [{ content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    const out = await ask();
    assert.equal(out.source, 'ai');
    assert.deepEqual(calls.tools[0], { name: 'query_universe', args: {
        columns: [{ name: 'cond1', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))' }, { name: 'cond2', formula: 'pct(ttm(sbc), ttm(revenue))' }],
        where: '((growth_pct(ttm(revenue), ttm(revenue, 4))) > 35)', limit: 30 } });
    const first = calls.main[0].messages;
    assert.ok(first.some(m => m.role === 'tool' && m.tool_call_id === 'asked-screen'));
    assert.match(first.at(-1).content, /ALREADY been run over every company.*cond1 = "greater than 35% growth in the last 4 quarters".*put forward only companies from it/s);
    assert.equal(out.toolsUsed[0].tool, 'query_universe');
});

test('"pick from large cap, mid cap and small cap" is one pick from each, and an answer that skips a group is sent back', async () => {
    const grouped = { asks: [ASKS.asks[0], { text: 'one pick from each of large cap and small cap', kind: 'deliverable',
        groups: [{ name: 'large cap', where: 'market_cap_b >= 10' }, { name: 'small cap', where: 'market_cap_b < 10' }, { name: 'broken', where: 'process.exit()' }] }] };
    const big = fact('BIGG', [150, 140, 130, 120, 100, 100, 100, 100]);
    const rows = [...screenRows, { symbol: 'BIGG', name: 'Big Co', sector: 'Information Technology', marketCapB: 900 }];
    const all = { ...facts, rows: [...facts.rows, big], bySymbol: new Map([...facts.bySymbol, ['BIGG', big]]) };
    const both = 'Large cap: Big Co (BIGG), growth 35.0. Small cap: Fast Co (FAST), growth 35.0.';
    const calls = scripted({
        main: [{ content: 'Fast Co (FAST) is the pick, growth 35.0.' }, { content: both }],
        aux: [grouped, { picks: ['FAST'], results: [] }, { picks: ['BIGG', 'FAST'], results: [] }],
        overrides: { universe: () => ({ screenRows: rows, facts: all }) }
    });
    const out = await ask();
    assert.equal(out.answer, both);
    assert.equal(out.quality.sendBacks, 1);
    // One screen per group, each with the group's own bound added to the reader's condition.
    assert.deepEqual(calls.tools.map(t => t.args.where), ['((growth_pct(ttm(revenue), ttm(revenue, 4))) > 35) and (market_cap_b >= 10)', '((growth_pct(ttm(revenue), ttm(revenue, 4))) > 35) and (market_cap_b < 10)']);
    assert.match(calls.main[0].messages.map(m => m.content).join('\n'), /ONE PICK FROM EACH GROUP.*puts forward 2 companies, one from each group's table/s);
    const sentBack = calls.main[1].messages.at(-1).content;
    assert.match(sentBack, /No pick from large cap \(market_cap_b >= 10\)\. The user asked for one pick from each of large cap, small cap\./);
    assert.match(sentBack, /^BIGG\|/m);
    assert.doesNotMatch(sentBack, /No pick from small cap/);
});

test('a figure quoted for the pick must be the pick\'s own, not a neighbouring row\'s', async () => {
    const calls = scripted({
        main: [
            { tool_calls: [toolCall('c1', 'query_universe', {})] },
            { content: 'Fast Co (FAST) is the pick: revenue over the last four quarters grew 83.4, with a moat.' },
            { content: 'Fast Co (FAST) is the pick: revenue over the last four quarters grew 35.0 and share-based pay is 0.7 of revenue, with a moat.' }
        ],
        aux: [ASKS, passAll(['FAST']), passAll(['FAST'])]
    });
    const out = await ask();
    assert.equal(out.quality.sendBacks, 1);
    assert.match(calls.main[2].messages.at(-1).content, /Give FAST's own figure for "greater than 35% growth in the last 4 quarters": .* is 35\.0 for FAST/);
    assert.match(out.answer, /grew 35\.0/);
    // A money amount is written scaled ("$55.3bn"), so it is not matched digit for digit.
    const money = { asks: [{ text: 'stock buybacks', kind: 'number', formula: 'ttm(revenue) * 1000000000', op: '>', value: 0 }] };
    scripted({ main: [{ content: 'Fast Co (FAST) is the pick: it bought back $540bn of stock.' }], aux: [money, { picks: ['FAST'], results: [] }] });
    assert.equal((await ask()).quality.sendBacks, 0);
});

test('a part that is not a number is read too: an ignored part sends the answer back', async () => {
    const calls = scripted({
        main: [
            { tool_calls: [toolCall('c1', 'query_universe', {})] },
            { content: 'Fast Co (FAST) is the pick: revenue grew 35.0 and share-based pay is 0.7 of revenue.' },
            { content: GOOD }
        ],
        aux: [ASKS, { picks: ['FAST'], results: [{ id: 3, ok: false, why: 'no moat assessment given' }, { id: 4, ok: true }] }, passAll(['FAST'])]
    });
    const out = await ask();
    assert.match(out.answer, /switching costs/);
    assert.match(calls.main[2].messages.at(-1).content, /Not done: "a moat that is defensible" — no moat assessment given/);
});

test('when no company passes and the answer says so, that is the answer', async () => {
    const none = { asks: [{ text: 'more than 500% growth in the last 4 quarters', kind: 'number', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))', op: '>', value: 500 }] };
    scripted({
        main: [{ tool_calls: [toolCall('c1', 'query_universe', {})] }, { content: 'No company meets that bar. The closest is Fast Co (FAST), at 35.0.' }],
        aux: [none, { picks: ['FAST'], admitsNoFullMatch: true, results: [{ id: 1, ok: true }] }]
    });
    const out = await ask({ question: 'which stock has more than 500% growth in the last 4 quarters' });
    assert.equal(out.quality.sendBacks, 0);
    assert.match(out.answer, /No company meets that bar/);
});

test('a short plain question is not listed or re-read, and a failed listing never blocks an answer', async () => {
    let calls = scripted({ main: [{ content: 'Paris.' }], aux: [] });
    assert.equal((await ask({ question: 'capital of France?' })).answer, 'Paris.');
    assert.equal(calls.aux.length, 0);
    calls = scripted({ main: [{ tool_calls: [toolCall('c1', 'query_universe', {})] }, { content: GOOD }], aux: ['not json at all'] });
    const out = await ask();
    assert.equal(out.source, 'ai');
    assert.equal(calls.aux.length, 1, 'no list, so no second read');
});

const budgetOf = (credits, extra = {}) => ({ credits, creditsFor: tokens => 2 + Math.max(0, Math.ceil((tokens - 100) / 100)), ...extra });
const usage = n => ({ _usage: { total_tokens: n } });

test('a signed-in reader\'s question is not cut off after ten rounds', async () => {
    const rounds = Array.from({ length: 14 }, (_, i) => ({ tool_calls: [toolCall('c' + i, 'query_universe', { limit: i + 1 })], ...usage(1) }));
    const calls = scripted({ main: [...rounds, { content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    const out = await ask({ ctx: { budget: budgetOf(1e6) } });
    assert.equal(out.source, 'ai');
    assert.equal(out.toolsUsed.length, 15, 'the harness\'s screen and fourteen rounds of the model\'s own');
    assert.ok(calls.main.every(c => !c.messages.some(m => /TOOL BUDGET SPENT/.test(m.content || ''))));
});

test('the run ends when the credits are spent: the best answer is given and the open part is named', async () => {
    const charged = [];
    const calls = scripted({
        main: [
            { tool_calls: [toolCall('c1', 'query_universe', { limit: 1 })], ...usage(40000) },
            { tool_calls: [toolCall('c2', 'query_universe', { limit: 2 })], ...usage(40000) },
            { content: 'Slow Co (SLOW) is the closest found so far.', ...usage(50) }
        ],
        aux: [ASKS, passAll(['SLOW'])]
    });
    // 2 credits cover the first 50,000 tokens; each further 30,000 is one more.
    const creditsFor = tokens => 2 + Math.max(0, Math.ceil((tokens - 50000) / 30000));
    const out = await ask({ ctx: { budget: { credits: 5, creditsFor, charge: async n => { charged.push(n); } } } });
    const last = calls.main.at(-1);
    // The same tool list as every other round, so the provider's prefix cache
    // still covers the conversation on this, the longest prompt of the run.
    assert.deepEqual(last.opts.tools.map(t => t.function.name), calls.main[0].opts.tools.map(t => t.function.name));
    assert.match(last.messages.at(-1).content, /THE CREDITS FOR THIS QUESTION ARE SPENT/);
    assert.equal(calls.main.length, 3, 'no further rounds once the credits cannot cover one');
    assert.match(out.answer, /\*\*Not finished\.\*\* The credits for this question ran out before every part was done:/);
    assert.match(out.answer, /SLOW does not meet "greater than 35% growth in the last 4 quarters"/);
    assert.deepEqual(charged, [...charged].sort((a, b) => a - b), 'charged in rising steps as the work is done');
    assert.equal(charged.at(-1), 4, '80,050 tokens: 2 for the first 50,000 and one for each started 30,000 after');
});

test('a lookup asked for once the credits are spent is not run, and the answer is still written', async () => {
    const calls = scripted({
        main: [
            { tool_calls: [toolCall('c1', 'query_universe', { limit: 1 })], ...usage(40000) },
            { tool_calls: [toolCall('c2', 'query_universe', { limit: 2 })], ...usage(40000) },
            { tool_calls: [toolCall('c3', 'query_universe', { limit: 3 })], ...usage(50) },
            { content: 'Slow Co (SLOW) is the closest found so far.', ...usage(50) }
        ],
        aux: [ASKS, passAll(['SLOW'])]
    });
    const creditsFor = tokens => 2 + Math.max(0, Math.ceil((tokens - 50000) / 30000));
    const out = await ask({ ctx: { budget: { credits: 5, creditsFor, charge: async () => {} } } });
    assert.ok(!calls.tools.some(t => t.args.limit === 3), 'the closed round\'s lookup never ran');
    const writeUp = calls.main.at(-1).messages;
    const reply = writeUp.find(m => m.role === 'tool' && m.tool_call_id === 'c3');
    assert.match(reply.content, /Not run: the research is closed/, 'every call still gets a reply, or the provider rejects the request');
    assert.equal(calls.main.length, 4, 'one forced write-up, no further research round');
    assert.match(out.answer, /Slow Co \(SLOW\) is the closest found so far/);
});

test('the same lookup is never run or paid for twice, and a run that only repeats itself is ended', async () => {
    const same = () => ({ tool_calls: [toolCall('c' + Math.random(), 'query_universe', { where: 'pe < 10' })], ...usage(1) });
    const calls = scripted({ main: [same(), same(), same(), same(), { content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    const out = await ask({ ctx: { budget: budgetOf(1e6) } });
    assert.equal(calls.tools.length, 2, 'the harness\'s own screen, then the lookup once');
    const replies = calls.main.at(-1).messages.filter(m => m.role === 'tool');
    assert.equal(replies.filter(m => /You already ran this exact lookup/.test(m.content)).length, 3);
    assert.match(calls.main.at(-1).messages.at(-1).content, /ONLY REPEATED LOOKUPS/);
    assert.equal(out.source, 'ai');
});

test('a credit-metered run is not held to three filing searches, and each company gets its own filing read', async () => {
    const many = [...Array.from({ length: 6 }, (_, i) => toolCall('s' + i, 'search_filings', { query: 'export controls', ticker: 'T' + i })),
        toolCall('k1', 'get_key_points', { symbol: 'AAA' }), toolCall('k2', 'get_key_points', { symbol: 'BBB' }), toolCall('k3', 'get_key_points', { symbol: 'AAA', again: true })];
    const refused = calls => calls.main.at(-1).messages.filter(m => m.role === 'tool' && /allowance for \w+ is used up/.test(m.content)).length;
    let calls = scripted({ main: [{ tool_calls: many, ...usage(1) }, { content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    await ask({ ctx: { budget: budgetOf(1e6) } });
    assert.equal(refused(calls), 1, 'only the second read of the same company');
    calls = scripted({ main: [{ tool_calls: many }, { content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    await ask();
    assert.equal(refused(calls), 5, 'without a credit budget: three searches, one filing read');
});

test('another question spending the same credits is seen between rounds; pressing stop ends the run', async () => {
    let left = 1000;
    const round = i => ({ tool_calls: [toolCall('c' + i, 'query_universe', { limit: i + 1 })], ...usage(100) });
    let calls = scripted({ main: [round(0), round(1), round(2), { content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    await ask({ ctx: { budget: budgetOf(1000, { refresh: async () => { left = calls.main.length >= 1 ? 3 : left; return left; } }) } });
    assert.match(calls.main.at(-1).messages.map(m => m.content).join('\n'), /THE CREDITS FOR THIS QUESTION ARE SPENT/);
    assert.ok(calls.main.length < 4);

    calls = scripted({ main: [round(0), round(1), { content: 'never reached' }], aux: [ASKS] });
    const out = await ask({ ctx: { budget: budgetOf(1e6, { stopped: () => calls.main.length >= 1 }) } });
    assert.equal(out.source, 'stopped');
    assert.equal(calls.main.length, 1);
});

test('a researched answer the wording guard withholds is written again, not replaced by a receipt', async () => {
    const calls = scripted({
        main: [
            { tool_calls: [toolCall('c1', 'query_universe', {})] },
            { content: 'Fast Co (FAST) is the pick: its ad engine is powered by the Axon model.' },
            { content: GOOD }
        ],
        aux: [ASKS, passAll(['FAST'])]
    });
    const out = await ask();
    assert.equal(out.source, 'ai');
    assert.equal(out.answer.includes('powered by'), false);
    assert.match(calls.main[2].messages.at(-1).content, /withheld because of its wording/);
    // With nothing researched, a self-description is still simply blocked.
    scripted({ main: [{ content: 'I am a large language model powered by a GLM model.' }], aux: [] });
    assert.equal((await ask({ question: 'what are you?' })).source, 'blocked');
});

test('a bar written into the formula is the condition itself, and a test that is blank for every company is dropped', async () => {
    // 2026-10-11, live: "revenue above 1 billion" came back as the formula
    // "ttm(revenue) > 1000000000" with the bar repeated beside it. Nothing could
    // pass, and a correct top-five was replaced by "no company passes".
    const asks = requirements.clean({ asks: [
        { text: 'revenue above 100', kind: 'number', formula: 'ttm(revenue) > 100', op: '>', value: 100 },
        { text: 'gross margin above 40%', kind: 'number', formula: 'pct(ttm(gross_profit), ttm(revenue))', op: '>', value: 40 }
    ] });
    assert.equal(asks[0].cond, 'ttm(revenue) > 100');
    assert.equal(asks[0].formula, undefined);
    assert.equal(asks[1].cond, '(pct(ttm(gross_profit), ttm(revenue))) > 40');
    requirements.prune(asks, { screenRows, facts });
    assert.equal(asks[0].cond, 'ttm(revenue) > 100', 'a condition companies can be tested on is kept');
    assert.equal(asks[1].cond, undefined, 'no company here files gross profit: the test is dropped, not failed');
    assert.equal(asks[1].formula, undefined);
    const calls = scripted({ main: [{ content: 'Fast Co (FAST) and Slow Co (SLOW) both have revenue above 100.' }], aux: [{ asks: [{ text: 'revenue above 100', kind: 'number', formula: 'ttm(revenue) > 100', op: '>', value: 100 }] }, { picks: ['FAST', 'SLOW'], results: [] }] });
    const out = await ask({ question: 'which companies have revenue above 100 over the last four quarters' });
    assert.equal(out.quality.sendBacks, 0);
    assert.equal(calls.tools[0].args.where, '(ttm(revenue) > 100)');
});

test('a table cut off at its limit is called a sample, so a narrower question is not answered from it', () => {
    const asks = requirements.clean(ASKS);
    assert.match(requirements.screenNote(asks, [{ matched: 12, returned: 12 }]), /put forward only companies from it/);
    const cut = requirements.screenNote(asks, [{ matched: 400, returned: 30 }]);
    assert.match(cut, /show only the largest by market value.*others pass too.*run query_universe yourself with the same conditions plus that filter/s);
    assert.doesNotMatch(cut, /put forward only companies from it/);
});

test('the list keeps only what can be used: a formula that does not parse leaves the part to the reading pass', () => {
    const asks = requirements.clean({ asks: [
        { text: 'x', kind: 'number', formula: 'process.exit()', op: '>', value: 1 },
        { text: 'y', kind: 'number', formula: 'pct(ttm(sbc), ttm(revenue))', op: 'approximately', value: 5 },
        { text: '', kind: 'number' }, { text: 'z', kind: 'nonsense' }
    ] });
    assert.deepEqual(asks.map(a => [a.id, a.kind, a.formula || null, a.cond || null]), [[1, 'number', null, null], [2, 'number', 'pct(ttm(sbc), ttm(revenue))', null], [3, 'deliverable', null, null]]);
    assert.equal(requirements.clean({ asks: [] }), null);
    assert.equal(requirements.applies('nvda revenue?', { kind: 'focused' }), false);
    assert.equal(requirements.applies(QUESTION, { kind: 'company_report' }), false);
    assert.equal(requirements.applies(QUESTION, { kind: 'focused' }), true);
});

test('a credit-metered draft with a figure no tool supplied is sent back once to research it', async () => {
    const calls = scripted({ main: [
        { content: '', tool_calls: [toolCall('q1', 'get_quote', { symbol: 'LLY' })] },
        { content: 'LLY trades at 17x sales on revenue of $65.2bn.' },
        { content: 'LLY revenue is in the filing.' }
    ] });
    await aiChat.ask({ question: 'What is the P/S ratio of LLY?', history: [], ctx: { budget: budgetOf(1e6) } });
    const sentBack = calls.main[2].messages.map(m => m.content).join('\n');
    assert.match(sentBack, /ANSWER NOT RELEASED: these figures in your draft are in no tool result.*\$65\.2bn/);
    assert.equal(calls.main.length, 3, 'sent once: the second draft is not sent back again');
});

test('the trace shows the plan line, never a draft of the answer written ahead of the tool calls', async () => {
    // 2026-10-25: "**In one line** — Microsoft is a highly profitable… Pulling MSFT's business profi" sat in the trace.
    assert.equal(aiChat.planNote('**In one line** — Microsoft is a highly profitable software giant. It trades at a premium. Pulling MSFT\'s business profile and statements.'), 'Pulling MSFT\'s business profile and statements.');
    assert.equal(aiChat.planNote('> **In one line** — Microsoft is profitable.\n\n| Metric | Value |\n|---|---|\n\nPulling 5 years of statements for MSFT.'), 'Pulling 5 years of statements for MSFT.');
    assert.equal(aiChat.planNote('**W jednej linii** — Microsoft jest bardzo rentowny.\n\nPobieram dane finansowe MSFT.'), 'Pobieram dane finansowe MSFT.');
    assert.equal(aiChat.planNote('Pulling 5 years of statements for AAPL and MSFT to compare growth and margins.'), 'Pulling 5 years of statements for AAPL and MSFT to compare growth and margins.');
    assert.equal(aiChat.planNote('## Microsoft\n\n**In one line** — Microsoft is a highly profitable giant.'), '');
    assert.equal(aiChat.planNote(''), '');

    const notes = [];
    scripted({
        main: [
            { content: '**In one line** — Fast Co is the pick, a fast grower. Pulling the screen for FAST.', tool_calls: [toolCall('c1', 'query_universe', {})] },
            { content: GOOD }
        ],
        aux: [ASKS, passAll(['FAST'])]
    });
    await ask({ onEvent: e => { if (e.type === 'note') notes.push(e.text); } });
    assert.deepEqual(notes, ['Pulling the screen for FAST.']);
});

test('the reader\'s follow-up hint reaches the model', async () => {
    const calls = scripted({ main: [{ content: GOOD }], aux: [ASKS, passAll(['FAST'])] });
    await ask({ ctx: { nextHint: 'FOLLOW-UP FOR THIS USER: they mostly research free cash flow.' } });
    assert.ok(calls.main[0].messages.some((m) => m.role === 'system' && m.content === 'FOLLOW-UP FOR THIS USER: they mostly research free cash flow.'));
});
