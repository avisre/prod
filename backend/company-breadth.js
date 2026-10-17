'use strict';

// Anti-scraping for the connectors (/mcp, /mcp/apps) and the REST API (/api/v1):
// how many DIFFERENT companies one account may pull data for. Credits and the
// per-minute rate limit bound how many calls an account makes; neither stops a
// funded account from walking the whole universe slowly. Real use is narrow:
// measured on production 2026-09-11..10-16 (375 metered calls, 22 account-days)
// the median account touched 2 companies a day, p90 7, the heaviest day 12. The
// caps below sit far above that and put a full ~5,800-company pull years away.
//
// One document per (account, company), stamped with when it was last asked
// about. A company already asked about inside the window never counts again,
// so going back to the same names all day is free of this limit.
//
// The check runs before the work and the record after it succeeds, so a typo
// or an unknown ticker does not use a slot. Two calls racing past the check can
// overshoot by the few calls in flight; the per-minute limit bounds that. A
// database failure lets the call through: this guard must never take the
// connector down for a paying customer.

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const DEFAULT_DAY_LIMIT = 50;
const DEFAULT_MONTH_LIMIT = 250;
const MAX_PER_CALL = 10;
const KEY_MAX = 40;

function limits(env = process.env) {
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
    return {
        day: num(env.CONNECTOR_DAILY_COMPANIES, DEFAULT_DAY_LIMIT),
        month: num(env.CONNECTOR_MONTHLY_COMPANIES, DEFAULT_MONTH_LIMIT)
    };
}

function key(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toUpperCase().slice(0, KEY_MAX);
}

// The companies a call is about: a ticker, a company name, or a short list of
// either (an array, or the REST API's comma-separated `tickers`). A call about
// no company (a name search, an accession-only filing read) returns [].
function companiesIn(args) {
    const a = args && typeof args === 'object' ? args : {};
    const out = [];
    for (const v of [a.ticker, a.symbol, a.company]) if (typeof v === 'string') out.push(v);
    for (const v of [a.companies, a.tickers]) {
        if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string'));
        else if (typeof v === 'string') out.push(...v.split(','));
    }
    return [...new Set(out.map(key).filter(Boolean))].slice(0, MAX_PER_CALL);
}

const indexed = new WeakSet();
function ensureIndexes(col) {
    if (indexed.has(col)) return;
    indexed.add(col);
    // A company not asked about for 30 days drops out of every window, so the
    // collection holds at most the monthly cap per account.
    Promise.all([
        col.createIndex({ lastAt: 1 }, { expireAfterSeconds: Math.ceil(MONTH_MS / 1000) + 3600 }),
        col.createIndex({ userId: 1, lastAt: 1 })
    ]).catch(() => { indexed.delete(col); });
}

function refusal(window, limit, resetsAt) {
    const span = window === 'day' ? 'the last 24 hours' : 'the last 30 days';
    const when = resetsAt ? ` A new company can be added from ${resetsAt.toISOString()}.` : '';
    return {
        ok: false,
        code: 'COMPANY_LIMIT',
        window,
        limit,
        resetsAt: resetsAt ? resetsAt.toISOString() : null,
        message: `This account has looked up ${limit} different companies in ${span}, the most allowed. Companies already looked up in that time still work.${when}`
    };
}

function forAccount(col, userId, { env = process.env, now = () => new Date() } = {}) {
    const cap = limits(env);
    const uid = String(userId);

    async function check(companies) {
        const keys = Array.isArray(companies) ? companies : [];
        if (!keys.length) return { ok: true };
        try {
            ensureIndexes(col);
            const t = now().getTime();
            const dayStart = new Date(t - DAY_MS);
            const monthStart = new Date(t - MONTH_MS);
            const seen = await col.find({ userId: uid, key: { $in: keys }, lastAt: { $gte: monthStart } }, { projection: { _id: 0, key: 1, lastAt: 1 } }).toArray();
            const lastAt = new Map(seen.map((d) => [d.key, new Date(d.lastAt).getTime()]));
            const newThisMonth = keys.filter((k) => !lastAt.has(k)).length;
            const newToday = keys.filter((k) => !(lastAt.get(k) >= dayStart.getTime())).length;
            if (newToday) {
                const today = await col.countDocuments({ userId: uid, lastAt: { $gte: dayStart } });
                if (today + newToday > cap.day) {
                    const oldest = await col.find({ userId: uid, lastAt: { $gte: dayStart } }).sort({ lastAt: 1 }).limit(1).toArray();
                    return refusal('day', cap.day, oldest[0] ? new Date(new Date(oldest[0].lastAt).getTime() + DAY_MS) : null);
                }
            }
            if (newThisMonth) {
                const month = await col.countDocuments({ userId: uid, lastAt: { $gte: monthStart } });
                if (month + newThisMonth > cap.month) {
                    const oldest = await col.find({ userId: uid, lastAt: { $gte: monthStart } }).sort({ lastAt: 1 }).limit(1).toArray();
                    return refusal('month', cap.month, oldest[0] ? new Date(new Date(oldest[0].lastAt).getTime() + MONTH_MS) : null);
                }
            }
            return { ok: true };
        } catch (err) {
            try { console.error('[company-breadth] check failed, allowing:', err && err.message); } catch (_) { /* ignore */ }
            return { ok: true };
        }
    }

    async function record(companies) {
        const keys = Array.isArray(companies) ? companies : [];
        if (!keys.length) return;
        try {
            const at = now();
            await col.bulkWrite(keys.map((k) => ({
                updateOne: { filter: { _id: `${uid}|${k}` }, update: { $set: { userId: uid, key: k, lastAt: at } }, upsert: true }
            })), { ordered: false });
        } catch (err) {
            try { console.error('[company-breadth] record failed:', err && err.message); } catch (_) { /* ignore */ }
        }
    }

    return { check, record };
}

module.exports = { companiesIn, forAccount, limits, DEFAULT_DAY_LIMIT, DEFAULT_MONTH_LIMIT, MAX_PER_CALL };
