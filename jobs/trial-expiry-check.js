#!/usr/bin/env node
'use strict';

// Daily Monitor pre-grant lifecycle sweep.
//
//   1. Grants expiring within 24h -> QUEUE (never send) the conversion email.
//      The email's argument is the user's own configured Monitor coverage,
//      rendered through lib/output-delivery.js — the actual companies they
//      chose to watch and what those companies last filed. Generic "your trial
//      is ending" copy asks the reader to remember why they signed up; this
//      shows them.
//   2. Grants that expired yesterday -> auto-revoke. Access itself already
//      stops at expiresAt (hasActiveTrialGrant reads the date), so this is the
//      tidy-up that makes the record honest. There is no silent extension path.
//
// Sending is deliberately not implemented here. Queued mail sits in
// prepared_emails until a human releases it.

const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
const outputDelivery = require(path.join(__dirname, '..', 'lib', 'output-delivery'));
const { queueEmail } = require(path.join(__dirname, '..', 'lib', 'prepared-email'));

const FEATURE = 'monitor';
const PRICE_COPY = '$579/yr';
const MAX_PROOF_SYMBOLS = 8;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function appUrl() {
    return String(process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
}

// Everything the user actually pointed the Monitor at: explicit alert rules
// first (the strongest signal of intent), then watchlist, then holdings.
async function configuredSymbols(db, userId) {
    const [rules, watchlist, holdings] = await Promise.all([
        db.collection('alertrules').find({ user: userId }, { projection: { symbol: 1 } }).limit(50).toArray(),
        db.collection('watchlists').findOne({ user: userId }, { projection: { symbols: 1 } }),
        db.collection('stocks').find({ user: userId, assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } }, { projection: { symbol: 1 } }).limit(50).toArray()
    ]);
    return {
        ruleCount: rules.length,
        symbols: outputDelivery.normalizeSymbols([
            ...rules.map((r) => r.symbol),
            ...((watchlist && watchlist.symbols) || []),
            ...holdings.map((h) => h.symbol)
        ]).slice(0, MAX_PROOF_SYMBOLS)
    };
}

function renderEmail(user, proof, block, expiresAt) {
    const base = appUrl();
    const first = esc(String(user.name || '').split(/\s+/)[0] || 'there');
    const when = new Date(expiresAt).toISOString().slice(0, 10);
    const built = proof.symbols.length
        ? `${proof.symbols.length} compan${proof.symbols.length === 1 ? 'y' : 'ies'} under watch${proof.ruleCount ? ` and ${proof.ruleCount} alert rule${proof.ruleCount === 1 ? '' : 's'}` : ''}`
        : 'your Monitor setup';
    const subject = `Your Filing Monitor trial ends ${when} — here's what you built`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a">
      <p style="font-size:15px;line-height:1.6">Hi ${first},</p>
      <p style="font-size:15px;line-height:1.6">Your Filing Change Monitor trial ends on ${esc(when)}. You've set up ${esc(built)}. This is what the Monitor is currently holding for you:</p>
      ${block.html || '<p style="font-size:14px;color:#64748b">Nothing has filed since you set it up — the Monitor is watching and will surface the next one.</p>'}
      <p style="font-size:15px;line-height:1.6;margin-top:22px">Keeping it is ${esc(PRICE_COPY)}. Nothing has been charged and nothing will be — if you do nothing, access simply stops on ${esc(when)}.</p>
      <p style="margin:20px 0"><a href="${base}/pricing" style="background:#201f1d;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block">Keep the Monitor — ${esc(PRICE_COPY)}</a></p>
      <p style="font-size:12px;color:#94a3b8;line-height:1.6;border-top:1px solid #e8e6e0;padding-top:12px">Educational, not investment advice.</p>
    </div>`;
    const text = `Hi ${String(user.name || '').split(/\s+/)[0] || 'there'},\n\n`
        + `Your Filing Change Monitor trial ends on ${when}. You've set up ${built}. This is what the Monitor is currently holding for you:\n\n`
        + `${block.text || 'Nothing has filed since you set it up — the Monitor is watching and will surface the next one.'}\n\n`
        + `Keeping it is ${PRICE_COPY}. Nothing has been charged and nothing will be — if you do nothing, access simply stops on ${when}.\n`
        + `${base}/pricing\n\n—\nEducational, not investment advice.`;
    return { subject, html, text };
}

// ---- 1. expiring within 24h -> queue the conversion email ----
async function queueExpiringSoon(db) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + 24 * 3600000);
    const users = await db.collection('users').find({
        trialGrant: { $elemMatch: { feature: FEATURE, expiresAt: { $gt: now, $lte: cutoff }, expiryEmailQueuedAt: null } }
    }, { projection: { email: 1, name: 1, trialGrant: 1 } }).limit(200).toArray();

    let queued = 0; let duplicates = 0;
    for (const user of users) {
        const grant = (user.trialGrant || []).find((g) => g && g.feature === FEATURE && !g.expiryEmailQueuedAt
            && g.expiresAt && new Date(g.expiresAt) > now && new Date(g.expiresAt) <= cutoff);
        if (!grant) continue;
        try {
            const proof = await configuredSymbols(db, user._id);
            const block = await outputDelivery.renderBlock(proof.symbols, 'filing-diff', { cachedOnly: true, appUrl: appUrl() });
            const mail = renderEmail(user, proof, block, grant.expiresAt);
            const result = await queueEmail({
                queueKey: `monitor-trial-expiring:${String(user._id)}:${new Date(grant.grantedAt || grant.expiresAt).toISOString()}`,
                template: 'monitor_trial_expiring',
                userId: user._id,
                to: user.email,
                subject: mail.subject,
                html: mail.html,
                text: mail.text,
                meta: { feature: FEATURE, expiresAt: grant.expiresAt, symbols: proof.symbols, ruleCount: proof.ruleCount, renderedSections: block.count }
            });
            if (result === 'duplicate') duplicates += 1; else queued += 1;
            // arrayFilters, not the positional `$` — `$` would match on whichever
            // trialGrant element satisfied the *first* clause, which is not
            // necessarily the grant we just rendered for.
            await db.collection('users').updateOne(
                { _id: user._id },
                { $set: { 'trialGrant.$[g].expiryEmailQueuedAt': new Date() } },
                { arrayFilters: [{ 'g.feature': FEATURE, 'g.expiresAt': grant.expiresAt }] }
            );
        } catch (error) {
            console.warn(`[trial-expiry] queue failed for ${user.email}: ${error.message}`);
        }
    }
    return { candidates: users.length, queued, duplicates };
}

// ---- 2. expired -> revoke, no silent extension ----
async function revokeExpired(db) {
    const cutoff = new Date(Date.now() - 24 * 3600000); // the day after expiry
    const res = await db.collection('users').updateMany(
        { trialGrant: { $elemMatch: { feature: FEATURE, expiresAt: { $lte: cutoff }, revokedAt: null } } },
        { $set: { 'trialGrant.$[g].revokedAt': new Date() } },
        { arrayFilters: [{ 'g.feature': FEATURE, 'g.expiresAt': { $lte: cutoff }, 'g.revokedAt': null }] }
    );
    return { revoked: res.modifiedCount };
}

async function runTrialExpiryCheck() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    const db = mongoose.connection.db;
    const expiring = await queueExpiringSoon(db);
    const revoked = await revokeExpired(db);
    return { ...expiring, ...revoked };
}

module.exports = { runTrialExpiryCheck, renderEmail, configuredSymbols };

if (require.main === module) {
    require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
    require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
    (async () => {
        if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
        console.log(JSON.stringify(await runTrialExpiryCheck()));
        await mongoose.disconnect();
    })().catch(async (error) => {
        console.error(error && error.message || error);
        try { await mongoose.disconnect(); } catch (_) { /* already down */ }
        process.exit(1);
    });
}
