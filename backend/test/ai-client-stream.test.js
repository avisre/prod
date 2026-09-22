'use strict';

// The streaming tool-call assembler in ai-client.js is the most model-sensitive
// plumbing in the product and had zero test coverage before the glm-5.3 swap:
// `grep -rn "tool_calls" backend/test/` returned nothing at all. It reassembles
// OpenAI-style indexed deltas into whole tool calls, and every assumption it
// makes about delta shape is a provider behaviour that can change under a model
// swap without breaking a single other test.
//
// These cases pin the contract, not the model. No network: global.fetch is
// stubbed with hand-written SSE frames. No Mongo either — the usage tracker
// no-ops while mongoose.connection.readyState !== 1.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.OLLAMA_API_KEY = 'test-only-key'; // cfg() resolves lazily; never used
const aiClient = require('../ai-client');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

// Build an SSE response shaped like the provider's: one `data:` line per
// frame, optional comment/keep-alive lines, terminated by [DONE].
function sseResponse(lines) {
    const enc = new TextEncoder();
    const payload = lines.map((l) => (typeof l === 'string' ? l : `data: ${JSON.stringify(l)}`)).join('\n') + '\n';
    // Deliberately split mid-stream so the line buffer is exercised across
    // chunk boundaries the way a real socket delivers it.
    const bytes = enc.encode(payload);
    const cuts = [0, Math.floor(bytes.length / 3), Math.floor((bytes.length * 2) / 3), bytes.length];
    let i = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (i >= cuts.length - 1) return { done: true, value: undefined };
                    const slice = bytes.slice(cuts[i], cuts[i + 1]);
                    i++;
                    return { done: false, value: slice };
                }
            })
        }
    };
}
const frame = (delta, extra = {}) => ({ choices: [{ delta }], ...extra });
const stub = (lines) => { global.fetch = async () => sseResponse(lines); };

before(() => { global.fetch = async () => sseResponse([]); });

test('content deltas assemble in order and reach the onDelta listener', async () => {
    stub([
        frame({ content: 'Reve' }),
        frame({ content: 'nue grew' }),
        frame({ content: ' 14%.' }),
        'data: [DONE]'
    ]);
    const seen = [];
    const msg = await aiClient.chatRawStream([{ role: 'user', content: 'hi' }], { purpose: 'chat' }, (d) => seen.push(d));
    assert.equal(msg.content, 'Revenue grew 14%.');
    assert.deepEqual(seen, ['Reve', 'nue grew', ' 14%.']);
});

test('a tool call whose name arrives fragmented assembles into one whole name', async () => {
    stub([
        frame({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_', arguments: '' } }] }),
        frame({ tool_calls: [{ index: 0, function: { name: 'quote', arguments: '{"sym' } }] }),
        frame({ tool_calls: [{ index: 0, function: { name: '', arguments: 'bol":"AAPL"}' } }] }),
        'data: [DONE]'
    ]);
    const msg = await aiClient.chatRawStream([{ role: 'user', content: 'hi' }], { purpose: 'chat' });
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, 'get_quote');
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { symbol: 'AAPL' });
    assert.equal(msg.tool_calls[0].id, 'call_a');
});

test('parallel tool calls stay separate and come back in index order', async () => {
    // Round 1 of a compare question fires 9-12 of these; merging them would
    // silently turn a five-company comparison into one corrupt call.
    stub([
        frame({ tool_calls: [{ index: 1, id: 'b', function: { name: 'get_quote', arguments: '{"symbol":"MSFT"}' } }] }),
        frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'get_financials', arguments: '{"symbol":"AAPL","statement":"income"}' } }] }),
        frame({ tool_calls: [{ index: 2, id: 'c', function: { name: 'get_quote', arguments: '{"symbol":"NVDA"}' } }] }),
        'data: [DONE]'
    ]);
    const msg = await aiClient.chatRawStream([{ role: 'user', content: 'hi' }], { purpose: 'chat' });
    assert.equal(msg.tool_calls.length, 3);
    assert.deepEqual(msg.tool_calls.map((t) => t.id), ['a', 'b', 'c']);
    assert.deepEqual(msg.tool_calls.map((t) => t.function.name), ['get_financials', 'get_quote', 'get_quote']);
});

test('SSE comments, keep-alives and [DONE] are ignored, not parsed as content', async () => {
    stub([
        ': keep-alive',
        '',
        frame({ content: 'ok' }),
        'data: not-json-at-all',
        'data: [DONE]',
        frame({ content: 'IGNORED — after DONE the stream is still drained safely' })
    ]);
    const msg = await aiClient.chatRawStream([{ role: 'user', content: 'hi' }], { purpose: 'chat' });
    assert.ok(msg.content.startsWith('ok'));
    assert.ok(!msg.content.includes('not-json-at-all'));
});

test('a usage chunk lands on _usage so the loop can meter tokens', async () => {
    stub([
        frame({ content: 'hi' }),
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 } },
        'data: [DONE]'
    ]);
    const msg = await aiClient.chatRawStream([{ role: 'user', content: 'hi' }], { purpose: 'chat' });
    assert.equal(msg._usage.total_tokens, 1540);
    assert.equal(msg._usage.prompt_tokens, 1200);
});

test('a tool call with no id still gets one, so tool results can be matched back', async () => {
    // The Ask loop replies with { role:'tool', tool_call_id }. An id-less call
    // would produce an unmatchable reply and a provider 400 on the next round.
    stub([
        frame({ tool_calls: [{ index: 0, function: { name: 'get_portfolio', arguments: '{}' } }] }),
        'data: [DONE]'
    ]);
    const msg = await aiClient.chatRawStream([{ role: 'user', content: 'hi' }], { purpose: 'chat' });
    assert.equal(msg.tool_calls.length, 1);
    assert.ok(msg.tool_calls[0].id, 'every tool call must carry an id');
});
