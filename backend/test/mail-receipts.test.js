'use strict';
// Send receipts. Every sending path used to collapse nodemailer's result to a
// boolean, so a delivered-looking send could not be checked afterwards — the
// 2026-09-23 broker batch is unfalsifiable for exactly that reason. These tests
// lock in the receipt contract plus the surfaces that expose it.
//
// Structural checks (read source + assert its shape) follow the convention in
// profile-consolidation.test.js: app.js is a large monolith not worth booting a
// real server for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend-v2');
const readBackend = (name) => fs.readFileSync(path.join(BACKEND, name), 'utf8');
const readFrontend = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');

const mailer = require('../mailer');

test('newMessageId returns a bracketed id on the support domain', () => {
    const id = mailer.newMessageId();
    assert.match(id, /^<[0-9a-f-]{36}@stockportfolio\.pro>$/);
    assert.notEqual(id, mailer.newMessageId(), 'ids must not repeat');
});

test('receiptFrom keeps what the relay actually said', () => {
    const at = new Date();
    const receipt = mailer.receiptFrom({
        messageId: '<abc@stockportfolio.pro>',
        accepted: ['a@example.com'],
        rejected: [],
        response: '250 2.0.0 Ok: queued as 4AB12',
        envelope: { from: 'support@stockportfolio.pro', to: ['a@example.com'] }
    }, at);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.messageId, '<abc@stockportfolio.pro>');
    assert.deepEqual(receipt.accepted, ['a@example.com']);
    assert.deepEqual(receipt.rejected, []);
    assert.equal(receipt.response, '250 2.0.0 Ok: queued as 4AB12');
    assert.equal(receipt.at, at);
});

test('receiptFrom tolerates a relay that reports nothing', () => {
    const receipt = mailer.receiptFrom(undefined);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.messageId, null);
    assert.deepEqual(receipt.accepted, []);
    assert.deepEqual(receipt.rejected, []);
    assert.equal(receipt.response, null);
});

test('sendMail returns the receipt and still returns false on failure', () => {
    const source = readBackend('mailer.js');
    // The success path must hand back the receipt, not a bare boolean.
    assert.match(source, /const info = await transporter\.sendMail\(\{[\s\S]*?\}\);\n\s*return receiptFrom\(info\);/,
        'sendMail must return receiptFrom(info) — a boolean cannot be audited later');
    // Every failure path stays false so the ~20 truthiness call sites hold.
    assert.match(source, /catch \(e\) \{\n\s*console\.error\('\[mailer\] send failed:'[\s\S]{0,80}?\n\s*return false;\n\s*\}/,
        'sendMail must still return false when the relay throws');
    assert.match(source, /if \(!transporter\)[^\n]*return false;/);
    assert.match(source, /if \(!to\) return false;/);
    // And it must pin the Message-ID itself, so the stored id is the one on the wire.
    assert.match(source, /const messageId = newMessageId\(\);/);
    assert.match(source, /replyTo: replyTo \|\| c\.support, messageId,/);
});

test('no call site compares a send result against a literal', () => {
    // The receipt is an object now. Anything using === true / === false would
    // silently invert; every caller must keep using truthiness.
    const files = ['app.js', 'mailer.js', 'outreach-mailer.js'];
    for (const file of files) {
        const source = readBackend(file);
        const strict = source.match(/(sendMail|sendOutreach|sendCustomerMessageEmail|sendPasswordResetEmail)\([^)]*\)\s*===?\s*(true|false)/g) || [];
        assert.deepEqual(strict, [], `${file} must not strict-compare a send result`);
    }
});

test('the broadcast schema stores the receipt beside the status', () => {
    const source = readBackend('app.js');
    for (const field of ['messageId', 'smtpResponse', 'accepted', 'rejected']) {
        assert.match(source, new RegExp(`${field}: \\{ type: (String|\\[String\\])`),
            `broadcast recipients must persist ${field}`);
    }
    // The status enum is the receipt's neighbour, not its container — widening it
    // would change what existing rows mean.
    assert.match(source, /enum: \['not_requested', 'pending', 'sent', 'suppressed', 'failed'\]/,
        'the emailStatus enum must stay as it is');
});

test('a broadcast whose recipient was rejected is recorded as failed', () => {
    const source = readBackend('app.js');
    assert.match(source, /const rejected = Array\.isArray\(receipt\.rejected\) \? receipt\.rejected : \[\];\n\s*return \{ status: rejected\.length \? 'failed' : 'sent', receipt \};/,
        'a resolved send with a rejected recipient is not a success');
});

test('broadcast history and detail routes exist behind the admin gate', () => {
    const source = readBackend('app.js');
    assert.match(source, /app\.get\('\/api\/admin\/messages\/broadcasts', authMiddleware, customerMessagesAdminOnly/,
        'the list route must be admin-gated like its siblings');
    assert.match(source, /app\.get\('\/api\/admin\/messages\/broadcasts\/:id', authMiddleware, customerMessagesAdminOnly/);
    for (const convention of [/res\.set\('Cache-Control', 'no-store'\)/, /hasMore: \(page \+ 1\) \* limit < total/, /console\.error\('\[messages\] broadcast history failed:'/]) {
        assert.match(source, convention, 'the new route must follow the customers-route conventions');
    }
    assert.match(source, /withReceipt: sent\.filter\(\(recipient\) => recipient\.messageId\)\.length/,
        'the list must report how many recipients carry a receipt');
});

test('the receipts panel is read-only and lazily loaded', () => {
    const source = readFrontend('assets/admin-messages.js');
    const html = readFrontend('admin-messages.html');
    assert.match(source, /async function loadReceipts\(reset\)/);
    assert.match(source, /receiptsPanel\.addEventListener\('toggle'/,
        'history should load when the panel is opened, not on every page view');
    // No writer may live in this block — the panel observes sends, never causes one.
    const block = source.slice(source.indexOf('// Delivery history. Read-only'));
    assert.doesNotMatch(block, /method: 'POST'|method: 'DELETE'|method: 'PATCH'/,
        'the receipts panel must not send anything');
    assert.match(html, /id="receipts-list"/);
    assert.match(source, /no receipt \(sent before receipts existed\)/,
        'an absent receipt on an older send must be explained in the UI');
});

test('the receipts bundle still carries exactly one reply-form listener', () => {
    // The panel was edited into the same file that once shipped a duplicate
    // submit listener; keep the guard that caught it.
    const source = readFrontend('assets/admin-messages.js');
    const bound = source.matchAll(/\$\('admin-reply-form'\)\.addEventListener\('submit'/g);
    assert.equal([...bound].length, 1);
});

test('cold outreach logs its receipt with the send', () => {
    const source = readBackend('outreach-mailer.js');
    assert.match(source, /const messageId = `<[^`]*randomUUID\(\)[^`]*>`;/);
    assert.match(source, /\$set: \{ campaign, email: address, at: new Date\(\), \.\.\.receipt \}/,
        'the receipt must be persisted, not only returned');
    assert.match(source, /return \{ sent: true, receipt \};/);
});
