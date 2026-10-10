'use strict';

// Ask can change the signed-in user's account the way the pages do. These pin
// the safety rules that are enforced in code: a change runs only when the
// user's own message asked for it, a whole-portfolio delete needs a second
// confirming message, and the tools exist only for a signed-in chat.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.OLLAMA_API_KEY = 'test-only-key';
process.env.SEC_COVERAGE_READ_ONLY = '1'; process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
const site = require('../ask-site-actions'), aiChat = require('../ai-chat');
afterEach(() => aiChat.__resetDeps());

// A stand-in for the site's own endpoints, recording every call.
function fakeSite(holdings = [{ _id: 'h1', symbol: 'AMD', shares: 10, purchasePrice: 500, portfolioId: null }]) {
    const calls = [];
    const siteRequest = async (method, path, body) => {
        calls.push(`${method} ${path}`);
        if (method === 'GET' && path === '/api/portfolios') return { status: 200, body: { portfolios: [{ id: 'main', name: 'Main', holdingsCount: holdings.length }, { id: 'a'.repeat(24), name: 'Growth', holdingsCount: 2 }] } };
        if (method === 'GET' && path.startsWith('/api/portfolio')) return { status: 200, body: holdings };
        if (method === 'POST' && path === '/api/portfolio') return body.symbol === 'ZZZZ' ? { status: 400, body: { code: 'UNKNOWN_SYMBOL' } } : { status: 200, body: { ...body, name: body.symbol, currentPrice: 600, purchasePrice: body.purchasePrice || 600 } };
        if (method === 'POST' && path === '/api/alert-rules') return { status: 402, body: { message: 'This is a Pro feature.', code: 'PRO_REQUIRED' } };
        return { status: 200, body: { ok: true, removedHoldings: 2, symbols: [] } };
    };
    return { calls, siteRequest, writes: () => calls.filter(c => !c.startsWith('GET')) };
}

test('a change runs only when the user\'s own message asked for it', async () => {
    const s = fakeSite();
    for (const question of ['what is amd', 'summarise this page', 'who is the ceo of amd']) {
        assert.equal((await site.run('manage_portfolio', { action: 'add_holding', symbol: 'AMD', shares: 5 }, { siteRequest: s.siteRequest, question })).code, 'NOT_REQUESTED', question);
        assert.equal((await site.run('manage_portfolio', { action: 'remove_holding', symbol: 'AMD' }, { siteRequest: s.siteRequest, question })).code, 'NOT_REQUESTED', question);
        assert.equal((await site.run('manage_watchlist', { action: 'remove', symbols: ['AMD'] }, { siteRequest: s.siteRequest, question })).code, 'NOT_REQUESTED', question);
    }
    assert.deepEqual(s.writes(), []);
    const added = await site.run('manage_portfolio', { action: 'add_holding', symbol: 'amd', shares: 5 }, { siteRequest: s.siteRequest, question: 'add 5 amd to my portfolio' });
    assert.equal(added.ok, true); assert.match(added.note, /latest price was recorded/);
    assert.deepEqual(s.writes(), ['POST /api/portfolio']);
    // "yes" counts only as an answer to a change Ask proposed.
    assert.equal(site.allowed('add', { question: 'yes', history: [] }), false);
    assert.equal(site.allowed('add', { question: 'yes', history: [{ role: 'assistant', content: 'Do you want me to add 5 shares of AMD?' }] }), true);
});

test('deleting a whole portfolio needs a second, confirming message naming it', async () => {
    const s = fakeSite();
    const first = await site.run('manage_portfolio', { action: 'delete_portfolio', portfolio: 'Growth', confirmed: true }, { siteRequest: s.siteRequest, question: 'delete my growth portfolio', history: [] });
    assert.equal(first.needsConfirmation, true); assert.equal(first.holdingsThatWouldBeDeleted, 2); assert.deepEqual(s.writes(), []);
    const unrelated = await site.run('manage_portfolio', { action: 'delete_portfolio', portfolio: 'Growth', confirmed: true }, { siteRequest: s.siteRequest, question: 'yes', history: [{ role: 'assistant', content: 'Shall I add AMD to your watchlist?' }] });
    assert.equal(unrelated.needsConfirmation, true); assert.deepEqual(s.writes(), []);
    const done = await site.run('manage_portfolio', { action: 'delete_portfolio', portfolio: 'Growth', confirmed: true }, { siteRequest: s.siteRequest, question: 'yes', history: [{ role: 'assistant', content: 'This permanently deletes "Growth" and its 2 holdings. Reply yes to confirm.' }] });
    assert.equal(done.ok, true); assert.deepEqual(s.writes(), ['DELETE /api/portfolios/' + 'a'.repeat(24)]);
    assert.match((await site.run('manage_portfolio', { action: 'delete_portfolio', portfolio: 'Main' }, { siteRequest: s.siteRequest, question: 'delete main' })).error, /cannot be deleted/);
});

test('a partial sale writes the remainder before removing the original, and refusals change nothing', async () => {
    const s = fakeSite();
    const reduced = await site.run('manage_portfolio', { action: 'remove_holding', symbol: 'AMD', shares: 4 }, { siteRequest: s.siteRequest, question: 'sell 4 of my amd' });
    assert.deepEqual(reduced.reduced, { symbol: 'AMD', from: 10, to: 6, removedShares: 4 });
    assert.deepEqual(s.writes(), ['POST /api/portfolio', 'DELETE /api/portfolio/h1']);
    const t = fakeSite();
    assert.equal((await site.run('manage_portfolio', { action: 'remove_holding', symbol: 'KO' }, { siteRequest: t.siteRequest, question: 'remove ko' })).code, 'NOT_HELD');
    assert.equal((await site.run('manage_portfolio', { action: 'remove_holding', symbol: 'AMD', shares: 50 }, { siteRequest: t.siteRequest, question: 'sell 50 amd' })).code, 'TOO_MANY');
    assert.equal((await site.run('manage_portfolio', { action: 'add_holding', symbol: 'ZZZZ', shares: 1 }, { siteRequest: t.siteRequest, question: 'add 1 zzzz' })).code, 'UNKNOWN_SYMBOL');
    assert.match((await site.run('manage_portfolio', { action: 'add_holding', symbol: 'AMD' }, { siteRequest: t.siteRequest, question: 'add amd' })).error, /how many shares/);
    assert.deepEqual(t.writes(), ['POST /api/portfolio']); // only the unknown-symbol attempt reached the site
    const gated = await site.run('manage_alert_rules', { action: 'create', symbol: 'AMD', metric: 'pe', op: 'lt', value: 30 }, { siteRequest: t.siteRequest, question: 'alert me when amd pe is below 30' });
    assert.equal(gated.planLimit, true); assert.equal(gated.code, 'PRO_REQUIRED');
});

test('the account tools are offered only to a signed-in chat and never run without one', async () => {
    assert.equal((await site.run('manage_portfolio', { action: 'list' }, {})).code, 'SIGN_IN_REQUIRED');
    assert.equal((await aiChat.runTool('manage_watchlist', { action: 'add', symbols: ['AMD'] }, { userId: 'u1', question: 'add amd to my watchlist' })).code, 'SIGN_IN_REQUIRED');
    const offered = [];
    const chatRaw = async (messages, opts) => { offered.push((opts.tools || []).map(t => t.function.name)); return { role: 'assistant', content: 'Done.' }; };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o) });
    await aiChat.ask({ question: 'add amd to my watchlist', history: [], ctx: {}, mode: 'normal' });
    await aiChat.ask({ question: 'add amd to my watchlist', history: [], ctx: { siteRequest: fakeSite().siteRequest }, mode: 'normal' });
    assert.equal(offered[0].includes('manage_portfolio'), false);
    for (const name of ['manage_portfolio', 'manage_watchlist', 'manage_saved_screens', 'manage_alert_rules', 'manage_thesis']) assert.ok(offered[1].includes(name), name);
    assert.match(aiChat.ASK_SYSTEM, /ACCOUNT ACTIONS/);
    assert.equal(aiChat.TOOLS.some(t => t.function.name.startsWith('manage_')), false);
});

test('the engine passes the user\'s own question to an account action, so a tool call alone cannot change anything', async () => {
    const s = fakeSite();
    const call = (name, args) => ({ id: 'a', type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const script = [{ tool_calls: [call('manage_portfolio', { action: 'remove_holding', symbol: 'AMD' })] }, { content: 'Nothing was changed.' }];
    let i = 0;
    const chatRaw = async () => ({ role: 'assistant', content: '', ...script[i++] });
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o) });
    await aiChat.ask({ question: 'summarise the article at example.com', history: [], ctx: { siteRequest: s.siteRequest }, mode: 'normal' });
    assert.deepEqual(s.writes(), []);
});

test('an answer cannot say the account changed unless an account tool changed it in that turn', async () => {
    const call = (name, args) => ({ id: 'a', type: 'function', function: { name, arguments: JSON.stringify(args) } });
    // The model claims the removal with no tool call, is told so, and then does it.
    const s = fakeSite();
    let script = [{ content: 'AMD has been removed from your portfolio.' }, { tool_calls: [call('manage_portfolio', { action: 'remove_holding', symbol: 'AMD' })] }, { content: 'AMD has been removed from your Main portfolio.' }];
    let i = 0, seen = [];
    let chatRaw = async (messages) => { seen.push(messages[messages.length - 1]); return { role: 'assistant', content: '', ...script[i++] }; };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o) });
    const done = await aiChat.ask({ question: 'remove AMD from my portfolio', history: [], ctx: { siteRequest: s.siteRequest }, mode: 'normal' });
    assert.equal(s.writes().length, 1, 'the removal actually ran');
    assert.match(done.answer, /removed/);
    assert.match(String(seen[1].content), /no account tool ran/);
    // The model keeps claiming it without ever calling the tool: the user is told nothing changed.
    const s2 = fakeSite(); i = 0;
    script = [{ content: 'Done — AMD has been removed.' }, { content: 'AMD has been removed from your portfolio.' }];
    const stuck = await aiChat.ask({ question: 'remove AMD from my portfolio', history: [], ctx: { siteRequest: s2.siteRequest }, mode: 'normal' });
    assert.deepEqual(s2.writes(), []);
    assert.match(stuck.answer, /nothing in your account was changed/);
    assert.doesNotMatch(stuck.answer, /has been removed/);
    // A refusal or a plain question is left alone.
    assert.equal(site.unbackedClaim({ question: 'add PEP to my watchlist', answer: 'How many shares?', toolsUsed: [], ctx: { siteRequest: s.siteRequest } }), false);
    assert.equal(site.unbackedClaim({ question: 'when was KO added to the Dow?', answer: 'KO was added in 1987.', toolsUsed: [], ctx: { siteRequest: s.siteRequest } }), false);
});

test('after a holding changes the tool returns the complete current list, so the answer need not rely on memory', async () => {
    const s = fakeSite([{ _id: 'h1', symbol: 'AMD', shares: 10, purchasePrice: 500, portfolioId: null }, { _id: 'h2', symbol: 'NVDA', shares: 3, purchasePrice: 200, portfolioId: null }]);
    const out = await site.run('manage_portfolio', { action: 'add_holding', symbol: 'KO', shares: 1 }, { siteRequest: s.siteRequest, question: 'add 1 share of KO to my portfolio' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.holdingsNow.map(h => h.symbol), ['AMD', 'NVDA']);
    assert.match(out.holdingsNote, /complete, current list/);
});
