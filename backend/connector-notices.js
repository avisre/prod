'use strict';

// Account notices carried inside a successful connector result.
//
// Someone who uses StockPortfolio only through an assistant never sees the
// website and may not read our email, so the tool result is the one place a
// message is certain to arrive: the assistant reads it out in the conversation
// they are already having. Two notices, both derived from the credit ledger on
// every call, so nobody has to remember to send anything and every account
// gets them the same way:
//
//   credits added   credits reached the wallet (a refill, or credits we added)
//                   since this account's last connector call. Shown on the
//                   next successful call, which then becomes the "last call",
//                   so it is not repeated.
//   running low     this call took the wallet past LOW_BALANCE_AT of the
//                   month's allowance, or left only a few lookups in it.
//
// Nothing is stored and nothing is marked as delivered. A notice is a
// statement about the account, never promotion: no plan names and no prices.
// The ChatGPT app surface (/mcp/apps) is held to stricter rules (no links,
// no mention of buying anything), so it asks for the `neutral` copy.
//
// Never throws and never rejects: a notice must not be able to fail, delay or
// charge a tool call.

const LOW_BALANCE_AT = 0.8;
// Both margins below are counted in lookups, not credits, so they mean the same
// thing whatever a lookup costs. The low notice is shown for calls landing
// within this many lookups past the threshold, not only on the exact crossing:
// calls in a burst read the ledger before each other's charges land, so an
// exact-crossing test can be stepped over by all of them. And with this many
// lookups or fewer left, every call says so.
const MARGIN_LOOKUPS = 5;
const marginCredits = (lookupCost) => MARGIN_LOOKUPS * (Number(lookupCost) > 0 ? Number(lookupCost) : 2);
const LOOKBACK_DAYS = 30;
const RECHARGE_URL = 'https://www.stockportfolio.pro/recharge.html?utm_source=connector&utm_campaign=low_credits';

function longDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// The wallet as it stands once this call has been charged. `gate` is the
// limiter's check() from before the call.
function after(gate) {
    const allowance = Math.max(0, Number(gate && gate.allowance) || 0);
    const cost = Math.max(0, Number(gate && gate.cost) || 0);
    const usedBefore = Math.max(0, Number(gate && gate.used) || 0);
    const used = usedBefore + cost;
    return { allowance, cost, usedBefore, used, remaining: Math.max(0, allowance - used), resetsAt: (gate && gate.resetsAt) || null };
}

function isLow(gate, lookupCost) {
    const w = after(gate);
    if (!w.allowance || !w.cost) return false;
    const margin = marginCredits(lookupCost);
    const threshold = w.allowance * LOW_BALANCE_AT;
    const crossing = w.used >= threshold && w.usedBefore < threshold + margin;
    return crossing || w.remaining <= margin;
}

function lowBalanceText(gate, { neutral = false, lookupCost = 2, askCost = 42 } = {}) {
    if (!isLow(gate, lookupCost)) return null;
    const w = after(gate);
    const lookups = Math.floor(w.remaining / (Number(lookupCost) || 1));
    const reset = longDate(w.resetsAt);
    if (neutral) {
        const left = lookups > 0 ? `about ${plural(lookups, 'more lookup')} remain` : 'no more lookups remain';
        return `The connected StockPortfolio.pro account has used most of its allowance for this period; ${left}.`
            + (reset ? ` It resets on ${reset}.` : '')
            + ' Tell the user before starting a large batch of lookups.';
    }
    const enough = lookups > 0
        ? `enough for about ${plural(lookups, 'more data lookup')} (an AI answer costs ${askCost})`
        : 'not enough for another data lookup';
    return `StockPortfolio.pro credits are running low: ${w.remaining} of ${w.allowance} left this month, ${enough}.`
        + (reset ? ` The monthly allowance returns on ${reset}.` : '')
        + ` Refills: ${RECHARGE_URL}`
        + ' Tell the user this before starting a large batch of lookups.';
}

function creditsAddedText(added, gate, { neutral = false } = {}) {
    const credits = Math.floor(Number(added && added.credits) || 0);
    if (credits <= 0) return null;
    const w = after(gate);
    const on = longDate(added.at);
    if (neutral) {
        return `The allowance on the connected StockPortfolio.pro account was increased${on ? ` on ${on}` : ''}. Tell the user.`;
    }
    return `${plural(credits, 'credit')} ${credits === 1 ? 'was' : 'were'} added to this StockPortfolio.pro account${on ? ` on ${on}` : ''}. `
        + `After this call it has ${plural(w.remaining, 'credit')} available. Tell the user.`;
}

// Credits that reached the wallet since this account's last connector call
// (or in the last LOOKBACK_DAYS, whichever is more recent). Must be read
// BEFORE the current call is charged: its own ledger row would otherwise be
// the "last call" and hide everything.
async function creditsAddedSinceLastCall(ledger, userId, now = new Date()) {
    try {
        const uid = String(userId);
        const floor = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        const last = await ledger
            .find({ userId: uid, delta: { $lt: 0 }, reason: /^mcp/, at: { $gt: floor } })
            .sort({ at: -1 }).limit(1).project({ _id: 0, at: 1 }).toArray();
        const since = last.length && last[0].at instanceof Date ? last[0].at : floor;
        const rows = await ledger
            .find({ userId: uid, delta: { $gt: 0 }, at: { $gt: since } })
            .project({ _id: 0, delta: 1, at: 1 }).toArray();
        if (!rows.length) return null;
        let credits = 0;
        let at = null;
        for (const r of rows) {
            credits += Number(r.delta) || 0;
            if (r.at instanceof Date && (!at || r.at > at)) at = r.at;
        }
        return credits > 0 ? { credits, at } : null;
    } catch (_) { return null; }
}

/**
 * The notice for one successful, charged connector call, or null.
 *
 *   ledger   the native credit_ledger collection
 *   gate     the limiter's check() result from before the call
 *   neutral  true on /mcp/apps
 *   facts    { lookupCost, askCost }
 *
 * Resolves to { account_notice, credits? }. `credits` is left out of the
 * neutral form, which does not speak in credits at all.
 */
async function forCall({ ledger, userId, gate, neutral = false, facts = {}, now } = {}) {
    try {
        if (!ledger || !userId || !gate) return null;
        const added = await creditsAddedSinceLastCall(ledger, userId, now || new Date());
        const parts = [
            added ? creditsAddedText(added, gate, { neutral }) : null,
            lowBalanceText(gate, { neutral, ...facts })
        ].filter(Boolean);
        if (!parts.length) return null;
        const notice = { account_notice: parts.join(' ') };
        if (!neutral) {
            const w = after(gate);
            notice.credits = { used: w.used, allowance: w.allowance, remaining: w.remaining, resets_at: w.resetsAt };
        }
        return notice;
    } catch (_) { return null; }
}

// Notice keys go first so they are the first thing a model reads and survive a
// client that truncates a long result. A result that is not a plain object is
// returned untouched.
function attach(result, notice) {
    if (!notice || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    return { ...notice, ...result };
}

// What mcp-endpoint.js and mcp-apps.js call. Started before the tool handler
// runs and awaited after the charge, so it reads the ledger as it stood before
// this call. `deps.accountNotice` is absent for keyless callers, who have no
// account to say anything about.
function begin(deps, gate) {
    if (!deps || typeof deps.accountNotice !== 'function') return Promise.resolve(null);
    try { return Promise.resolve(deps.accountNotice(gate)).catch(() => null); } catch (_) { return Promise.resolve(null); }
}

module.exports = {
    LOW_BALANCE_AT, MARGIN_LOOKUPS, LOOKBACK_DAYS, RECHARGE_URL,
    isLow, lowBalanceText, creditsAddedText, creditsAddedSinceLastCall, forCall, attach, begin
};
