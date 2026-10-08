'use strict';

// One email to a signed-in account whose connector request was just refused.
//
// A refusal inside an assistant is easy to miss and, on the ChatGPT app, may
// not name a plan, a price or a link at all (plugin guidelines). The account's
// email address is the one channel we own for that person, so the fix is sent
// there: which plan includes the connector, or how to top the wallet up.
//
// Two reasons, each sent at most once per account per NUDGE_INTERVAL_DAYS:
//   no_access       the plan does not include the connector (ENTITLEMENT_REQUIRED)
//   out_of_credits  the month's credits are spent           (QUOTA_EXCEEDED)
//
// Never sent to anonymous callers (there is no address), to internal review
// accounts (the OpenAI and Anthropic reviewers walk these exact refusals), or
// when SMTP is not configured. It goes through mailer.sendMail, so it carries
// the support@ From and Reply-To like every other customer mail.
//
// The throttle is claimed BEFORE sending, with one atomic update, so two
// refused calls landing together cannot both send. A failed send releases the
// claim so the next refusal tries again.

const creditTopupPacks = require('./credit-topup-packs');
const NUDGE_INTERVAL_DAYS = 30;
const SITE = 'https://www.stockportfolio.pro';
const UPGRADE_URL = `${SITE}/upgrade.html?utm_source=connector&utm_medium=email&utm_campaign=no_access`;
const RECHARGE_URL = `${SITE}/recharge.html?utm_source=connector&utm_medium=email&utm_campaign=out_of_credits`;

const REASON_BY_CODE = { ENTITLEMENT_REQUIRED: 'no_access', QUOTA_EXCEEDED: 'out_of_credits' };

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) { return `$${Number(n).toFixed(2)}`; }

function firstName(name) {
    return (String(name || '').trim().split(/\s+/)[0]) || 'there';
}

function wrap(paragraphs, cta) {
    const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join('');
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1b18;font-size:15px;line-height:1.6">${body}`
        + `<p style="margin:22px 0"><a href="${escapeHtml(cta.url)}" style="background:#1c1b18;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>`
        + `<p style="margin:0 0 14px">Reply to this email if anything here is wrong and we will sort it out.</p>`
        + `<p style="margin:0;color:#726e65;font-size:12.5px">You are getting this because a request from an assistant connected to your StockPortfolio.pro account was refused. We send it at most once every ${NUDGE_INTERVAL_DAYS} days.</p></div>`;
}

function nudgeEmail(reason, { name, monthlyPrice, lookupCost, askCost, monthlyCredits = 100, topupCredits, topupPrice, resetsAt } = {}) {
    const hi = `Hi ${firstName(name)},`;
    if (reason === 'no_access') {
        const plan = `The Monthly plan is ${money(monthlyPrice)} a month and you can cancel anytime. It includes the connector with ${monthlyCredits} credits a month (a data lookup costs ${lookupCost} credits, an AI answer ${askCost}) and the full StockPortfolio.pro website.`;
        const lines = [
            'You connected StockPortfolio to an AI assistant (Claude or ChatGPT) and asked it for data, but the request was refused: the plan on your account does not include the connector.',
            plan,
            'You do not need to reconnect anything. Once the plan is active, ask the assistant again and it will work.'
        ];
        return {
            subject: 'Your StockPortfolio connector needs a plan that includes it',
            text: `${hi}\n\n${lines.join('\n\n')}\n\nSee plans: ${UPGRADE_URL}\n\nReply to this email if anything here is wrong and we will sort it out.\n\nYou are getting this because a request from an assistant connected to your StockPortfolio.pro account was refused. We send it at most once every ${NUDGE_INTERVAL_DAYS} days.`,
            html: wrap([escapeHtml(hi), ...lines.map(escapeHtml)], { url: UPGRADE_URL, label: 'See plans' })
        };
    }
    if (reason === 'out_of_credits') {
        const when = resetsAt ? new Date(resetsAt) : null;
        const back = when && !Number.isNaN(when.getTime())
            ? `Your monthly credits come back on ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`
            : 'Your monthly credits come back at the start of next month.';
        const lines = [
            'An AI assistant connected to your StockPortfolio.pro account (Claude or ChatGPT) asked for data, but the request was refused: this month’s credits are used up.',
            `${back} To keep going now, a top-up adds ${topupCredits} credits for ${money(topupPrice)}, and larger refills go up to ${creditTopupPacks.largestLabel()}; they stay in your wallet until you use them.`,
            `Through the connector a data lookup costs ${lookupCost} credits and an AI answer ${askCost}. You do not need to reconnect anything.`
        ];
        return {
            subject: 'You have used this month’s StockPortfolio credits',
            text: `${hi}\n\n${lines.join('\n\n')}\n\nTop up: ${RECHARGE_URL}\n\nReply to this email if anything here is wrong and we will sort it out.\n\nYou are getting this because a request from an assistant connected to your StockPortfolio.pro account was refused. We send it at most once every ${NUDGE_INTERVAL_DAYS} days.`,
            html: wrap([escapeHtml(hi), ...lines.map(escapeHtml)], { url: RECHARGE_URL, label: `Top up ${topupCredits} credits` })
        };
    }
    return null;
}

/**
 * Sends the nudge for one refused call if this account has not had that nudge
 * recently. Resolves to a short status string; never throws.
 *
 *   deps.users     the native `users` collection (claims the throttle)
 *   deps.sendMail  mailer.sendMail
 *   deps.facts     { monthlyPrice, lookupCost, askCost, topupCredits, topupPrice }
 *   deps.now       optional clock, for tests
 */
async function maybeSend({ user, code, anonymous, resetsAt } = {}, deps = {}) {
    try {
        const reason = REASON_BY_CODE[code];
        if (!reason) return 'not_a_nudge';
        if (anonymous || !user || !user._id) return 'anonymous';
        if (user.reviewAccount) return 'review_account';
        const to = String(user.email || '').trim();
        if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return 'no_email';
        if (!deps.users || typeof deps.sendMail !== 'function') return 'not_configured';

        const now = deps.now ? deps.now() : new Date();
        const field = `connectorNudges.${reason}At`;
        const cutoff = new Date(now.getTime() - NUDGE_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
        const claim = await deps.users.updateOne(
            { _id: user._id, $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: { $lt: cutoff } }] },
            { $set: { [field]: now } }
        );
        if (!claim || !claim.modifiedCount) return 'throttled';

        const mail = nudgeEmail(reason, { name: user.name, resetsAt, ...(deps.facts || {}) });
        const sent = await deps.sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text });
        if (!sent) {
            // Not delivered (SMTP down or unconfigured): release the claim so a
            // later refusal can try again instead of staying silent for a month.
            await deps.users.updateOne({ _id: user._id, [field]: now }, { $unset: { [field]: '' } }).catch(() => {});
            return 'send_failed';
        }
        return `sent:${reason}`;
    } catch (err) {
        try { console.error('[connector-nudge] failed:', err && err.message); } catch (_) { /* ignore */ }
        return 'error';
    }
}

module.exports = { NUDGE_INTERVAL_DAYS, REASON_BY_CODE, UPGRADE_URL, RECHARGE_URL, nudgeEmail, maybeSend };
