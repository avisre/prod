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
        assert.match(body, /200 credits a month \(a data lookup costs 2 credits, an AI answer 42\)/);
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
    // (The usage-log and tool-data deps may sit between, but never a nudge.)
    assert.match(src, /entitled: \(\) => false,\s*\n\s*wallReason: [^\n]*\n(?:\s*(?:usage: mcpUsageCallback|\.\.\.mcpToolDeps\(\))[^\n]*\n)*\s*onLog: logMcp\n/);
});

// ---------------------------------------------------------------------------
// The trial-stage emails (mcp-trial.js): started at the first call, a reminder
// with 7 days left, and ended when the 30 days are over or the allowance is
// used up. Each is sent AT MOST ONCE per account, ever — a trial is a one-shot
// funnel, so there is no interval after which a stage repeats.
// ---------------------------------------------------------------------------

// The shape mcp-trial.status() returns, overridable per test.
const TRIAL_STATUS = (over = {}) => ({
    started: true,
    startedAt: '2026-10-01T10:00:00.000Z',
    endsAt: '2026-10-31T10:00:00.000Z',
    daysLeft: 25,
    lookupsUsed: 2, asksUsed: 0,
    lookupsLeft: 23, asksLeft: 3,
    lookupsLimit: 25, asksLimit: 3, days: 30,
    ended: false,
    ...over
});

test('the trial stages each send once, ever, and never repeat', { timeout: 60000 }, async (t) => {
    const { users, sent, deps, add } = await setup(t);
    const user = await add();
    const trialDeps = { ...deps, status: async () => TRIAL_STATUS() };

    assert.equal(await nudge.maybeSendTrial({ user }, trialDeps), 'sent:started', 'the first call starts the funnel');
    assert.equal(sent.length, 1);
    assert.equal(await nudge.maybeSendTrial({ user }, trialDeps), 'throttled', 'the started email never repeats');
    assert.equal(sent.length, 1);

    const remind = { ...trialDeps, status: async () => TRIAL_STATUS({ daysLeft: 5 }) };
    assert.equal(await nudge.maybeSendTrial({ user }, remind), 'sent:reminder', '7 days out, the reminder goes');
    assert.equal(await nudge.maybeSendTrial({ user }, remind), 'throttled');

    const ended = { ...trialDeps, status: async () => TRIAL_STATUS({ ended: true, daysLeft: 0 }) };
    assert.equal(await nudge.maybeSendTrial({ user }, ended), 'sent:ended', 'the end is its own stage');
    assert.equal(await nudge.maybeSendTrial({ user }, ended), 'throttled');
    assert.equal(sent.length, 3, 'exactly three trial emails across the whole funnel');

    // The claims live in their own once-ever fields, separate from the nudge
    // throttle fields — a later wallet nudge still works.
    const stored = await users.findOne({ _id: user._id });
    assert.ok(stored.mcpTrialEmails.startedAt, 'the started claim is stored');
    assert.ok(stored.mcpTrialEmails.reminderAt, 'the reminder claim is stored');
    assert.ok(stored.mcpTrialEmails.endedAt, 'the ended claim is stored');
    assert.equal(await nudge.maybeSend({ user, code: 'QUOTA_EXCEEDED' }, deps), 'sent:out_of_credits', 'the wallet nudge keeps its own throttle');
});

test('concurrent first calls send exactly one started email; a failed send releases the claim', { timeout: 60000 }, async (t) => {
    const { users, sent, deps, add } = await setup(t);
    const user = await add();
    const trialDeps = { ...deps, status: async () => TRIAL_STATUS() };
    const burst = await Promise.all(Array.from({ length: 8 }, () => nudge.maybeSendTrial({ user }, trialDeps)));
    assert.equal(burst.filter((s) => s === 'sent:started').length, 1, burst.join(','));
    assert.equal(sent.length, 1);

    const other = await add({ email: 'two@example.com' });
    const failing = { ...trialDeps, sendMail: async () => false };
    assert.equal(await nudge.maybeSendTrial({ user: other }, failing), 'send_failed');
    const stored = await users.findOne({ _id: other._id });
    assert.ok(!stored.mcpTrialEmails || !stored.mcpTrialEmails.startedAt, 'the claim was released');
    assert.equal(await nudge.maybeSendTrial({ user: other }, trialDeps), 'sent:started', 'and the next call tries again');
});

test('the trial emails say what is included, when it ends, and how to continue — without naming the AI provider', () => {
    const started = nudge.trialEmail('started', { name: 'Todd Example', monthlyPrice: 79.99, lookupCost: 2, askCost: 42, endsAt: '2026-10-31T10:00:00.000Z', daysLeft: 30, lookupsLeft: 25, asksLeft: 3, lookups: 25, asks: 3, days: 30 });
    assert.equal(started.subject, 'Your StockPortfolio connector free trial has started');
    for (const body of [started.text, started.html]) {
        assert.match(body, /Hi Todd,/);
        assert.match(body, /25 data lookups and 3 AI answers over 30 days/);
        assert.match(body, /until 31 October 2026/);
        assert.match(body, /\$79\.99 a month/);
        assert.match(body, /200 credits a month/);
        assert.match(body, /stockportfolio\.pro\/upgrade\.html\?utm_source=connector/);
        // The AI provider answering Ask is a trade secret; the assistants are not.
        assert.doesNotMatch(body, /ollama|glm-?\d/i);
    }

    const reminder = nudge.trialEmail('reminder', { name: '', monthlyPrice: 79.99, lookupCost: 2, askCost: 42, endsAt: '2026-10-31T10:00:00.000Z', daysLeft: 5, lookupsLeft: 20, asksLeft: 2, lookups: 25, asks: 3, days: 30 });
    assert.equal(reminder.subject, '7 days left in your StockPortfolio connector free trial');
    assert.match(reminder.text, /ends on 31 October 2026 — 5 days from now/);
    assert.match(reminder.text, /20 data lookups and 2 AI answers are left/);

    const ended = nudge.trialEmail('ended', { name: 'Todd', monthlyPrice: 79.99, lookupCost: 2, askCost: 42, lookups: 25, asks: 3, days: 30, endsAt: '2026-10-31T10:00:00.000Z' });
    assert.match(ended.text, /30-day free trial .* has ended \(31 October 2026\)/);
    assert.match(ended.text, /included 25 data lookups and 3 AI answers over 30 days/);

    const usedUp = nudge.trialEmail('ended', { name: 'Todd', monthlyPrice: 79.99, lookupCost: 2, askCost: 42, lookups: 25, asks: 3, days: 30, usedUp: true });
    assert.match(usedUp.text, /used up its 25 data lookups and 3 AI answers/, 'an exhausted allowance is worded differently from a lapsed window');
    assert.equal(nudge.trialEmail('other'), null, 'an unknown stage produces no email');
    // A name cannot inject markup into any of the trial emails.
    assert.doesNotMatch(nudge.trialEmail('started', { name: '<img src=x onerror=alert(1)>', monthlyPrice: 79.99, lookupCost: 2, askCost: 42 }).html, /<img/);
});

test('an allowance partially used is not the end; a TRIAL_ENDED refusal is', { timeout: 60000 }, async (t) => {
    const { sent, deps, add } = await setup(t);
    const user = await add();
    // All 25 lookups spent, 3 asks left: not over — the started stage applies.
    const partial = { ...deps, status: async () => TRIAL_STATUS({ lookupsUsed: 25, lookupsLeft: 0 }) };
    assert.equal(await nudge.maybeSendTrial({ user, code: 'QUOTA_EXCEEDED' }, partial), 'sent:started', 'a partially used allowance is not the end');
    assert.match(sent[0].text, /free trial on your account is now active/, 'the copy still describes the running trial');

    const over = await add({ email: 'three@example.com' });
    const done = { ...deps, status: async () => TRIAL_STATUS({ ended: true, daysLeft: 0, lookupsUsed: 25, asksUsed: 3, lookupsLeft: 0, asksLeft: 0 }) };
    assert.equal(await nudge.maybeSendTrial({ user: over, code: 'TRIAL_ENDED' }, done), 'sent:ended');
    // Nobody who should not get one does.
    assert.equal(await nudge.maybeSendTrial({ user: null }, done), 'no_user');
    assert.equal(await nudge.maybeSendTrial({ user: await add({ email: '' }) }, done), 'no_email');
    assert.equal(await nudge.maybeSendTrial({ user: await add({ email: 'r@example.com', reviewAccount: true }) }, done), 'review_account');
    assert.equal(await nudge.maybeSendTrial({ user: over }, { ...done, status: null }), 'not_configured');
    assert.equal(await nudge.maybeSendTrial({ user: over }, { ...done, status: async () => ({ started: false }) }), 'not_started');
    // A mailer that throws is reported, never raised into the tool call.
    assert.equal(await nudge.maybeSendTrial({ user: await add({ email: 'x@example.com' }) }, { ...done, sendMail: async () => { throw new Error('smtp down'); } }), 'error');
});

test('a TRIAL_ENDED refusal through the nudge path uses the once-ever trial claim and the trial copy', { timeout: 60000 }, async (t) => {
    const { users, sent, deps, add } = await setup(t);
    const user = await add();
    // nudgeOnRefusal routes refusal codes through REASON_BY_CODE; TRIAL_ENDED
    // is in that map, so the nudge path must produce the trial email, claimed
    // once ever under mcpTrialEmails — not a 30-day connectorNudges throttle.
    assert.equal(await nudge.maybeSend({ user, code: 'TRIAL_ENDED' }, deps), 'sent:trial_ended');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /free trial .* has ended/);
    assert.match(sent[0].text, /200 credits a month/);
    assert.equal(await nudge.maybeSend({ user, code: 'TRIAL_ENDED' }, { ...deps, now: () => new Date(Date.now() + 400 * 24 * 60 * 60 * 1000) }), 'throttled', 'the ended stage never repeats, even after an interval');
    const stored = await users.findOne({ _id: user._id });
    assert.ok(stored.mcpTrialEmails.endedAt, 'the claim lives in the once-ever trial field');
    assert.ok(!stored.connectorNudges || !stored.connectorNudges.trial_endedAt, 'not in the nudge throttle fields');
});

test('app.js wires the trial emails fire-and-forget behind the nudge off-switch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const fn = src.slice(src.indexOf('function trialEmailOnEvent'), src.indexOf('function logMcp'));
    assert.match(fn, /CONNECTOR_NUDGE_EMAILS/, 'the nudge off-switch silences the trial emails too');
    assert.match(fn, /connectorNudge\.maybeSendTrial/, 'the stage logic lives in connector-nudge.js');
    assert.match(fn, /status: \(\) => mcpTrial\.status\(req\.userId\)/, 'the stage is read from the live trial status');
    assert.match(fn, /sendMail: mailer\.sendMail/, 'customer mail goes through the support@ mailer');
    assert.match(fn, /\.catch\(\(\) => \{\}\)/, 'a failed email never fails the tool result');
    assert.equal(nudge.TRIAL_FIELD.started, 'mcpTrialEmails.startedAt');
    assert.equal(nudge.TRIAL_FIELD.reminder, 'mcpTrialEmails.reminderAt');
    assert.equal(nudge.TRIAL_FIELD.ended, 'mcpTrialEmails.endedAt');
});
