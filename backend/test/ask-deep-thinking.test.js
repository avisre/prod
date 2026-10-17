'use strict';

// Deep thinking on Ask: the toggle sends thinking:'high' (or 'max' for the admin
// account) and every chat-model call for that question asks for that reasoning
// effort, at 3x the credits. Without it the model default stays in place
// (ai-client reasoningFor), exactly as before.

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
    for (const thinking of ['high', true]) {
        const seen = await effortsFor({ thinking });
        assert.ok(seen.length >= 1);
        assert.deepEqual([...new Set(seen)], ['high']);
    }
});

test('max thinking reaches the model as max effort', async () => {
    const seen = await effortsFor({ thinking: 'max' });
    assert.ok(seen.length >= 1);
    assert.deepEqual([...new Set(seen)], ['max']);
});

test('without deep thinking the model default is left alone', async () => {
    const seen = await effortsFor({});
    assert.ok(seen.length >= 1);
    assert.deepEqual([...new Set(seen)], [null]);
});

test('the signed-in route gives max to the admin only, charges 3x and refuses when credits fall short', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(app, /const DEEP_THINKING_CREDIT_FACTOR = credits\.DEEP_THINKING_FACTOR;/);
    assert.equal(require('../credits').DEEP_THINKING_FACTOR, 3);
    // Max only when the signed-in email is the admin account; anyone else asking for max gets high.
    assert.match(app, /thinkingAsked === 'max' && String\(req\.user && req\.user\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\) === CUSTOMER_MESSAGES_ADMIN_EMAIL \? 'max'/);
    assert.match(app, /\(thinkingAsked === 'high' \|\| thinkingAsked === 'max' \|\| thinkingAsked === true\) \? 'high' : null;/);
    assert.match(app, /const CUSTOMER_MESSAGES_ADMIN_EMAIL = 'rin@gmail\.com';/);
    assert.match(app, /const creditFactor = thinking \? DEEP_THINKING_CREDIT_FACTOR : 1;/);
    assert.match(app, /code: 'DEEP_THINKING_CREDITS'/);
    // Flat price, per-step budget and the long-answer charge all scale.
    assert.equal((app.match(/credits\.spend\(userId, thinking \? creditFactor \* credits\.COST\.ask : 'ask', 'ask'\)/g) || []).length, 2);
    assert.match(app, /creditsFor: \(tokens\) => creditFactor \* credits\.askCredits\(tokens\)/);
    assert.match(app, /askBudget\.charge\(creditFactor \* credits\.askCredits\(result\.totalTokens\)\)/);
    // Only the two signed-in calls carry the flag; the signed-out trial never thinks.
    assert.equal((app.match(/aiChat\.ask\(\{[^]*?\}\);/g) || []).filter((call) => /\bthinking\b/.test(call)).length, 2);
});

test('the Ask page warns before turning it on and shows Max to the admin only', () => {
    const bundle = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'app.js'), 'utf8');
    assert.match(bundle, /\['high', 'max'\]\.includes\(localStorage\.getItem\('sp_ask_think_v1'\)\) \? \{ thinking: localStorage\.getItem\('sp_ask_think_v1'\) \}/);
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(page, /id="ask-think"/);
    assert.match(page, /id="ask-think-max"[^>]*hidden/);
    assert.match(page, /Deep thinking uses 3x the credits/);
    assert.match(page, /=== 'rin@gmail\.com'/);
});
