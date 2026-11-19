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

// Every failed Max answer on 2026-10-18 stopped at exactly 8,000 completion
// tokens with no text: the reasoning used the whole budget, twice.
test('deep thinking gets room to write; High no longer shares the standard budget', async () => {
    // High kept 8,000 like a plain answer until 2026-11-19. Reasoning is spent
    // from the same completion budget, so High returned empty content twice and
    // the Sandisk question degraded to the receipt while Normal mode answered.
    for (const [input, want] of [[{ thinking: 'max' }, 32000], [{ thinking: 'high' }, 24000], [{}, 8000]]) {
        const caps = [];
        aiChat.__setDeps({
            chatRaw: async (m, opts) => { if (opts.purpose === 'chat') caps.push(opts.maxTokens); return { content: 'A 10-K is the annual report a US company files with the SEC.' }; },
            chatRawStream: async (m, opts) => { if (opts.purpose === 'chat') caps.push(opts.maxTokens); return { content: 'A 10-K is the annual report a US company files with the SEC.' }; }
        });
        await aiChat.ask({ question: 'What is a 10-K?', history: [], ctx: {}, mode: 'normal', ...input });
        assert.ok(caps.length >= 1);
        assert.deepEqual([...new Set(caps)], [want]);
    }
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
    assert.match(page, /class="composer-row"[\s\S]*id="think-wrap"[\s\S]*id="mic-btn"/);
    assert.match(page, /data-think="high"/);
    assert.match(page, /id="ask-think-max"[^>]*hidden/);
    assert.match(page, /Deep thinking uses 3x the credits/);
    assert.match(page, /=== 'rin@gmail\.com'/);
});

// --- Deep thinking must not spend its whole budget reasoning -----------------
// Measured on production 2026-11-19: the Sandisk 12-quarter question answered
// correctly in Normal mode and returned the bare-figure receipt in High mode.
// High kept the standard 8,000-token cap, the model spent it in the hidden
// channel, returned empty content twice at the same effort, and the answer
// degraded. Max had already been given room to write; High had not.

function scriptedThinking(respond) {
    const calls = [];
    const chatRaw = async (messages, opts) => {
        calls.push({ messages: JSON.parse(JSON.stringify(messages)), opts: { ...opts } });
        return respond(opts, calls.length) || { role: 'assistant', content: '' };
    };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o) });
    return calls;
}

test('high thinking gets room to write, not the standard answer budget', async () => {
    const calls = scriptedThinking(() => ({ role: 'assistant', content: 'Hello — happy to help.' }));
    await aiChat.ask({ question: 'hi', history: [], ctx: {}, mode: 'normal', thinking: 'high' });
    const first = calls[0].opts;
    assert.equal(first.reasoningEffort, 'high');
    assert.ok(first.maxTokens >= 20000, `high effort must budget for hidden reasoning plus the answer (got ${first.maxTokens})`);

    const plain = scriptedThinking(() => ({ role: 'assistant', content: 'Hello — happy to help.' }));
    await aiChat.ask({ question: 'hi', history: [], ctx: {}, mode: 'normal' });
    assert.equal(plain[0].opts.maxTokens, 8000, 'the standard answer budget is unchanged');
    assert.equal(plain[0].opts.reasoningEffort, null);
});

test('an empty high-effort draft retries at a lower effort instead of degrading to a receipt', async () => {
    const calls = scriptedThinking((opts) => {
        if (opts.reasoningEffort === 'high') return { role: 'assistant', content: '' };   // spent it reasoning
        return { role: 'assistant', content: 'Hello — here is the answer you paid for.' };
    });
    const out = await aiChat.ask({ question: 'hi', history: [], ctx: {}, mode: 'normal', thinking: 'high' });
    const efforts = calls.map(c => c.opts.reasoningEffort);
    assert.equal(efforts[0], 'high');
    assert.ok(efforts.slice(1).some(e => e && e !== 'high'), `retry should lower the effort, saw ${JSON.stringify(efforts)}`);
    assert.equal(out.source, 'ai', 'the reader gets an answer, not the receipt');
    assert.match(out.answer, /here is the answer you paid for/);
});

test('max effort steps down to high on an empty draft, never straight to a receipt', async () => {
    const calls = scriptedThinking((opts) => {
        if (opts.reasoningEffort === 'max') return { role: 'assistant', content: '' };
        return { role: 'assistant', content: 'Answered at the lower effort.' };
    });
    const out = await aiChat.ask({ question: 'hi', history: [], ctx: {}, mode: 'normal', thinking: 'max' });
    assert.deepEqual(calls.map(c => c.opts.reasoningEffort).slice(0, 2), ['max', 'high']);
    assert.equal(out.source, 'ai');
});
