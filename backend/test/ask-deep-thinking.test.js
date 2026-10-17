'use strict';

// Deep thinking on Ask: the toggle sends thinking:true and every chat-model call
// for that question asks for high reasoning effort. Without it the model default
// stays in place (ai-client reasoningFor), exactly as before.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.OLLAMA_API_KEY = 'test-only-key';
const aiChat = require('../ai-chat');

afterEach(() => aiChat.__resetDeps());

async function effortsFor(input) {
    const seen = [];
    const reply = (opts) => { if (opts && opts.purpose === 'chat') seen.push(opts.reasoningEffort); return { content: 'A 10-K is the annual report a US company files with the SEC.' }; };
    aiChat.__setDeps({
        chatRaw: async (messages, opts) => reply(opts),
        chatRawStream: async (messages, opts, onDelta) => { const m = reply(opts); if (onDelta) onDelta(m.content); return m; }
    });
    await aiChat.ask({ question: 'What is a 10-K?', history: [], ctx: {}, mode: 'normal', ...input });
    return seen;
}

test('deep thinking asks the chat model for high effort on every call', async () => {
    const seen = await effortsFor({ thinking: true });
    assert.ok(seen.length >= 1);
    assert.deepEqual([...new Set(seen)], ['high']);
});

test('without deep thinking the model default is left alone', async () => {
    const seen = await effortsFor({});
    assert.ok(seen.length >= 1);
    assert.deepEqual([...new Set(seen)], [null]);
});

test('the Ask page and every chat route carry the flag', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.equal((app.match(/const thinking = !!\(req\.body && req\.body\.thinking === true\);/g) || []).length, 2);
    assert.equal((app.match(/aiChat\.ask\(\{[^]*?\}\);/g) || []).filter((call) => /\bthinking\b/.test(call)).length, 4);
    const bundle = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'app.js'), 'utf8');
    assert.match(bundle, /localStorage\.getItem\('sp_ask_think_v1'\) === '1' \? \{ thinking: true \}/);
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(page, /id="ask-think"/);
});
