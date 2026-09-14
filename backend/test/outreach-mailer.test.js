'use strict';

// outreach-mailer.js — the cold-outreach sending identity.
//
// Every assertion here is about something FAILING CLOSED. Cold mail is the one
// path where a silent misconfiguration is expensive in a way that is invisible
// until customer mail starts landing in spam, so "refused to send" must always
// be the default and "sent" must be the thing that has to be earned.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const outreach = require('../outreach-mailer');

const SECRET = 'outreach-unit-test-secret-with-entropy';

test('it will not send on the support mailbox, and is off until configured', () => {
    assert.equal(outreach.isConfigured({}), false, 'unconfigured by default');

    // The whole reason this module is separate from mailer.js: cold mail must
    // never go out on the credential that carries receipts and password resets.
    const onSupport = {
        OUTREACH_SMTP_HOST: 'mail.example.com',
        OUTREACH_SMTP_USER: 'support@stockportfolio.pro',
        OUTREACH_SMTP_PASS: 'x'
    };
    assert.equal(outreach.isConfigured(onSupport), false, 'the support mailbox is refused outright');
    assert.match(outreach.configError(onSupport), /must NOT be support@/);

    const distinct = { ...onSupport, OUTREACH_SMTP_USER: 'outreach@mail.stockportfolio.pro' };
    assert.equal(outreach.isConfigured(distinct), true, 'a distinct mailbox is accepted');
    assert.equal(outreach.configError(distinct), null);
});

test('unsubscribe tokens carry the address, and cannot be forged', () => {
    // A cold prospect has no account, so the token cannot carry a userId the
    // way the digest one does — that is precisely the gap it closes.
    const token = outreach.unsubToken('Prospect@Example.COM', SECRET);
    assert.equal(outreach.verifyUnsubToken(token, SECRET), 'prospect@example.com', 'normalised on the way out');
    assert.equal(outreach.verifyUnsubToken(token, 'a-different-secret'), null, 'another secret cannot verify it');
    assert.equal(outreach.verifyUnsubToken(`${token.slice(0, -2)}xx`, SECRET), null, 'a tampered signature is rejected');
    assert.equal(outreach.verifyUnsubToken('garbage', SECRET), null);
    assert.equal(outreach.verifyUnsubToken('', SECRET), null);

    const { headers, url } = outreach.unsubHeaders('a@b.com', SECRET, {
        APP_PUBLIC_URL: 'https://x.test', OUTREACH_SMTP_USER: 'o@mail.x.test'
    });
    assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', 'RFC 8058 one-click');
    assert.match(headers['List-Unsubscribe'], /<https:\/\/x\.test\/api\/outreach\/unsubscribe\?token=/);
    assert.match(headers['List-Unsubscribe'], /mailto:/, 'a mailto fallback for clients that cannot POST');
    assert.match(url, /token=/);
});

test('it refuses to send without the safety net', async () => {
    const env = {
        OUTREACH_SMTP_HOST: 'mail.example.com',
        OUTREACH_SMTP_USER: 'outreach@mail.stockportfolio.pro',
        OUTREACH_SMTP_PASS: 'x'
    };
    const base = { to: 'a@b.com', subject: 's', text: 't', campaign: 'c', secret: SECRET, env };

    for (const [patch, why] of [
        [{ to: '' }, 'no recipient'],
        [{ campaign: '' }, 'no campaign id'],
        [{ secret: '' }, 'no signing secret'],
        [{ env: {} }, 'unconfigured transport']
    ]) {
        const res = await outreach.sendOutreach({ ...base, ...patch });
        assert.equal(res.sent, false, `must refuse: ${why}`);
        assert.ok(res.reason, 'and say why');
    }

    // Database unreachable: suppression cannot be checked, so sending would
    // risk mailing someone who already said stop. That must read as "no".
    assert.equal(mongoose.connection.readyState, 0, 'precondition: not connected');
    const res = await outreach.sendOutreach(base);
    assert.equal(res.sent, false, 'fails closed when suppression is uncheckable');
});

test('a suppressed address is never mailed again', async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    assert.equal(await outreach.isSuppressed('nobody@example.com'), false, 'unknown address is sendable');

    await outreach.suppress('Stop@Example.com', 'unsubscribe_link');
    assert.equal(await outreach.isSuppressed('stop@example.com'), true, 'case-insensitive');
    assert.equal(await outreach.isSuppressed('  STOP@example.com  '), true, 'whitespace-insensitive');

    // Idempotent: a second unsubscribe must not create a duplicate record.
    await outreach.suppress('stop@example.com', 'unsubscribe_one_click');
    const count = await mongoose.connection.collection('outreach_suppression')
        .countDocuments({ email: 'stop@example.com' });
    assert.equal(count, 1, 'one row per address no matter how often they unsubscribe');

    // An empty address is treated as suppressed rather than sendable.
    assert.equal(await outreach.isSuppressed(''), true);

    // And a send to a suppressed address is refused before any transport work.
    const res = await outreach.sendOutreach({
        to: 'stop@example.com', subject: 's', text: 't', campaign: 'c', secret: SECRET,
        env: { OUTREACH_SMTP_HOST: 'h', OUTREACH_SMTP_USER: 'outreach@mail.x.test', OUTREACH_SMTP_PASS: 'p' }
    });
    assert.equal(res.sent, false);
    assert.match(res.reason, /suppressed/);
});
