'use strict';

// Screens saved on the account (owner decision 2026-10-10): the Screener page
// and Ask's save_screen tool both store a name and one set of screen criteria.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const savedScreens = require('../saved-screens');
const aiChat = require('../ai-chat');

async function withMongo(t) {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });
}

test('a screen is saved, listed, replaced by name and deleted, per account', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const a = await savedScreens.save('user-a', { name: '  Cheap   growers ', criteria: { max_pe: 20, min_revenue_cagr_5y_pct: 10 }, source: 'ask' });
    assert.equal(a.name, 'Cheap growers', 'the name is tidied');
    assert.deepEqual(a.criteria, { max_pe: 20, min_revenue_cagr_5y_pct: 10 });
    assert.equal(a.source, 'ask');

    // Same name, any case: replaced, not duplicated.
    const again = await savedScreens.save('user-a', { name: 'cheap GROWERS', criteria: { max_pe: 15 } });
    assert.equal(again.id, a.id);
    assert.deepEqual(again.criteria, { max_pe: 15 });
    assert.equal((await savedScreens.list('user-a')).length, 1);

    // Another account sees nothing and cannot read or delete it by id.
    assert.deepEqual(await savedScreens.list('user-b'), []);
    assert.equal(await savedScreens.get('user-b', a.id), null);
    assert.equal(await savedScreens.remove('user-b', a.id), false);
    assert.equal((await savedScreens.get('user-a', a.id)).name, 'cheap GROWERS');

    assert.equal(await savedScreens.remove('user-a', a.id), true);
    assert.deepEqual(await savedScreens.list('user-a'), []);
    assert.equal(await savedScreens.get('user-a', 'not-an-id'), null);
});

test('a screen needs an account, a name and at least one filter, and an account holds 20', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    await assert.rejects(() => savedScreens.save('', { name: 'x', criteria: { max_pe: 1 } }), { code: 'SIGN_IN_REQUIRED' });
    await assert.rejects(() => savedScreens.save('u', { name: '   ', criteria: { max_pe: 1 } }), { code: 'NAME_REQUIRED' });
    for (const criteria of [undefined, null, {}, [], 'max_pe=1']) {
        await assert.rejects(() => savedScreens.save('u', { name: 'x', criteria }), { code: 'CRITERIA_REQUIRED' });
    }
    for (let i = 0; i < savedScreens.MAX_PER_ACCOUNT; i++) await savedScreens.save('u', { name: `screen ${i}`, criteria: { max_pe: i + 1 } });
    await assert.rejects(() => savedScreens.save('u', { name: 'one too many', criteria: { max_pe: 1 } }), { code: 'LIMIT_REACHED' });
    // Replacing an existing name is still allowed at the limit.
    assert.ok(await savedScreens.save('u', { name: 'screen 3', criteria: { max_pe: 99 } }));
    assert.equal(savedScreens.cleanName(`a\nb\u0000c${'x'.repeat(200)}`).length, savedScreens.NAME_MAX);
});

test('Ask’s save_screen tool stores only whitelisted screen filters, and only for a signed-in user', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const out = await aiChat.toolSaveScreen({
        name: 'Quality compounders', max_pe: '25', min_roe_pct: 15, require_positive_fcf: true,
        // None of these are screen filters; none may be stored.
        limit: 500, sort_by: 'pe', $where: 'sleep(1000)', userId: 'someone-else', __proto__: { polluted: true }
    }, { userId: 'user-a' });
    assert.equal(out.ok, true);
    assert.equal(out.name, 'Quality compounders');
    assert.deepEqual(out.filters, { min_roe_pct: 15, max_pe: 25, require_positive_fcf: true });
    assert.match(out.link, /^\/screener\?screen=[0-9a-f]{24}$/);
    const [stored] = await savedScreens.list('user-a');
    assert.deepEqual(stored.criteria, out.filters);
    assert.equal(stored.source, 'ask');
    assert.deepEqual(await savedScreens.list('someone-else'), []);

    assert.match((await aiChat.toolSaveScreen({ name: 'x', max_pe: 10 }, {})).error, /needs an account/);
    assert.match((await aiChat.toolSaveScreen({ name: 'x', max_pe: 10 }, null)).error, /needs an account/);
    assert.match((await aiChat.toolSaveScreen({ name: 'x' }, { userId: 'user-a' })).error, /at least one filter/);
    assert.match((await aiChat.toolSaveScreen({ max_pe: 10 }, { userId: 'user-a' })).error, /name/i);
});

test('the routes are signed-in only and clean their criteria the way /api/screener does', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    for (const route of ["app.get('/api/screens', authMiddleware", "app.post('/api/screens', authMiddleware", "app.get('/api/screens/:id', authMiddleware", "app.delete('/api/screens/:id', authMiddleware"]) {
        assert.ok(app.includes(route), route);
    }
    assert.match(app, /savedScreens\.save\(req\.userId, \{[\s\S]{0,120}criteria: aiChat\.screenArgsFromClient\(body\.criteria\)/);
    assert.ok(app.includes("col('saved_screens').createIndex({ userId: 1, nameKey: 1 }"));
});
