'use strict';

// Contracts the Ask agentic loop must honour regardless of which model is
// behind it. Before the glm-5.3 swap none of this was covered: no test in the
// suite exercised tool_calls at all, so a model that changed its tool-calling
// or reasoning behaviour would have shipped green.
//
// Deliberately model-agnostic — nothing here pins a model id, because that is
// the test that breaks on every future swap while catching nothing. The
// provider is injected via aiChat.__setDeps, the same seam the AI Paper
// portfolio tests already use.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.OLLAMA_API_KEY = 'test-only-key'; // gets past ask()'s configured check
const aiChat = require('../ai-chat');

afterEach(() => aiChat.__resetDeps());

// A scripted provider: hands back `responses` in order, snapshotting the
// message list it was given on each call so we can assert on what the loop
// would have sent to a real provider.
function scripted(responses) {
    const calls = [];
    const chatRaw = async (messages, opts) => {
        calls.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
        const r = responses[calls.length - 1];
        if (!r) return { role: 'assistant', content: 'Fallback answer so the loop terminates.' };
        return { role: 'assistant', content: '', ...r };
    };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o) });
    return calls;
}
const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const ask = (opts = {}) => aiChat.ask({ question: 'Compare these companies.', history: [], ctx: {}, ...opts });

test('every tool_call gets a reply, including ones past the round budget', async () => {
    // The loop runs at most 12 tools per round. The rest used to be sliced off
    // with no role:'tool' reply, leaving unmatched tool_call_ids — which a
    // provider rejects with a 400, losing the whole question.
    const many = Array.from({ length: 14 }, (_, i) => toolCall(`c${i}`, 'not_a_real_tool', { n: i }));
    const calls = scripted([
        { tool_calls: many },
        { content: 'Here is the comparison.' }
    ]);
    const out = await ask();

    assert.equal(out.source, 'ai');
    const second = calls[1].messages;
    const replies = second.filter((m) => m.role === 'tool');
    assert.equal(replies.length, 14, 'one reply per tool_call, not per executed tool');
    const ids = new Set(replies.map((m) => m.tool_call_id));
    for (const tc of many) assert.ok(ids.has(tc.id), `missing reply for ${tc.id}`);
    // the dropped ones are answered honestly rather than silently
    const dropped = replies.filter((m) => /budget exhausted/i.test(m.content));
    assert.equal(dropped.length, 2);
});

test('a tool call typed out as prose is never rendered as the answer', async () => {
    const calls = scripted([
        { content: '<tool_call>{"name": "get_quote", "arguments": {"symbol": "AAPL"}}</tool_call>' },
        { content: 'Apple quote data is unavailable.' }
    ]);
    const out = await ask();
    assert.equal(calls.length, 2, 'the prose tool call should trigger the one-shot retry');
    assert.equal(out.answer, 'Apple quote data is unavailable.');
    assert.ok(!out.answer.includes('tool_call'));
});

test('a fenced JSON tool call twice in a row degrades instead of showing markup', async () => {
    scripted([
        { content: '```json\n{"name": "get_quote", "arguments": {}}\n```' },
        { content: '```json\n{"name": "get_quote", "arguments": {}}\n```' }
    ]);
    const out = await ask();
    assert.equal(out.source, 'partial');
    assert.ok(!out.answer.includes('get_quote'));
    assert.ok(!out.answer.includes('```'));
});

test('reasoning blocks are stripped, including spaced delimiters', async () => {
    scripted([{ content: '<  think  >internal scratch work, never for the user</ think >The margin improved.' }]);
    const out = await ask();
    assert.equal(out.source, 'ai');
    assert.equal(out.answer, 'The margin improved.');
    assert.ok(!/scratch work/i.test(out.answer));
});

test('an answer that reveals the underlying model is blocked, not shown', async () => {
    scripted([{ content: "I'm ChatGPT, a large language model trained by OpenAI, and I think Apple looks cheap." }]);
    const out = await ask();
    assert.equal(out.source, 'blocked');
    assert.ok(!/ChatGPT|OpenAI/i.test(out.answer));
});

test('a normal tool round then a text answer reports source ai and the tools it used', async () => {
    scripted([
        { tool_calls: [toolCall('c1', 'not_a_real_tool', {})] },
        { content: 'The requested data is unavailable.' }
    ]);
    const out = await ask();
    assert.equal(out.source, 'ai');
    assert.equal(out.toolsUsed.length, 1);
    assert.equal(out.answer, 'The requested data is unavailable.');
});

test('malformed tool-call arguments do not crash the round', async () => {
    // ai-chat.js swallows a JSON.parse failure into {} on purpose; the handler
    // then reports its own missing-argument error back to the model.
    const calls = scripted([
        { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'not_a_real_tool', arguments: '{"symbol": ' } }] },
        { content: 'I could not read that.' }
    ]);
    const out = await ask();
    assert.equal(out.source, 'ai');
    assert.equal(calls[1].messages.filter((m) => m.role === 'tool').length, 1);
});

test('a scripted "companies like X" screen reaches the model as a real ranked table', async () => {
    // The anchor is chosen from the live index (widest fully-reported company)
    // rather than pinned — the snapshot refreshes monthly and the test is about
    // the loop carrying similar_to through, not about who the peers are.
    const usable = aiChat.buildScreenIndex().filter((r) => r.symbol && !r.symbol.includes('-') && r.revCagr5Pct !== null && r.netMarginPct !== null && r.roePct !== null && r.qtrNetIncomeYoYPct !== null);
    usable.sort((a, b) => (b.marketCapB || 0) - (a.marketCapB || 0));
    const anchor = usable[0];
    const calls = scripted([
        { tool_calls: [toolCall('c1', 'screen_universe', { similar_to: anchor.symbol, limit: 3 })] },
        { content: 'Here are companies resembling it.' }
    ]);
    const out = await ask();
    assert.equal(out.source, 'ai');
    const reply = JSON.parse(calls[1].messages.find((m) => m.role === 'tool').content);
    assert.equal(reply.similarTo.symbol, anchor.symbol);
    assert.equal(reply.similarTo.sectorConstrained, false);
    assert.ok(!reply.table.split('\n').some((line) => line.startsWith(anchor.symbol + '|')), 'the anchor is not in its own table');
    assert.match(reply.table, /similarity/i);
    assert.ok(out.toolsUsed.some((t) => t.tool === 'screen_universe' && t.args.similar_to === anchor.symbol));
});

test('the answer framework is injected for open-ended company questions only', async () => {
    const systemFor = async (question, mode) => {
        const calls = scripted([{ content: 'A short answer.' }]);
        await aiChat.ask({ question, history: [], ctx: {}, mode });
        return calls[0].messages.find((m) => m.role === 'system').content;
    };
    // Both modes carry their own shape, and never each other's.
    const analyst = await systemFor('How is AMD doing?', 'analyst');
    assert.match(analyst, /ANSWER FRAMEWORK/);
    assert.match(analyst, /industryProfile/, 'the industry profile is what personalises the metric rows');
    // The facet remedy is named as a bars block: a viz line chart cannot facet,
    // and the model wrote one anyway with the field set, which the renderer
    // silently ignored (measured on the phone render of a live answer).
    assert.match(analyst, /span more than about 10x it is a faceted bars block/i);
    assert.doesNotMatch(analyst, /ANSWER SHAPE/);
    const normal = await systemFor('AMD', 'normal');
    assert.match(normal, /ANSWER SHAPE/);
    assert.match(normal, /No chart for a bare ticker/);
    // Normal mode is simplified, not thin: it fetches the same evidence and
    // carries its own budget, in everyday English.
    assert.match(normal, /SIMPLE, NOT THIN/);
    assert.match(normal, /normal limit of 320 prose words/);
    assert.match(normal, /get_filing_diff/);
    assert.doesNotMatch(normal, /ANSWER FRAMEWORK/);
    // A named figure, period, comparison or portfolio question keeps the older
    // narrower behaviour: a lookup that grows into a report is the failure this
    // gate exists to prevent.
    for (const q of ['What is AMD revenue in FY2024?', 'Compare AMD and NVDA', 'How is my portfolio doing?', 'Summarise AMD latest results']) {
        for (const mode of ['analyst', 'normal']) {
            const system = await systemFor(q, mode);
            assert.doesNotMatch(system, /ANSWER FRAMEWORK|ANSWER SHAPE/, `${q} (${mode}) should stay a lookup`);
        }
    }
    // The read is a renderer hook (app.js matches the paragraph start), so the
    // prompt must spell the marker exactly as the renderer tests for it.
    assert.match(analyst, /beginning exactly "\*\*The read\*\* — "/);
});
