'use strict';

// Cold-outreach sending identity — deliberately SEPARATE from mailer.js.
//
// WHY A SECOND MODULE RATHER THAN A FLAG ON THE FIRST
// mailer.js::isMailerConfigured() refuses to send unless SMTP_USER is exactly
// support@stockportfolio.pro, because that mailbox's reputation carries
// password resets, receipts, trial mail and the AppSumo lifecycle. Cold mail to
// strangers is the single fastest way to damage a sending reputation: a few
// spam complaints or one spam-trap address and transactional mail stops
// reaching inboxes. Putting cold outreach on its own credential and its own
// (sub)domain means a bad list can never cost a paying customer their receipt.
// That separation is the whole point; do not "simplify" this by pointing it at
// SMTP_USER.
//
// COMPLIANCE IS NOT OPTIONAL HERE
// Logged-in users have opt-out flags on their User document, but a cold
// prospect has no account, so there was nowhere to record "stop emailing me".
// This module therefore:
//   1. refuses to send to any address in the `outreach_suppression` collection,
//   2. refuses to send at all unless a List-Unsubscribe header can be built,
//   3. records every send, so a second run cannot re-mail the same person.
// CAN-SPAM requires a working opt-out; GDPR/PECR expect one too. An outreach
// path without these is not a shortcut, it is a liability.

const crypto = require('crypto');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const SUPPORT_EMAIL = 'support@stockportfolio.pro';

function config(env = process.env) {
    return {
        host: env.OUTREACH_SMTP_HOST || '',
        port: parseInt(env.OUTREACH_SMTP_PORT || '465', 10),
        secure: String(env.OUTREACH_SMTP_SECURE || 'true') === 'true',
        user: (env.OUTREACH_SMTP_USER || '').trim(),
        pass: env.OUTREACH_SMTP_PASS || '',
        fromName: env.OUTREACH_FROM_NAME || 'Avinash Sreekumar',
        appUrl: (env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '')
    };
}

/**
 * Configured only when a DISTINCT mailbox is supplied. Pointing this at the
 * support mailbox is refused rather than allowed-with-a-warning: the entire
 * reason this module exists is to keep the two reputations apart, and a
 * misconfiguration that silently reunited them would be invisible until
 * customer mail started bouncing.
 */
function isConfigured(env = process.env) {
    const c = config(env);
    if (!c.host || !c.user || !c.pass) return false;
    if (c.user.toLowerCase() === SUPPORT_EMAIL) return false;
    return true;
}

function configError(env = process.env) {
    const c = config(env);
    if (!c.host) return 'OUTREACH_SMTP_HOST is not set';
    if (!c.user) return 'OUTREACH_SMTP_USER is not set';
    if (!c.pass) return 'OUTREACH_SMTP_PASS is not set';
    if (c.user.toLowerCase() === SUPPORT_EMAIL) {
        return `OUTREACH_SMTP_USER must NOT be ${SUPPORT_EMAIL} — cold mail on the support mailbox risks the deliverability of receipts and password resets`;
    }
    return null;
}

let _transporter = null;
function getTransporter(env = process.env) {
    if (!isConfigured(env)) return null;
    if (_transporter) return _transporter;
    const c = config(env);
    _transporter = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure,
        auth: { user: c.user, pass: c.pass }
    });
    return _transporter;
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// Addresses are stored hashed as well as plain: the plain form is needed to
// actually suppress a send, but the hash lets a suppression be checked or
// exported without passing raw addresses around.
function emailHash(value) {
    return crypto.createHash('sha256').update(normalizeEmail(value)).digest('hex');
}

function suppressionCol() { return mongoose.connection.collection('outreach_suppression'); }
function sendLogCol() { return mongoose.connection.collection('outreach_sends'); }

/** Records a do-not-contact. Idempotent on the address. */
async function suppress(email, reason = 'unsubscribe') {
    const address = normalizeEmail(email);
    if (!address) return false;
    await suppressionCol().updateOne(
        { _id: emailHash(address) },
        { $set: { email: address, reason, at: new Date() } },
        { upsert: true }
    );
    return true;
}

async function isSuppressed(email) {
    const address = normalizeEmail(email);
    if (!address) return true;                       // no address = do not send
    if (mongoose.connection.readyState !== 1) return true;  // fail CLOSED
    return Boolean(await suppressionCol().findOne({ _id: emailHash(address) }));
}

/** True if this address has already been sent this campaign. */
async function alreadySent(email, campaign) {
    if (mongoose.connection.readyState !== 1) return true;  // fail CLOSED
    return Boolean(await sendLogCol().findOne({ _id: `${campaign}:${emailHash(email)}` }));
}

/**
 * Signed, long-lived unsubscribe token. Carries the ADDRESS rather than a user
 * id, because a cold prospect has no account — that is exactly the gap this
 * closes.
 */
function unsubToken(email, secret) {
    const address = normalizeEmail(email);
    const payload = Buffer.from(JSON.stringify({ e: address, p: 'outreach' })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyUnsubToken(token, secret) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data && data.p === 'outreach' && data.e ? data.e : null;
    } catch (_) { return null; }
}

function unsubHeaders(email, secret, env = process.env) {
    const c = config(env);
    const url = `${c.appUrl}/api/outreach/unsubscribe?token=${unsubToken(email, secret)}`;
    return {
        url,
        headers: {
            'List-Unsubscribe': `<${url}>, <mailto:${c.user}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
    };
}

/**
 * Sends one cold email. Every guard fails CLOSED — an unreachable database,
 * a missing secret or an unconfigured mailbox all mean "do not send", never
 * "send without the safety net".
 *
 * Returns { sent: boolean, reason?: string }.
 */
async function sendOutreach({ to, subject, text, html, campaign, secret, env = process.env } = {}) {
    const address = normalizeEmail(to);
    if (!address) return { sent: false, reason: 'no recipient' };
    if (!campaign) return { sent: false, reason: 'no campaign id (needed for the send log)' };
    if (!secret) return { sent: false, reason: 'no signing secret — cannot build an unsubscribe link' };

    const err = configError(env);
    if (err) return { sent: false, reason: err };

    if (await isSuppressed(address)) return { sent: false, reason: 'suppressed or unreachable database' };
    if (await alreadySent(address, campaign)) return { sent: false, reason: 'already sent this campaign' };

    const transporter = getTransporter(env);
    if (!transporter) return { sent: false, reason: 'no transport' };

    const c = config(env);
    const unsub = unsubHeaders(address, secret, env);
    // The link goes in the body too. The header alone is invisible to a human
    // reading the mail, and a cold recipient who cannot find how to stop it is
    // the one who clicks "spam" instead — which is what actually costs the
    // sending domain.
    const textWithUnsub = `${text}\n\n---\nNot interested? Unsubscribe and I won't contact you again: ${unsub.url}`;
    const htmlWithUnsub = html
        ? `${html}<p style="font-size:12px;color:#64748b;margin-top:22px">Not interested? <a href="${unsub.url}">Unsubscribe</a> and I won't contact you again.</p>`
        : undefined;

    try {
        await transporter.sendMail({
            from: `${c.fromName} <${c.user}>`,
            to: address,
            subject,
            text: textWithUnsub,
            html: htmlWithUnsub,
            replyTo: c.user,
            headers: unsub.headers
        });
    } catch (e) {
        return { sent: false, reason: `send failed: ${e && e.message}` };
    }

    await sendLogCol().updateOne(
        { _id: `${campaign}:${emailHash(address)}` },
        { $set: { campaign, email: address, at: new Date() } },
        { upsert: true }
    ).catch(() => {});
    return { sent: true };
}

module.exports = {
    config, isConfigured, configError,
    suppress, isSuppressed, alreadySent,
    unsubToken, verifyUnsubToken, unsubHeaders,
    sendOutreach, normalizeEmail, emailHash,
    SUPPORT_EMAIL
};
