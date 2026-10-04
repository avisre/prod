'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const client = require('../ai-client');
const keys = ['OLLAMA_API_KEY', 'AI_BRIEFING_API_KEY', 'AI_BRIEFING_BASE_URL', 'AI_MODEL_CHAT', 'AI_CHAT_REASONING_EFFORT'];
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const realFetch = global.fetch;
after(() => { global.fetch = realFetch; for (const k of keys) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; });
test('known retired configuration migrates in both request paths with compatible reasoning', async () => {
    process.env.OLLAMA_API_KEY = 'test-only'; process.env.AI_BRIEFING_API_KEY = 'test-only'; process.env.AI_BRIEFING_BASE_URL = 'https://ollama.com/v1';
    process.env.AI_MODEL_CHAT = 'glm-5.1'; delete process.env.AI_CHAT_REASONING_EFFORT;
    const requests = [];
    global.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body); requests.push(body);
        return body.stream ? { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }
            : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    await client.chatRaw([], { purpose: 'chat' }); await client.chatRawStream([], { purpose: 'chat' });
    assert.ok(requests.every(r => r.model === 'glm-5.3' && r.reasoning_effort === 'low'));
    process.env.AI_MODEL_CHAT = 'explicit-supported-model';
    await client.chatRaw([], { purpose: 'chat' }); assert.equal(requests.at(-1).model, 'explicit-supported-model');
    delete process.env.AI_MODEL_CHAT;
    await client.chatRaw([], { purpose: 'chat' }); assert.equal(requests.at(-1).model, 'glm-5.3');
    process.env.AI_BRIEFING_BASE_URL = 'https://custom.example/v1'; process.env.AI_MODEL_CHAT = 'glm-5.1';
    await client.chatRaw([], { purpose: 'chat' }); assert.equal(requests.at(-1).model, 'glm-5.1');
});
