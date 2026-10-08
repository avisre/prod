'use strict';

// A signed-in account refused on a connector call gets one email telling it how
// to fix that. These tests pin who gets it, how often, and what it says.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const nudge = require('../connector-nudge');

const FACTS = { monthlyPrice: 79.99, lookupCost: 2, askCost: 42, topupCredits: 150, topupPrice: 14.99 };

async function setup(t) {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    const users = mongoose.connection.collection('users');
    const sent = [];
    const deps = { users, facts: FACTS, sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
    const add = async (extra = {}) => {
        const doc = { name: 'Todd Example', email: 'todd@example.com', ...extra };
        const r = await users.insertOne(doc);
        return { ...doc, _id: r.insertedId };
    };
    return { users, sent, deps, add };
}

test('a refused account is emailed once, and not again inside the interval', { timeout: 60000 }, async (t) => {
    const { users, sent, deps, add } = await setup(t);
    const user = await add();
    assert.equal(await nudge.maybeSend({ user, code: 'ENTITLEMENT_REQUIRED' }, deps), 'sent:no_access');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'todd@example.com');

    // Twelve refused calls in a burst is what a real connection produces.
    const burst = await Promise.all(Array.from({ length: 12 }, () => nudge.maybeSend({ user, code: 'ENTITLEMENT_REQUIRED' }, deps)));
    assert.ok(burst.every((s) => s === 'throttled'), burst.join(','));
    assert.equal(sent.length, 1, 'still one email');

    // The other reason has its own throttle.
    assert.equal(await nudge.maybeSend({ user, code: 'QUOTA_EXCEEDED', resetsAt: '2026-11-01' }, deps), 'sent:out_of_credits');
    assert.equal(sent.length, 2);

    // After the interval the same reason may be sent again.
    const later = new Date(Date.now() + (nudge.NUDGE_INTERVAL_DAYS + 1) * 24 * 60 * 60 * 1000);
    assert.equal(await nudge.maybeSend({ user, code: 'ENTITLEMENT_REQUIRED' }, { ...deps, now: () => later }), 'sent:no_access');
    const stored = await users.findOne({ _id: user._id });
    assert.equal(stored.connectorNudges.no_accessAt.getTime(), later.getTime());
});

test('concurrent first refusals send exactly one email', { timeout: 60000 }, async (t) => {
    const { sent, deps, add } = await setup(t);
    const user = await add();
    const results = await Promise.all(Array.from({ length: 8 }, () => nudge.maybeSend({ user, code: 'ENTITLEMENT_REQUIRED' }, deps)));
    assert.equal(results.filter((s) => s === 'sent:no_access').length, 1, results.join(','));
    assert.equal(sent.length, 1);
});

test('nobody who should not get it does', { timeout: 60000 }, async (t) => {
    const { sent, deps, add } = await setup(t);
    const user = await add();
    assert.equal(await nudge.maybeSend({ user, code: 'ENTITLEMENT_REQUIRED', anonymous: true }, deps), 'anonymous');
    assert.equal(await nudge.maybeSend({ user: null, code: 'ENTITLEMENT_REQUIRED' }, deps), 'anonymous');
    assert.equal(await nudge.maybeSend({ user: await add({ email: 'r@example.com', reviewAccount: true }), code: 'ENTITLEMENT_REQUIRED' }, deps), 'review_account');
    assert.equal(await nudge.maybeSend({ user: await add({ email: '' }), code: 'ENTITLEMENT_REQUIRED' }, deps), 'no_email');
    // Codes that are not a plan or allowance problem never produce mail.
    for (const code of ['COMPANY_NOT_FOUND', 'UPSTREAM_DATA_ERROR', 'INSUFFICIENT_SCOPE', null]) {
        assert.equal(await nudge.maybeSend({ user, code }, deps), 'not_a_nudge');
    }
    assert.equal(sent.length, 0);
});

test('a send that fails releases the throttle so the next refusal tries again', { timeout: 60000 }, async (t) => {
    const { users, sent, deps, add } = await setup(t);
    const user = await add();
    assert.equal(await nudge.maybeSend({ user, code: 'QUOTA_EXCEEDED' }, { ...deps, sendMail: async () => false }), 'send_failed');
    const stored = await users.findOne({ _id: user._id });
    assert.ok(!stored.connectorNudges || !stored.connectorNudges.out_of_creditsAt, 'the claim was released');
    assert.equal(await nudge.maybeSend({ user, code: 'QUOTA_EXCEEDED' }, deps), 'sent:out_of_credits');
    assert.equal(sent.length, 1);
    // A mailer that throws is reported, never raised into the tool call.
    assert.equal(await nudge.maybeSend({ user: await add({ email: 'b@example.com' }), code: 'QUOTA_EXCEEDED' }, { ...deps, sendMail: async () => { throw new Error('smtp down'); } }), 'error');
});

test('the no-access email names the plan, the price and the upgrade page', () => {
    const mail = nudge.nudgeEmail('no_access', { name: 'Todd Example', ...FACTS });
    assert.equal(mail.subject, 'Your StockPortfolio connector needs a plan that includes it');
    for (const body of [mail.text, mail.html]) {
        assert.match(body, /Hi Todd,/);
        assert.match(body, /does not include the connector/);
        assert.match(body, /\$79\.99 a month/);
        assert.match(body, /100 credits a month \(a data lookup costs 2 credits, an AI answer 42\)/);
        assert.match(body, /stockportfolio\.pro\/upgrade\.html\?utm_source=connector/);
        assert.match(body, /do not need to reconnect/);
        assert.match(body, /at most once every 30 days/);
    }
});

test('the out-of-credits email names the top-up and when credits return', () => {
    const mail = nudge.nudgeEmail('out_of_credits', { name: '', resetsAt: '2026-11-01T00:00:00.000Z', ...FACTS });
    assert.match(mail.text, /Hi there,/);
    assert.match(mail.text, /come back on 1 November 2026\./);
    assert.match(mail.text, /a top-up adds 150 credits for \$14\.99/);
    assert.match(mail.text, /stockportfolio\.pro\/recharge\.html\?utm_source=connector/);
    assert.match(mail.html, /Top up 150 credits/);
    assert.match(nudge.nudgeEmail('out_of_credits', FACTS).text, /come back at the start of next month/);
    assert.equal(nudge.nudgeEmail('something_else', FACTS), null);
});

test('a name cannot inject markup into the email', () => {
    const mail = nudge.nudgeEmail('no_access', { name: '<img src=x onerror=alert(1)>', ...FACTS });
    assert.doesNotMatch(mail.html, /<img/);
});

test('app.js sends it for signed-in callers on both endpoints, through the support mailer, with an off switch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    // /mcp also records the refusal for the account's usage log after the nudge,
    // so the call is matched on its own rather than as the hook's last statement.
    assert.equal((src.match(/nudgeOnRefusal\(req, evt\);/g) || []).length, 2, 'wired into /mcp and /mcp/apps keyed paths');
    const fn = src.slice(src.indexOf('function nudgeOnRefusal'), src.indexOf('function logMcp'));
    assert.match(fn, /sendMail: mailer\.sendMail/, 'customer mail goes through the support@ mailer');
    assert.match(fn, /anonymous: false/);
    assert.match(fn, /CONNECTOR_NUDGE_EMAILS/);
    // The anonymous branches keep their plain logger: no address, no email.
    assert.match(src, /entitled: \(\) => false,\s*\n\s*wallReason: [^\n]*\n\s*onLog: logMcp/);
});
