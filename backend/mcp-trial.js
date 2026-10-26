'use strict';

// Per-account 30-day MCP trial for signed-in accounts WITHOUT API/MCP access
// (owner decision 2026-10-26).
//
// WHY THIS EXISTS: until 2026-10-26 the connector had two ways in — a paid
// plan, or a keyless allowance metered by visitor IP (mcp-anon.js). The IP
// tier had no identity, refilled forever, and was shared by everyone behind
// one egress address; and a signed-in FREE account got nothing at all: every
// tool call was refused with ENTITLEMENT_REQUIRED before the person had used
// the product once. The trial replaces both halves: keyless access is off by
// default now (mcp-anon.js), and a signed-in free account instead gets one
// 30-day trial, keyed to the userId, that NEVER rolls over.
//
// The shape deliberately mirrors mcp-anon.js (check() RESERVES atomically,
// spend() CONFIRMS, release() gives an unused reservation back on every
// refusal path), so mcp-endpoint.js and mcp-apps.js run their existing
// reservation flow unmodified through the `limiter` slot. The differences:
//   - identity is the userId, not an IP: one trial per account, forever;
//   - the window NEVER rolls: once now >= startedAt + days, check() refuses
//     with reason 'trial_ended' permanently — there is no roll-back update;
//   - startedAt is set by $setOnInsert at the FIRST reserved call, so the 30
//     days start at the account's first MCP tool call, not at signup.
//
// AI answers still reserve on mcp-anon's global UTC-day doc (the
// ANON_MCP_GLOBAL_ASK_DAY ceiling): the trial and anything keyless share one
// 100/day ceiling, which is the real cost bound on an endpoint anyone can
// call. The day-key helper and the collection are reused from mcp-anon rather
// than duplicated, so the two meterings can never drift onto different docs.

const mongoose = require('mongoose');
const mcpAnon = require('./mcp-anon');

const COLLECTION = 'mcp_trial_usage';

function config(env = process.env) {
    const num = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        // One trial per account: 30 days from the first reserved call.
        days: num(env.MCP_TRIAL_DAYS, 30),
        // What the trial includes: enough deterministic lookups to judge the
        // data, and a handful of AI answers, which are the only calls with a
        // real per-call cost.
        lookups: num(env.MCP_TRIAL_LOOKUPS, 25),
        asks: num(env.MCP_TRIAL_ASKS, 3),
        // The shared global AI-answer ceiling per UTC day, read from
        // mcp-anon's own knob so trial + keyless can never disagree about it.
        globalAskDay: mcpAnon.config(env).globalAskDay
    };
}

function collection() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.collection(COLLECTION);
}

// Same helper, same reason as mcp-anon.js: the one error the atomic
// reservation can produce that is not a failure — E11000 from the capped
// upsert means the filter matched nothing because the row exists, i.e. the
// caller is at the limit (or past the trial's end, disambiguated by a read).
function isDuplicateKey(err) {
    return Boolean(err) && (err.code === 11000 || err.codeName === 'DuplicateKey' || /E11000|duplicate key/i.test(String(err.message || '')));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function endsAtFor(startedAt, days) {
    const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
    return new Date(start.getTime() + days * DAY_MS);
}

function daysLeftFor(endsAt, now) {
    return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS));
}

// Where a trial caller continues once the trial is over or used up. The /mcp
// surface may name the plan and the price (mcp-apps.js keeps its own,
// commerce-neutral copy and reads none of this).
const UPGRADE_URL = 'https://www.stockportfolio.pro/upgrade.html?utm_source=connector&utm_campaign=trial';

function plural(n, word) {
    return `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
}

// Only accounts created on the connector's sign-in screen carry the flag
// (oauth-signup.js sets it, nothing else does). Website signups and older
// plan-less accounts stay on ENTITLEMENT_REQUIRED.
function eligible(user) {
    return Boolean(user && user.mcpTrial && user.mcpTrial.eligible === true);
}

function longDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function trialContinueCopy(lookupCost, askCost) {
    return `To continue, subscribe to the Monthly plan ($79.99/month, cancel anytime) at ${UPGRADE_URL} — it includes this connector with 200 credits a month (a data lookup costs ${lookupCost} credits, an AI answer ${askCost}) and the full StockPortfolio.pro website. This connection picks the new plan up on the next call; there is nothing to reconnect.`;
}

/**
 * Builds a credits-shaped facade bound to one account (the userId), with the
 * same check/spend/release surface as credits.js and mcp-anon.js so the MCP
 * tool layers need no trial-specific branch.
 */
function creditsFor(userId, env = process.env, opts = {}) {
    const cfg = config(env);
    const rowId = String(userId);
    const listedLookup = Number(opts.lookupCost) > 0 ? Number(opts.lookupCost) : 2;
    const listedAsk = Number(opts.askCost) > 0 ? Number(opts.askCost) : 42;

    const refuse = async (reason, now = new Date()) => {
        // Counts read after the fact for the message only — the decision was
        // the atomic write (or the ended check, which reads no counter).
        const col = collection();
        const doc = col ? await col.findOne({ _id: rowId }).catch(() => null) : null;
        const startedAt = doc && doc.startedAt ? new Date(doc.startedAt) : null;
        const endsAt = startedAt ? endsAtFor(startedAt, cfg.days) : null;
        const isAsk = reason === 'ask_limit';
        const limit = isAsk ? cfg.asks : cfg.lookups;
        const used = isAsk ? Number((doc && doc.asks) || 0) : Number((doc && doc.lookups) || 0);
        let message;
        if (reason === 'trial_ended') {
            message = `The ${cfg.days}-day free trial for this StockPortfolio connector has ended; it does not renew. ${trialContinueCopy(listedLookup, listedAsk)}`;
        } else if (reason === 'global_ask_day') {
            message = `Today's shared limit for free AI answers has been reached. Try again after 00:00 UTC, or continue now: ${trialContinueCopy(listedLookup, listedAsk)}`;
        } else {
            message = `That was all ${plural(limit, isAsk ? 'free AI answer' : 'free data lookup')} in the ${cfg.days}-day free trial, which does not renew. ${trialContinueCopy(listedLookup, listedAsk)}`;
        }
        return { ok: false, reason, used, allowance: limit, endsAt: endsAt ? endsAt.toISOString() : null, message };
    };

    // One facade serves one request; kept as a small stack exactly like
    // mcp-anon.js so a caller that checks twice before spending cannot lose a
    // slot.
    const outstanding = [];
    const takeOutstanding = (costKey) => {
        const ask = costKey === 'mcp_ask';
        for (let i = outstanding.length - 1; i >= 0; i--) {
            if (!outstanding[i].consumed && outstanding[i].ask === ask) {
                const res = outstanding[i];
                res.consumed = true;
                outstanding.splice(i, 1);
                return res;
            }
        }
        return null;
    };

    return {
        // Reserves one unit of the trial atomically. The increment IS the
        // gate ({$lt: limit} filter + upsert, E11000 = full, exactly
        // mcp-anon's pattern), and startedAt comes from $setOnInsert so the
        // 30 days begin at the FIRST reserved call. The trial NEVER rolls
        // over: an expired startedAt fails the filter, and the lost upsert
        // race (E11000) is disambiguated into trial_ended by one read.
        async check(_userId, costKey) {
            const now = new Date();
            const col = collection();
            // Fail closed: a database blip must not hand out free use.
            if (!col) {
                return { ok: false, reason: 'unavailable', used: 0, allowance: 0, endsAt: null, message: 'Free trial access is temporarily unavailable. Try again shortly.' };
            }

            const isAsk = costKey === 'mcp_ask';
            const field = isAsk ? 'asks' : 'lookups';
            const limit = isAsk ? cfg.asks : cfg.lookups;
            // A zero limit closes that action entirely; the capped upsert
            // below cannot express it (a fresh row starts at 1).
            if (limit <= 0) return refuse(isAsk ? 'ask_limit' : 'lookup_limit', now);

            const cutoff = new Date(now.getTime() - cfg.days * DAY_MS);
            let doc;
            try {
                doc = await col.findOneAndUpdate(
                    {
                        _id: rowId,
                        $and: [
                            // An ended trial must not reserve: the startedAt
                            // half of the filter is what makes the refusal
                            // permanent even under a racing read above.
                            { $or: [{ startedAt: { $exists: false } }, { startedAt: { $gt: cutoff } }] },
                            { $or: [{ [field]: { $lt: limit } }, { [field]: { $exists: false } }] }
                        ]
                    },
                    {
                        $inc: { [field]: 1 },
                        $set: { lastAt: now },
                        $setOnInsert: { startedAt: now, [isAsk ? 'lookups' : 'asks']: 0 }
                    },
                    { upsert: true, returnDocument: 'after' }
                );
            } catch (err) {
                if (!isDuplicateKey(err)) throw err;
                // The row exists: either at the limit or past its end. One
                // read decides which, so the caller reads the right refusal.
                const row = await col.findOne({ _id: rowId }).catch(() => null);
                if (row && row.startedAt && endsAtFor(row.startedAt, cfg.days).getTime() <= now.getTime()) {
                    return refuse('trial_ended', now);
                }
                return refuse(isAsk ? 'ask_limit' : 'lookup_limit', now);
            }

            // Asks carry the real cost, so they also reserve on the shared
            // global UTC-day doc (mcp-anon's), the ceiling that bounds trial
            // and keyless callers together. A spent day undoes the trial
            // reservation just made, so a refused call never burns the trial.
            const dayId = mcpAnon.dayKey(now);
            if (isAsk) {
                try {
                    await mongoose.connection.collection(mcpAnon.COLLECTION).findOneAndUpdate(
                        { _id: dayId, $or: [{ asks: { $lt: cfg.globalAskDay } }, { asks: { $exists: false } }] },
                        { $inc: { asks: 1 }, $set: { lastAt: now } },
                        { upsert: true, returnDocument: 'after' }
                    );
                } catch (err) {
                    if (!isDuplicateKey(err)) throw err;
                    await col.updateOne({ _id: rowId, [field]: { $gt: 0 } }, { $inc: { [field]: -1 } }).catch(() => {});
                    return refuse('global_ask_day', now);
                }
            }

            outstanding.push({ ask: isAsk, field, dayId: isAsk ? dayId : null, consumed: false });
            const startedAt = doc && doc.startedAt ? new Date(doc.startedAt) : now;
            const endsAt = endsAtFor(startedAt, cfg.days);
            const used = Math.max(0, Number((doc && doc[field]) || 1) - 1);
            return {
                ok: true,
                used,
                allowance: limit,
                endsAt: endsAt.toISOString(),
                daysLeft: daysLeftFor(endsAt, now),
                lookupsLeft: Math.max(0, cfg.lookups - Number((doc && doc.lookups) || 0)),
                asksLeft: Math.max(0, cfg.asks - Number((doc && doc.asks) || 0)),
                lookupsLimit: cfg.lookups,
                asksLimit: cfg.asks
            };
        },

        // Confirms the reservation check() made: the unit is already counted,
        // so this only marks it consumed and stamps lastAt. A call that never
        // reserved (a spend without a successful check) has nothing to confirm.
        async spend(_userId, costKey) {
            const res = takeOutstanding(costKey);
            if (!res) return;
            const col = collection();
            if (!col) return;
            try { await col.updateOne({ _id: rowId }, { $set: { lastAt: new Date() } }); } catch (_) { /* best-effort */ }
        },

        // Gives an unused reservation back. No-op when nothing is
        // outstanding or the reservation was already consumed by spend().
        // Callers invoke it on every path that returns after a successful
        // check without spending, so a wall/handler refusal never burns a
        // unit of the one-per-account trial.
        async release(_userId, costKey) {
            const res = takeOutstanding(costKey);
            if (!res) return;
            const col = collection();
            if (!col) return;
            try {
                const now = new Date();
                await col.updateOne(
                    { _id: rowId, [res.field]: { $gt: 0 } },
                    { $inc: { [res.field]: -1 }, $set: { lastAt: now } }
                );
                if (res.dayId) {
                    await mongoose.connection.collection(mcpAnon.COLLECTION)
                        .updateOne({ _id: res.dayId, asks: { $gt: 0 } }, { $inc: { asks: -1 } });
                }
            } catch (_) { /* a failed release must never mask the answer */ }
        }
    };
}

/**
 * Read-only trial status for the profile page, the connect display and the
 * trial emails. Never throws; an unreachable store reads as "not started".
 */
async function status(userId) {
    const cfg = config();
    const empty = {
        started: false, startedAt: null, endsAt: null, daysLeft: null,
        lookupsUsed: 0, asksUsed: 0, lookupsLeft: cfg.lookups, asksLeft: cfg.asks,
        lookupsLimit: cfg.lookups, asksLimit: cfg.asks, days: cfg.days, ended: false
    };
    const col = collection();
    if (!col) return empty;
    try {
        const doc = await col.findOne({ _id: String(userId) });
        if (!doc || !doc.startedAt) return empty;
        const startedAt = doc.startedAt instanceof Date ? doc.startedAt : new Date(doc.startedAt);
        const endsAt = endsAtFor(startedAt, cfg.days);
        const now = new Date();
        const ended = endsAt.getTime() <= now.getTime();
        const lookupsUsed = Number(doc.lookups || 0);
        const asksUsed = Number(doc.asks || 0);
        return {
            started: true,
            startedAt: startedAt.toISOString(),
            endsAt: endsAt.toISOString(),
            daysLeft: daysLeftFor(endsAt, now),
            lookupsUsed,
            asksUsed,
            lookupsLeft: Math.max(0, cfg.lookups - lookupsUsed),
            asksLeft: Math.max(0, cfg.asks - asksUsed),
            lookupsLimit: cfg.lookups,
            asksLimit: cfg.asks,
            days: cfg.days,
            ended
        };
    } catch (_) { return empty; }
}

// The short sentence a successful /mcp trial call attaches to its result, so
// the caller learns the limit exists before it is reached rather than from a
// refusal. /mcp/apps builds its own commerce-neutral sentence.
function usageNotice(gate) {
    if (!gate || !gate.ok) return null;
    const ends = longDate(gate.endsAt);
    const days = Number(gate.daysLeft) > 0 ? ` (${plural(gate.daysLeft, 'day')} left)` : '';
    return `Free trial: ${gate.lookupsLeft} of ${gate.lookupsLimit} lookups and ${gate.asksLeft} of ${gate.asksLimit} AI answers left; ends ${ends}${days}. `
        + 'After that this connector needs the Monthly plan ($79.99/month, 200 credits).';
}

module.exports = { COLLECTION, config, creditsFor, status, usageNotice, eligible, UPGRADE_URL };