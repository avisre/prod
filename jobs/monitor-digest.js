#!/usr/bin/env node
'use strict';

// Pre-rendered Monitor digest.
//
// For every user with active Monitor access, find filing changes on the
// companies they track, render them through lib/output-delivery.js, and place a
// complete, addressed, ready-to-send email in prepared_emails. Rendering
// happens ahead of time so the send itself is a dumb, fast, retryable step —
// and so a person can read the exact email before anyone receives it.
//
// This job NEVER sends. There is no SMTP import here and no send call.
//
// Two properties it has to get right:
//
//  * One-click unsubscribe that works with no login. Every prepared email
//    carries a signed unsubscribe URL and the RFC 8058 List-Unsubscribe /
//    List-Unsubscribe-Post headers in its meta, ready for the sender to attach.
//  * Idempotency. A filing change is claimed in digest_deliveries by
//    (user, symbol, accession) before it is written into an email, so the same
//    filing is never queued to the same person twice — including across two
//    overlapping runs.

const path = require('node:path');
const crypto = require('node:crypto');
const BACKEND = path.join(__dirname, '..', 'backend');
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
const outputDelivery = require(path.join(__dirname, '..', 'lib', 'output-delivery'));
const digestDelivery = require(path.join(__dirname, '..', 'lib', 'digest-delivery'));
const { queueEmail } = require(path.join(__dirname, '..', 'lib', 'prepared-email'));
const tierLimits = require(path.join(__dirname, '..', 'lib', 'tier-limits'));

const MONITOR_PLANS = ['power', 'power-monthly', 'desk', 'enterprise'];
const ACTIVE = ['active', 'trialing', 'cancel_at_period_end'];
const MAX_USERS = 200;
const MAX_SYMBOLS = 40;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function appUrl() {
    return String(process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
}

// Same token shape and purpose claim as app.js's digestUnsubToken, so the link
// in a prepared email is honoured by the live GET and POST routes.
function unsubscribe(userId, secret) {
    const url = `${appUrl()}/api/digest/unsubscribe?token=${jwt.sign({ userId: String(userId), p: 'digest' }, secret, { expiresIn: '180d' })}`;
    return {
        url,
        headers: {
            'List-Unsubscribe': `<${url}>, <mailto:${process.env.SUPPORT_EMAIL || 'support@stockportfolio.pro'}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
    };
}

// Anyone whose Monitor access is live right now: a paid Monitor plan, a
// lifetime purchase, or an unexpired pre-grant. Opt-outs are excluded at the
// query, not after rendering.
//
// Lifetime buyers are included because the digest is the only thing in the
// product that reaches out on its own. Without it a lifetime buyer has no
// recurring reason to return, which is what the usage data showed: a median of
// one AI call per buyer and then nothing. Their coverage is capped per tier by
// tierLimits.capSymbols below; Power/Desk stay uncapped.
async function monitorUsers(db) {
    return db.collection('users').find({
        digestOptOut: { $ne: true },
        $or: [
            { 'subscription.planId': { $in: MONITOR_PLANS }, 'subscription.status': { $in: ACTIVE } },
            { appsumoRedeemedAt: { $ne: null } },
            { dealMirrorRedeemedAt: { $ne: null } },
            { trialGrant: { $elemMatch: { feature: 'monitor', expiresAt: { $gt: new Date() }, revokedAt: null } } }
        ]
    }, { projection: {
        email: 1, name: 1, subscription: 1, trialGrant: 1,
        appsumoRedeemedAt: 1, appsumoTier: 1, dealMirrorRedeemedAt: 1, dealMirrorTier: 1
    } }).limit(MAX_USERS).toArray();
}

// The companies this user actually asked the Monitor to watch.
async function trackedSymbols(db, userId, user) {
    const [rules, watchlist, holdings] = await Promise.all([
        db.collection('alertrules').find({ user: userId }, { projection: { symbol: 1 } }).limit(60).toArray(),
        db.collection('watchlists').findOne({ user: userId }, { projection: { symbols: 1 } }),
        db.collection('stocks').find({ user: userId, assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } }, { projection: { symbol: 1 } }).limit(60).toArray()
    ]);
    // capSymbols trims a lifetime buyer to their tier's company count and is a
    // no-op for everyone else; MAX_SYMBOLS still bounds the email for all.
    return tierLimits.capSymbols(user, outputDelivery.normalizeSymbols([
        ...rules.map((r) => r.symbol),
        ...((watchlist && watchlist.symbols) || []),
        ...holdings.map((h) => h.symbol)
    ])).slice(0, MAX_SYMBOLS);
}

function renderDigest(user, block, unsub) {
    const first = String(user.name || '').trim().split(/\s+/)[0] || 'there';
    const n = block.count;
    const subject = n === 1
        ? `${block.sections[0].symbol} just filed — what changed`
        : `${n} of the companies you track filed — what changed`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a">
      <h1 style="font-size:20px;margin:0 0 6px">What changed in the companies you track</h1>
      <p style="font-size:14px;color:#64748b;margin:0 0 20px">Hi ${esc(first)} — ${n} compan${n === 1 ? 'y' : 'ies'} filed, read for you, every figure taken from the filing.</p>
      ${block.html}
      <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin-top:24px;border-top:1px solid #e8e6e0;padding-top:12px">
        You're receiving this because the Filing Change Monitor is active on your account. Educational, not investment advice.<br/>
        <a href="${esc(unsub.url)}" style="color:#94a3b8">Unsubscribe from these digests</a> — one click, no login needed.
      </p>
    </div>`;
    const text = `What changed in the companies you track\n\nHi ${first} — ${n} compan${n === 1 ? 'y' : 'ies'} filed.\n\n`
        + `${block.text}\n\n—\nEducational, not investment advice.\nUnsubscribe (one click, no login): ${unsub.url}`;
    return { subject, html, text };
}

async function prepareForUser(db, user, secret, { dryRun }) {
    const symbols = await trackedSymbols(db, user._id, user);
    if (!symbols.length) return { status: 'no-symbols' };

    // cachedOnly: a digest mails work already done. It must never fan out into
    // 40 fresh SEC downloads and model calls.
    const block = await outputDelivery.renderBlock(symbols, 'filing-diff', { cachedOnly: true, appUrl: appUrl() });

    // An item without an accession cannot be deduped, so it cannot be sent.
    const withKeys = block.sections.filter((s) => s.accession);
    if (!withKeys.length) return { status: 'nothing-keyable' };

    const pairs = withKeys.map((s) => ({ symbol: s.symbol, accession: s.accession }));
    const seen = await digestDelivery.alreadyDelivered(user._id, pairs);
    const fresh = withKeys.filter((s) => !seen.has(`${s.symbol}:${s.accession}`));
    if (!fresh.length) return { status: 'all-already-sent' };

    // Render from exactly the sections we kept, so the email body and the
    // delivery record can never disagree.
    const body = outputDelivery.renderSections(fresh, { appUrl: appUrl() });

    const unsub = unsubscribe(user._id, secret);
    const mail = renderDigest(user, body, unsub);
    const queueKey = `monitor-digest:${String(user._id)}:${crypto.createHash('sha256')
        .update(fresh.map((s) => `${s.symbol}:${s.accession}`).sort().join('|')).digest('hex').slice(0, 24)}`;

    if (dryRun) return { status: 'dry-run', symbols: fresh.map((s) => s.symbol), subject: mail.subject, queueKey };

    // Claim BEFORE queueing: if the queue write then fails we have skipped a
    // digest, which is recoverable. Queueing first and failing to claim would
    // risk sending the same filing twice, which is not.
    const claimed = await digestDelivery.claimDeliveries(user._id, fresh.map((s) => ({ symbol: s.symbol, accession: s.accession })), queueKey);
    if (!claimed.length) return { status: 'claimed-elsewhere' };

    const result = await queueEmail({
        queueKey,
        template: 'monitor_digest',
        userId: user._id,
        to: user.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        meta: {
            symbols: claimed.map((c) => c.symbol),
            filings: claimed,
            unsubscribeUrl: unsub.url,
            // The sender MUST attach these; one-click unsubscribe is a
            // compliance requirement, not a nicety.
            headers: unsub.headers
        }
    });
    return { status: result, symbols: claimed.map((c) => c.symbol) };
}

async function runMonitorDigest({ dryRun = false } = {}) {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    const secret = process.env.JWT_SECRET;
    if (!secret) return { skipped: 'no JWT_SECRET — unsubscribe links would not verify' };
    const db = mongoose.connection.db;
    const users = await monitorUsers(db);
    const tally = { eligible: users.length, queued: 0, duplicates: 0, skipped: 0, failed: 0, dryRun: 0 };
    for (const user of users) {
        try {
            const r = await prepareForUser(db, user, secret, { dryRun });
            if (r.status === 'queued') tally.queued += 1;
            else if (r.status === 'duplicate') tally.duplicates += 1;
            else if (r.status === 'dry-run') { tally.dryRun += 1; console.log(JSON.stringify(r)); }
            else tally.skipped += 1;
        } catch (error) {
            tally.failed += 1;
            console.warn(`[monitor-digest] prepare failed for ${user.email}: ${error.message}`);
        }
    }
    return tally;
}

module.exports = { runMonitorDigest, prepareForUser, renderDigest, unsubscribe, trackedSymbols };

if (require.main === module) {
    require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
    require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
    (async () => {
        if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
        console.log(JSON.stringify(await runMonitorDigest({ dryRun: process.argv.includes('--dry-run') }), null, 2));
        await mongoose.disconnect();
    })().catch(async (error) => {
        console.error(error && error.message || error);
        try { await mongoose.disconnect(); } catch (_) { /* already down */ }
        process.exit(1);
    });
}
