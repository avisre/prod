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
// The connector trial (mcp-trial.js) has its own landing point: the same page,
// with its own campaign tag so trial-stage sends are attributable separately.
const TRIAL_UPGRADE_URL = `${SITE}/upgrade.html?utm_source=connector&utm_medium=email&utm_campaign=trial`;

const REASON_BY_CODE = { ENTITLEMENT_REQUIRED: 'no_access', QUOTA_EXCEEDED: 'out_of_credits', TRIAL_ENDED: 'trial_ended' };

// The three trial-stage emails (owner decision 2026-10-26), each sent AT MOST
// ONCE per account — a trial is a one-shot funnel, so unlike the refusal
// nudges there is no interval after which the same stage may repeat. The
// claim fields live under mcpTrialEmails on the user doc.
const TRIAL_FIELD = { started: 'mcpTrialEmails.startedAt', reminder: 'mcpTrialEmails.reminderAt', ended: 'mcpTrialEmails.endedAt' };
// The reminder goes out inside this many days of the trial's end.
const TRIAL_REMIND_DAYS = 7;

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

// The trial-stage wrapper: the same shape as wrap(), with a footer that says
// why THIS email exists, so a trial customer is not told their call was
// refused on the day the trial started.
function trialWrap(paragraphs, cta) {
    const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join('');
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1b18;font-size:15px;line-height:1.6">${body}`
        + `<p style="margin:22px 0"><a href="${escapeHtml(cta.url)}" style="background:#1c1b18;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>`
        + `<p style="margin:0 0 14px">Reply to this email if anything here is wrong and we will sort it out.</p>`
        + `<p style="margin:0;color:#726e65;font-size:12.5px">You are getting this because your StockPortfolio.pro account used the free connector trial. We send at most one email per trial stage.</p></div>`;
}

function longDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// The three trial-stage emails: started (first call), reminder (7 days left)
// and ended (the 30 days are over, or the allowance is used up). Plain copy:
// what the trial includes, when it ends, and the one way to continue. The
// figures come from mcp-trial's status/config so a copy edit cannot drift
// from what the meter actually allows.
function trialEmail(kind, { name, monthlyPrice, lookupCost, askCost, monthlyCredits = 200, lookups = 25, asks = 3, days = 30, endsAt, daysLeft, lookupsLeft, asksLeft, usedUp } = {}) {
    const hi = `Hi ${firstName(name)},`;
    const included = `${lookups} data lookups and ${asks} AI answers over ${days} days`;
    const ends = longDate(endsAt);
    const plan = `The Monthly plan is ${money(monthlyPrice)} a month, cancel anytime. It includes this connector with ${monthlyCredits} credits a month (a data lookup costs ${lookupCost} credits, an AI answer ${askCost}) and the full StockPortfolio.pro website.`;
    const nothingToReconnect = 'After subscribing there is nothing to reconnect — the connection picks the new plan up on the next call.';
    let subject;
    let lines;
    if (kind === 'started') {
        subject = 'Your StockPortfolio connector free trial has started';
        lines = [
            'You just used the StockPortfolio connector inside an AI assistant (Claude or ChatGPT), and the free trial on your account is now active.',
            `It includes ${included}${ends ? `, until ${ends}` : ''}.`,
            `${plan} ${nothingToReconnect}`
        ];
    } else if (kind === 'reminder') {
        subject = `${TRIAL_REMIND_DAYS} days left in your StockPortfolio connector free trial`;
        const left = Number.isFinite(Number(lookupsLeft)) && Number.isFinite(Number(asksLeft))
            ? ` ${lookupsLeft} data lookups and ${asksLeft} AI answers are left.` : '';
        lines = [
            `Your free trial of the StockPortfolio connector${ends ? ` ends on ${ends}` : ''} — ${Number(daysLeft) || TRIAL_REMIND_DAYS} days from now.${left}`,
            `${plan} ${nothingToReconnect}`
        ];
    } else if (kind === 'ended') {
        subject = 'Your StockPortfolio connector free trial has ended';
        lines = [
            usedUp
                ? `The free trial on your StockPortfolio account has used up its ${included}.`
                : `The ${days}-day free trial on your StockPortfolio account has ended${ends ? ` (${ends})` : ''}; it included ${included}.`,
            `${plan} ${nothingToReconnect}`
        ];
    } else {
        return null;
    }
    return {
        subject,
        text: `${hi}\n\n${lines.join('\n\n')}\n\nSee plans: ${TRIAL_UPGRADE_URL}\n\nReply to this email if anything here is wrong and we will sort it out.\n\nYou are getting this because your StockPortfolio.pro account used the free connector trial. We send at most one email per trial stage.`,
        html: trialWrap([escapeHtml(hi), ...lines.map(escapeHtml)], { url: TRIAL_UPGRADE_URL, label: 'See plans' })
    };
}

function nudgeEmail(reason, { name, monthlyPrice, lookupCost, askCost, monthlyCredits = 200, topupCredits, topupPrice, resetsAt } = {}) {
    const hi = `Hi ${firstName(name)},`;
    if (reason === 'trial_ended') {
        // Routed here when a TRIAL_ENDED refusal reaches the nudge path; the
        // trial stage emails normally go out through maybeSendTrial, which
        // knows the live status (dates, what is left). This copy works without
        // it, because a trial that has ended needs no counts.
        return trialEmail('ended', { name, monthlyPrice, lookupCost, askCost, monthlyCredits });
    }
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
        // A trial that has ended is a one-shot funnel stage, not a recurring
        // refusal: it claims its own once-ever field (mcpTrialEmails), while
        // the wallet/plan nudges keep the NUDGE_INTERVAL_DAYS throttle.
        const onceEver = reason === 'trial_ended';
        const field = onceEver ? TRIAL_FIELD.ended : `connectorNudges.${reason}At`;
        const cutoff = onceEver ? null : new Date(now.getTime() - NUDGE_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
        const claim = await deps.users.updateOne(
            cutoff
                ? { _id: user._id, $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: { $lt: cutoff } }] }
                : { _id: user._id, $or: [{ [field]: { $exists: false } }, { [field]: null }] },
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

/**
 * The trial-stage email for one connector call by a free signed-in account.
 * Decides the stage from the account's LIVE trial status (mcp-trial.status):
 * the refusal code alone cannot — QUOTA_EXCEEDED can be the trial's own
 * allowance, or the shared global day cap, which is temporary. Resolves to a
 * short status string; never throws, and never sends more than one email per
 * stage per account.
 *
 *   deps.users     the native `users` collection (claims the once-ever stage)
 *   deps.sendMail  mailer.sendMail
 *   deps.status    async () => mcp-trial status for the account
 *   deps.facts     { monthlyPrice, lookupCost, askCost }
 *   deps.now       optional clock, for tests
 */
async function maybeSendTrial({ user, code } = {}, deps = {}) {
    try {
        if (!user || !user._id) return 'no_user';
        if (user.reviewAccount) return 'review_account';
        const to = String(user.email || '').trim();
        if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return 'no_email';
        if (!deps.users || typeof deps.sendMail !== 'function' || typeof deps.status !== 'function') return 'not_configured';

        const st = await deps.status();
        if (!st || !st.started) return 'not_started';
        // "Ended" covers both ways a trial stops: the 30 days are over, or the
        // whole allowance is spent. One action exhausted while the other
        // remains is not the end — a global-day refusal reads the same way,
        // because its reservation is undone and the status shows allowance
        // still available.
        const usedUp = Number(st.lookupsLeft) <= 0 && Number(st.asksLeft) <= 0;
        const ended = Boolean(st.ended) || usedUp || code === 'TRIAL_ENDED';
        const kind = ended ? 'ended' : (Number(st.daysLeft) <= TRIAL_REMIND_DAYS ? 'reminder' : 'started');

        const now = deps.now ? deps.now() : new Date();
        const field = TRIAL_FIELD[kind];
        // Once EVER per account: a trial is one-shot, so there is no interval
        // after which the same stage may be sent again.
        const claim = await deps.users.updateOne(
            { _id: user._id, $or: [{ [field]: { $exists: false } }, { [field]: null }] },
            { $set: { [field]: now } }
        );
        if (!claim || !claim.modifiedCount) return 'throttled';

        const mail = trialEmail(kind, {
            name: user.name,
            endsAt: st.endsAt, daysLeft: st.daysLeft,
            lookupsLeft: st.lookupsLeft, asksLeft: st.asksLeft,
            lookups: st.lookupsLimit, asks: st.asksLimit, days: st.days,
            usedUp: usedUp && !st.ended,
            ...(deps.facts || {})
        });
        if (!mail) return 'not_a_trial_stage';
        const sent = await deps.sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text });
        if (!sent) {
            // Not delivered: release the claim so the next call can try again.
            await deps.users.updateOne({ _id: user._id, [field]: now }, { $unset: { [field]: '' } }).catch(() => {});
            return 'send_failed';
        }
        return `sent:${kind}`;
    } catch (err) {
        try { console.error('[connector-nudge] trial email failed:', err && err.message); } catch (_) { /* ignore */ }
        return 'error';
    }
}

module.exports = { NUDGE_INTERVAL_DAYS, TRIAL_REMIND_DAYS, TRIAL_FIELD, REASON_BY_CODE, UPGRADE_URL, RECHARGE_URL, TRIAL_UPGRADE_URL, nudgeEmail, trialEmail, maybeSend, maybeSendTrial };
