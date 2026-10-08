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
// This module exposes the same `check`/`spend` surface as credits.js, so
// mcp-endpoint.js's buildMcpServer() needs no anonymous-specific branch — the
// route injects this instead of credits.js through the existing `deps`
// parameter and every tool handler works unmodified.

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
        windowDays: num(env.ANON_MCP_WINDOW_DAYS, 30)
    };
}

function enabled(env = process.env) {
    return config(env).askLimit > 0;
}

function dayKey(now = new Date()) {
    return `global:${now.toISOString().slice(0, 10)}`;
}

function windowResetAt(windowStartedAt, windowDays) {
    const start = windowStartedAt instanceof Date ? windowStartedAt : new Date(windowStartedAt || Date.now());
    return new Date(start.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

function collection() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.collection(COLLECTION);
}

// Reads the caller's row, rolling the window over when it has expired. Returns
// a plain shape even when Mongo is down — a database blip must not hand out
// unlimited free inference, so the unavailable case is treated as exhausted.
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
const SIGNUP_URL = 'https://www.stockportfolio.pro/register?plan=dev&utm_source=connector&utm_campaign=cap_hit';
const SETUP_URL = 'https://www.stockportfolio.pro/docs/api-mcp';

// The caller already has the connector installed — that is how they hit the
// cap. So the step after paying is "sign in on the connector you added", not
// the manual setup guide; SETUP_URL is kept for clients that take a bearer key.
function upgradeInstructions() {
    return `To get more MCP usage now, open ${SIGNUP_URL} and choose the Dev plan ($200/month for 200 credits; each AI question costs 42 credits). After subscribing, reconnect this StockPortfolio connector in ChatGPT or Claude and sign in with the same account — nothing else to set up. Clients that use an API key instead: ${SETUP_URL}.`;
}

function askUsageNotice(used, allowance, windowDays = 30) {
    const remaining = Math.max(0, Number(allowance || 0) - Number(used || 0));
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
function creditsFor(identity, env = process.env, onCapHit = null) {
    const cfg = config(env);

    // Telemetry is injected rather than required here for the same reason the
    // whole facade exists: this module must not know about app.js. A throw from
    // the callback can never cost a caller their answer.
    const capHit = (reason, used, allowance) => {
        if (typeof onCapHit !== 'function') return;
        try { onCapHit({ reason, used, allowance, identity }); } catch (_) { /* never break the call */ }
    };

    return {
        async check(_userId, costKey, _allowance, _planId, _user) {
            const now = new Date();
            if (!enabled(env)) {
                return { ok: false, used: 0, allowance: 0, resetsAt: null, message: 'Keyless access is not available. Get a key at ' + SIGNUP_URL };
            }
            const isAsk = costKey === 'mcp_ask';
            const usage = await readUsage(identity, cfg, now);
            if (!usage.available) {
                return { ok: false, used: 0, allowance: 0, resetsAt: null, message: 'Free access is temporarily unavailable. Try again shortly, or get a key at ' + SIGNUP_URL };
            }

            if (isAsk) {
                const globalAsks = await readGlobalAsks(now);
                if (globalAsks >= cfg.globalAskDay) {
                    capHit('global_ask_day', globalAsks, cfg.globalAskDay);
                    return {
                        ok: false, used: usage.asks, allowance: cfg.askLimit, resetsAt: null, windowDays: cfg.windowDays,
                        message: `Free MCP questions have reached today's shared limit. Try again after 00:00 UTC, or get more reliable access: ${upgradeInstructions()}`
                    };
                }
                if (usage.asks >= cfg.askLimit) {
                    capHit('ask_limit', usage.asks, cfg.askLimit);
                    return {
                        ok: false, used: usage.asks, allowance: cfg.askLimit, windowDays: cfg.windowDays,
                        resetsAt: usage.resetsAt ? usage.resetsAt.toISOString().slice(0, 10) : null,
                        message: `That was all ${cfg.askLimit} free questions in this rolling ${cfg.windowDays}-day window. ${upgradeInstructions()} Or wait for the free allowance to renew.`
                    };
                }
                const resetsAt = usage.resetsAt || windowResetAt(now, cfg.windowDays);
                return { ok: true, used: usage.asks, allowance: cfg.askLimit, resetsAt: resetsAt.toISOString().slice(0, 10), windowDays: cfg.windowDays };
            }

            if (usage.lookups >= cfg.lookupLimit) {
                capHit('lookup_limit', usage.lookups, cfg.lookupLimit);
                return {
                    ok: false, used: usage.lookups, allowance: cfg.lookupLimit, windowDays: cfg.windowDays,
                    resetsAt: usage.resetsAt ? usage.resetsAt.toISOString().slice(0, 10) : null,
                    message: `That was all ${cfg.lookupLimit} free data lookups in this rolling ${cfg.windowDays}-day window. ${upgradeInstructions()} Or wait for the free allowance to renew.`
                };
            }
            const resetsAt = usage.resetsAt || windowResetAt(now, cfg.windowDays);
            return { ok: true, used: usage.lookups, allowance: cfg.lookupLimit, resetsAt: resetsAt.toISOString().slice(0, 10), windowDays: cfg.windowDays };
        },

        // Recorded only after the work succeeded, matching credits.spend's
        // placement at each call site — a failed lookup must not burn a free call.
        async spend(_userId, costKey, _reason, _detail) {
            const col = collection();
            if (!col) return;
            const now = new Date();
            const isAsk = costKey === 'mcp_ask';
            const usage = await readUsage(identity, cfg, now);
            const inc = isAsk ? { asks: 1 } : { lookups: 1 };

            if (usage.rolled || !usage.windowStartedAt) {
                // Window rolled (or first ever call): reset both counters and
                // restart the clock, then apply this call on top.
                await col.updateOne(
                    { _id: identity },
                    {
                        $set: { asks: isAsk ? 1 : 0, lookups: isAsk ? 0 : 1, windowStartedAt: now, lastAt: now },
                    },
                    { upsert: true }
                );
            } else {
                await col.updateOne(
                    { _id: identity },
                    { $inc: inc, $set: { lastAt: now }, $setOnInsert: { windowStartedAt: now } },
                    { upsert: true }
                );
            }

            if (isAsk) {
                await col.updateOne({ _id: dayKey(now) }, { $inc: { asks: 1 }, $set: { lastAt: now } }, { upsert: true });
            }
        }
    };
}

module.exports = { config, enabled, creditsFor, askUsageNotice, COLLECTION, SIGNUP_URL, SETUP_URL };
