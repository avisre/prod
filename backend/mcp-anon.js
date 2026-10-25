'use strict';

// Anonymous (keyless) metering for the hosted MCP endpoint.
//
// WHY THIS EXISTS: ChatGPT and Claude.ai are full MCP clients, but neither can
// send a static `Authorization: Bearer <key>` to a custom connector — ChatGPT
// requires OAuth 2.1 + Dynamic Client Registration, and claude.ai exposes only
// OAuth client id/secret fields. Both, however, explicitly support *authless*
// remote servers. So a keyless tier is not merely a growth idea: until the
// OAuth work lands it is the ONLY way a user of either product can reach this
// server at all.
//
// The shape deliberately mirrors the anonymous-Ask limiter already in app.js
// (ANON_ASK_LIMIT / ANON_ASK_IP_DAY / ANON_ASK_GLOBAL_DAY): a per-identity
// allowance, a per-identity backstop, and a hard global daily ceiling that
// bounds the cost of an endpoint anyone on the internet can call. Every knob is
// env-switchable and ANON_MCP_ASK_LIMIT=0 removes the tier entirely.
//
// This module exposes a `check`/`spend` surface shaped like credits.js, so
// mcp-endpoint.js's buildMcpServer() needs no anonymous-specific branch — the
// route injects this instead of credits.js through the existing `deps`
// parameter and every tool handler works unmodified.
//
// check() RESERVES atomically and spend() CONFIRMS. The first version of this
// facade read the counter, let the tool run, and only then $inc'd — so two
// concurrent calls both passed the same check and a 25-lookup identity reached
// 29 (measured 2026-10-20). Now check() itself increments under a
// `{$lt: limit}` filter (a lost race surfaces as E11000 from the upsert, which
// is exactly "the row exists and is full"), spend() only marks the reservation
// consumed, and release() gives an unused reservation back for every refusal
// path that returns without spending.

const mongoose = require('mongoose');

const COLLECTION = 'mcp_free_usage';

function config(env = process.env) {
    const num = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        // The headline offer: three keyless AI answers in each rolling window.
        // The answer payload reports how many remain and tells callers how to
        // subscribe and configure their MCP client before the allowance runs out.
        askLimit: num(env.ANON_MCP_ASK_LIMIT, 3),
        // Lookups hit cache/SEC/Yahoo with no model in the loop. 25 (was 50
        // until 2026-10-08, owner decision) is enough to judge the data; company
        // search counts against it like any other lookup.
        lookupLimit: num(env.ANON_MCP_LOOKUP_LIMIT, 25),
        // Hard ceiling across ALL anonymous callers per UTC day. This is the
        // real cost control; per-IP limits alone are worthless against a caller
        // with many egress addresses.
        //
        // Deliberately NOT the website's ANON_ASK_GLOBAL_DAY=400. That figure
        // guards a funnel where the visitor has already landed on the site; this
        // one guards an endpoint any agent on the internet can call with no
        // credential at all. The true unit cost is genuinely unknown — the
        // provider bill is not recorded anywhere, so AI margin is uncomputable
        // (growth.md §8) — and the only defensible response to an unknown cost
        // is a small number. Raise it once a month of real usage has produced
        // an actual bill to divide by; 100/day is a ceiling the business can
        // absorb being wrong about, and 400 is not.
        globalAskDay: num(env.ANON_MCP_GLOBAL_ASK_DAY, 100),
        // Per-identity allowances refill on this cadence rather than never, so a
        // genuine evaluator who returns next month is not permanently locked out.
        windowDays: num(env.ANON_MCP_WINDOW_DAYS, 30),
        // The shared pool for callers arriving from an AI platform's own egress
        // network (ai-platform-egress.js): every ChatGPT/Claude connector user
        // shares one address, so a per-IP allowance is one allowance for the
        // whole platform. Larger, and it resets every UTC day rather than
        // rolling for windowDays, so one busy afternoon cannot close the
        // door for a month.
        platform: {
            askLimit: num(env.ANON_MCP_PLATFORM_ASK_LIMIT, 10),
            lookupLimit: num(env.ANON_MCP_PLATFORM_LOOKUP_LIMIT, 100)
        }
    };
}

function enabled(env = process.env) {
    return config(env).askLimit > 0;
}

function dayKey(now = new Date()) {
    return `global:${now.toISOString().slice(0, 10)}`;
}

// The platform pool's window is the UTC day: it resets at the next 00:00 UTC.
function utcDayStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function nextUtcDayStart(now = new Date()) {
    return new Date(utcDayStart(now).getTime() + 24 * 60 * 60 * 1000);
}

function windowResetAt(windowStartedAt, windowDays) {
    const start = windowStartedAt instanceof Date ? windowStartedAt : new Date(windowStartedAt || Date.now());
    return new Date(start.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

function collection() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.collection(COLLECTION);
}

// The one error the atomic reservation can produce that is not a failure:
// a duplicate key (E11000) from the capped upsert means the filter matched
// nothing because the row already exists — i.e. the caller is at the limit.
function isDuplicateKey(err) {
    return Boolean(err) && (err.code === 11000 || err.codeName === 'DuplicateKey' || /E11000|duplicate key/i.test(String(err.message || '')));
}

// Reads the caller's row, rolling the window over when it has expired. Returns
// a plain shape even when Mongo is down — a database blip must not hand out
// unlimited free inference, so the unavailable case is treated as exhausted.
// Used only for the refusal copy now; the gate itself is the atomic write.
async function readUsage(identity, cfg, now = new Date()) {
    const col = collection();
    if (!col) return { available: false, asks: 0, lookups: 0, resetsAt: null };
    const doc = await col.findOne({ _id: identity });
    if (!doc) return { available: true, asks: 0, lookups: 0, windowStartedAt: null, resetsAt: null };
    const resetsAt = windowResetAt(doc.windowStartedAt, cfg.windowDays);
    if (resetsAt.getTime() <= now.getTime()) {
        return { available: true, asks: 0, lookups: 0, windowStartedAt: null, resetsAt: null, rolled: true };
    }
    return {
        available: true,
        asks: Number(doc.asks || 0),
        lookups: Number(doc.lookups || 0),
        windowStartedAt: doc.windowStartedAt || null,
        resetsAt
    };
}

async function readGlobalAsks(now = new Date()) {
    const col = collection();
    if (!col) return Number.POSITIVE_INFINITY;
    const doc = await col.findOne({ _id: dayKey(now) });
    return Number((doc && doc.asks) || 0);
}

// utm_source=connector: this link is only ever shown inside an assistant, so a
// signup carrying it came through a directory listing rather than the website.
//
// plan=monthly, not plan=dev (changed 2026-10-08): Monthly has included the
// connector since that morning, costs $79.99 against Dev's $200, and is the
// plan the first directory buyer chose unprompted. Sending a trial user to the
// dearer, API-only rung was asking for the larger commitment first.
const SIGNUP_URL = 'https://www.stockportfolio.pro/register?plan=monthly&utm_source=connector&utm_campaign=cap_hit';
const SETUP_URL = 'https://www.stockportfolio.pro/docs/api-mcp';

// The caller already has the connector installed — that is how they hit the
// cap. So the step after paying is "sign in on the connector you added", not
// the manual setup guide; SETUP_URL is kept for clients that take a bearer key.
function upgradeInstructions() {
    return `To keep going now, open ${SIGNUP_URL} and subscribe to the Monthly plan ($79.99/month, cancel anytime). It includes this connector with 100 credits a month (a data lookup costs 2 credits, an AI answer 42) and the full StockPortfolio.pro website; a top-up adds 150 credits for $14.99. After subscribing, reconnect this StockPortfolio connector in ChatGPT or Claude and sign in with the same account — nothing else to set up. Clients that use an API key instead: ${SETUP_URL}.`;
}

function askUsageNotice(used, allowance, windowDays = 30, pool = 'visitor') {
    const remaining = Math.max(0, Number(allowance || 0) - Number(used || 0));
    if (pool === 'platform') {
        // The caller shares this allowance with everyone connecting through
        // the same AI platform network, so the copy must say so — a "rolling
        // 30-day window" would be false and make the limit look arbitrary.
        if (remaining === 0) {
            return `Warning: you have used all ${allowance} free MCP questions in today's shared allowance. This allowance is shared by everyone connecting through this AI platform's network and resets at 00:00 UTC. ${upgradeInstructions()} Or wait for the allowance to renew.`;
        }
        if (remaining === 1) {
            return `Warning: only 1 free MCP question remains in today's shared allowance. This allowance is shared by everyone connecting through this AI platform's network and resets at 00:00 UTC. ${upgradeInstructions()}`;
        }
        return `Free MCP usage: ${used} of ${allowance} AI questions used; ${remaining} remain in today's shared allowance (shared across connections from this AI platform's network; resets at 00:00 UTC).`;
    }
    if (remaining === 0) {
        return `Warning: you have used all ${allowance} free MCP questions in this rolling ${windowDays}-day window. ${upgradeInstructions()} Or wait for the free allowance to renew.`;
    }
    if (remaining === 1) {
        return `Warning: only 1 free MCP question remains in this rolling ${windowDays}-day window. ${upgradeInstructions()}`;
    }
    return `Free MCP usage: ${used} of ${allowance} AI questions used; ${remaining} remain in this rolling ${windowDays}-day window.`;
}

/**
 * Builds a credits-shaped facade bound to one anonymous identity (the caller's
 * proxy-resolved IP). Signature-compatible with credits.js so the MCP server
 * itself stays identical for keyed and keyless callers.
 */
function creditsFor(identity, env = process.env, onCapHit = null, opts = {}) {
    const cfg = config(env);

    // Callers arriving from an AI platform's own egress network (Anthropic's
    // published range, OpenAI's published list — see ai-platform-egress.js)
    // share one pool for the whole platform, metered per UTC day and stored
    // under 'platform:' + identity so no existing per-visitor row is touched.
    // app.js passes { pool: 'platform' | 'visitor' } from the request's IP.
    const pool = opts.pool === 'platform' ? 'platform' : 'visitor';
    const rowId = pool === 'platform' ? `platform:${identity}` : identity;
    const askLimit = pool === 'platform' ? cfg.platform.askLimit : cfg.askLimit;
    const lookupLimit = pool === 'platform' ? cfg.platform.lookupLimit : cfg.lookupLimit;

    // Telemetry is injected rather than required here for the same reason the
    // whole facade exists: this module must not know about app.js. A throw from
    // the callback can never cost a caller their answer.
    const capHit = (reason, used, allowance) => {
        if (typeof onCapHit !== 'function') return;
        try { onCapHit({ reason, used, allowance, identity, pool }); } catch (_) { /* never break the call */ }
    };

    // One facade serves one request, so at most one reservation is outstanding
    // at a time. Kept as a small stack anyway (check() pushes, spend()/release()
    // consume from the top) so a caller that checks twice before spending
    // cannot lose the first slot.
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

    // When the caller's window resets: a rolling windowDays for a visitor,
    // the next 00:00 UTC for the shared platform pool.
    const resetsAtFor = (windowStartedAt, now) =>
        pool === 'platform' ? nextUtcDayStart(now) : windowResetAt(windowStartedAt, cfg.windowDays);

    // Builds the refusal the caller reads. The counts here are read after the
    // fact, for the message only — the decision itself was the atomic write.
    const refuse = async (reason, now) => {
        const usage = await readUsage(rowId, cfg, now).catch(() => ({ asks: 0, lookups: 0, resetsAt: null }));
        if (reason === 'global_ask_day') {
            const globalAsks = await readGlobalAsks(now).catch(() => Number.POSITIVE_INFINITY);
            capHit('global_ask_day', Number.isFinite(globalAsks) ? globalAsks : cfg.globalAskDay, cfg.globalAskDay);
            return {
                ok: false, used: usage.asks, allowance: askLimit, resetsAt: null, windowDays: cfg.windowDays, pool,
                message: `Free MCP questions have reached today's shared limit. Try again after 00:00 UTC, or get more reliable access: ${upgradeInstructions()}`
            };
        }
        const isAsk = reason === 'ask_limit';
        const limit = isAsk ? askLimit : lookupLimit;
        const used = isAsk ? usage.asks : usage.lookups;
        const resetsAt = pool === 'platform'
            ? nextUtcDayStart(now).toISOString().slice(0, 10)
            : (usage.resetsAt ? usage.resetsAt.toISOString().slice(0, 10) : null);
        capHit(reason, used, limit);
        const windowCopy = pool === 'platform'
            ? `This allowance is shared by everyone connecting through this AI platform's network and resets at 00:00 UTC.`
            : `in this rolling ${cfg.windowDays}-day window`;
        const message = pool === 'platform'
            ? `That was all ${limit} free ${isAsk ? 'questions' : 'data lookups'} in today's shared allowance. ${windowCopy} ${upgradeInstructions()} Or wait for the allowance to renew.`
            : `That was all ${limit} free ${isAsk ? 'questions' : 'data lookups'} ${windowCopy}. ${upgradeInstructions()} Or wait for the free allowance to renew.`
        return { ok: false, used, allowance: limit, windowDays: pool === 'platform' ? 1 : cfg.windowDays, resetsAt, pool, message };
    };

    return {
        // Reserves one unit of the caller's allowance atomically. The increment
        // IS the gate: it runs under a `{$lt: limit}` filter, so two concurrent
        // calls cannot both take the last slot, and a lost upsert race surfaces
        // as E11000 — the row exists, so it is full — rather than as two yeses.
        // `used` stays the count BEFORE this call, matching what callers print.
        async check(_userId, costKey, _allowance, _planId, _user) {
            const now = new Date();
            if (!enabled(env)) {
                return { ok: false, used: 0, allowance: 0, resetsAt: null, message: 'Keyless access is not available. Get a key at ' + SIGNUP_URL };
            }
            const col = collection();
            if (!col) {
                return { ok: false, used: 0, allowance: 0, resetsAt: null, message: 'Free access is temporarily unavailable. Try again shortly, or get a key at ' + SIGNUP_URL };
            }

            const isAsk = costKey === 'mcp_ask';
            const field = isAsk ? 'asks' : 'lookups';
            const limit = isAsk ? askLimit : lookupLimit;
            // A zero limit closes that action entirely, and the capped upsert
            // below cannot express it (a fresh row starts at 1), so refuse here.
            if (limit <= 0) return refuse(isAsk ? 'ask_limit' : 'lookup_limit', now);
            if (isAsk && cfg.globalAskDay <= 0) return refuse('global_ask_day', now);

            // Roll an expired window in place before reserving, so the reset
            // itself cannot race: the filter only matches rows past the cutoff.
            // A visitor rolls after windowDays; the platform pool rolls at
            // 00:00 UTC, so any window started before today is yesterday's.
            const cutoff = pool === 'platform'
                ? utcDayStart(now)
                : new Date(now.getTime() - cfg.windowDays * 24 * 60 * 60 * 1000);
            await col.updateOne(
                { _id: rowId, windowStartedAt: { $lt: cutoff } },
                { $set: { asks: 0, lookups: 0, windowStartedAt: now } }
            );

            let doc;
            try {
                // A row missing the counter (never written that way, but cheap
                // to allow) counts as zero rather than as full.
                doc = await col.findOneAndUpdate(
                    { _id: rowId, $or: [{ [field]: { $lt: limit } }, { [field]: { $exists: false } }] },
                    {
                        $inc: { [field]: 1 },
                        $set: { lastAt: now },
                        $setOnInsert: { windowStartedAt: now, [isAsk ? 'lookups' : 'asks']: 0 }
                    },
                    { upsert: true, returnDocument: 'after' }
                );
            } catch (err) {
                if (isDuplicateKey(err)) return refuse(isAsk ? 'ask_limit' : 'lookup_limit', now);
                throw err;
            }

            // Asks carry the real cost (a model call), so they also reserve on
            // the global UTC-day doc — the ceiling that bounds everyone. If the
            // day is already spent, the identity reservation just made is undone
            // so a refused call never burns the caller's own window.
            const dayId = dayKey(now);
            if (isAsk) {
                try {
                    await col.findOneAndUpdate(
                        { _id: dayId, $or: [{ asks: { $lt: cfg.globalAskDay } }, { asks: { $exists: false } }] },
                        { $inc: { asks: 1 }, $set: { lastAt: now } },
                        { upsert: true, returnDocument: 'after' }
                    );
                } catch (err) {
                    if (!isDuplicateKey(err)) throw err;
                    await col.updateOne(
                        { _id: rowId, [field]: { $gt: 0 } },
                        { $inc: { [field]: -1 } }
                    ).catch(() => {});
                    return refuse('global_ask_day', now);
                }
            }

            outstanding.push({ ask: isAsk, field, dayId: isAsk ? dayId : null, consumed: false });
            const used = Math.max(0, Number((doc && doc[field]) || 1) - 1);
            const resetsAt = resetsAtFor(doc && doc.windowStartedAt, now);
            return {
                ok: true, used, allowance: limit,
                resetsAt: resetsAt.toISOString().slice(0, 10),
                windowDays: pool === 'platform' ? 1 : cfg.windowDays,
                pool
            };
        },

        // Confirms the reservation check() made: the unit is already counted,
        // so this only marks it consumed and stamps lastAt. A call that never
        // reserved (a spend without a successful check) has nothing to confirm.
        async spend(_userId, costKey, _reason, _detail) {
            const res = takeOutstanding(costKey);
            if (!res) return;
            const col = collection();
            if (!col) return;
            try { await col.updateOne({ _id: rowId }, { $set: { lastAt: new Date() } }); } catch (_) { /* best-effort */ }
        },

        // Gives an unused reservation back. No-op when nothing is outstanding
        // or the reservation was already consumed by spend(). Callers invoke it
        // on every path that returns after a successful check without spending,
        // so a wall/breadth/handler refusal never costs a unit of the allowance.
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
                    await col.updateOne({ _id: res.dayId, asks: { $gt: 0 } }, { $inc: { asks: -1 } });
                }
            } catch (_) { /* a failed release must never mask the answer */ }
        }
    };
}

module.exports = { config, enabled, creditsFor, askUsageNotice, COLLECTION, SIGNUP_URL, SETUP_URL };
