// Profile: tier + Ask quota (same content dashboard's old plan card showed),
// plus the shared Ask+Dossier credit ledger with a used/allowance bar, an
// Ask-vs-Dossier split, and an itemized recent-activity list. Messages (the
// support thread) live on this same page too, but are driven entirely by
// the existing bundled assets/messages.js — this file only owns the plan +
// credits card.
(function () {
    'use strict';
    // formatReset / activityLabel / creditSplit are shared with the nav account
    // dropdown and live in app.js — the same numbers are rendered in both
    // places, so they must not have two implementations that can drift.
    const { API, token, esc, nav, footer, formatReset, activityLabel, creditSplit } = window.V2;
    nav('profile');
    footer();

    const $ = (id) => document.getElementById(id);
    if (!token()) {
        $('locked').hidden = false;
        return;
    }
    $('authed').hidden = false;

    const auth = { Authorization: `Bearer ${token()}` };

    function mountCredits(credits) {
        const wrap = $('credits-section');
        const allowance = Number(credits.allowance) || 0;
        const used = Number(credits.used) || 0;
        const remaining = Number.isFinite(credits.remaining) ? credits.remaining : Math.max(0, allowance - used);
        const recent = Array.isArray(credits.recent) ? credits.recent : [];
        const hasMonitor = !!credits.hasMonitor;
        const cost = credits.cost || {};

        // Nothing to show yet (fresh account, or the fetch came back empty)
        // — leave the whole sub-section hidden rather than render a
        // misleading "0 of 0" bar.
        if (!allowance && !used && !recent.length) return;

        $('credits-used-label').textContent = `${used} / ${allowance} credits used`;
        $('credits-remaining-label').textContent = `${Math.max(0, remaining)} left`;
        const resetEl = $('credits-reset');
        if (resetEl) resetEl.textContent = formatReset(credits.resetsAt);
        const fill = $('credits-bar-fill');
        const pctUsed = allowance > 0 ? Math.min(100, (used / allowance) * 100) : 0;
        fill.style.width = `${pctUsed}%`;
        fill.classList.toggle('is-high', pctUsed >= 85);

        // Ask/Monitor/Dossier split, derived from the same `recent` rows the
        // activity list renders below — one source of truth, no extra
        // request. recentActivity() is capped server-side, so on a very
        // heavy month those rows may not cover the full `used` total; only
        // show the split when they plausibly do, rather than render a
        // partial breakdown that looks complete but isn't.
        const { ask, monitor, dossier, covered } = creditSplit(recent);
        const breakdownEl = $('credits-breakdown');
        if (recent.length && covered >= used) {
            // Monitor is Power/Desk-only — a user who can't reach the feature
            // gets a one-line upsell in its place instead of a usage row for
            // something they've never been able to use.
            const rows = [['Ask', ask]];
            if (hasMonitor) rows.push(['Monitor', monitor]);
            rows.push(['Dossier', dossier]);
            const max = Math.max(...rows.map(([, amt]) => amt), 1);
            breakdownEl.innerHTML = rows.map(([label, amt]) => `
                <div class="credits-split-row">
                  <span class="small muted">${label}</span>
                  <div class="credits-split-track"><div class="credits-split-fill" style="width:${(amt / max) * 100}%;"></div></div>
                  <span class="small" style="text-align:right;">${amt} credits</span>
                </div>`).join('')
                + (hasMonitor ? '' : '<p class="small muted" style="margin:8px 0 0;">The Filing Change Monitor is on Power and Desk.</p>');
            breakdownEl.hidden = false;
        } else {
            breakdownEl.hidden = true;
        }

        const costEl = $('credits-cost-line');
        if (costEl) {
            const parts = [`Ask a question ${cost.ask ?? 2}`];
            if (hasMonitor) parts.push(`Monitor report ${cost.monitor ?? 5}`);
            parts.push(`Dossier ${cost.dossier_standard ?? 10}`, `Deep Dossier (3-year) ${cost.dossier_deep ?? 30}`);
            costEl.textContent = parts.join(' · ') + '. Re-opening anything you’ve already run is free.';
        }

        const activityWrap = $('credits-activity-wrap');
        const list = $('credits-activity-list');
        if (recent.length) {
            list.innerHTML = recent.map((row) => {
                const amt = Math.max(0, -Number(row.delta) || 0);
                const when = row.at ? new Date(row.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
                return `<li><span>${esc(activityLabel(row.reason, row.refId))}</span><span class="amt">&minus;${amt} credits <span class="when">&middot; ${esc(when)}</span></span></li>`;
            }).join('');
            activityWrap.hidden = false;
        } else {
            activityWrap.hidden = true;
        }

        wrap.hidden = false;
    }

    async function mountProfile() {
        try {
            const [sessionR, quotaR, creditsR] = await Promise.all([
                fetch(`${API}/session`, { headers: auth }),
                fetch(`${API}/ai/chat/quota`, { headers: auth }),
                fetch(`${API}/credits`, { headers: auth })
            ]);
            const session = await sessionR.json().catch(() => ({}));
            const quota = await quotaR.json().catch(() => ({}));
            const credits = await creditsR.json().catch(() => ({}));

            const section = $('plan-status');
            const nameEl = $('plan-name');
            const quotaEl = $('plan-quota');
            const includesEl = $('plan-includes');
            const upgradeEl = $('plan-upgrade');
            if (!section || !session.subscription) return;

            nameEl.textContent = session.subscription.planName || (session.tier === 'free' ? 'Free' : session.tier === 'core' ? 'Core' : 'Pro');
            quotaEl.textContent = Number.isFinite(quota.limit)
                ? `${quota.used || 0} / ${quota.limit} Ask questions used this month`
                : '';
            includesEl.textContent = session.tier === 'pro'
                ? 'Includes Dossier, filing key points, reverse-DCF, screener & AI verdict, and unlimited portfolio tracking. The Filing Change Monitor, Thesis Tracker and tax tools are on Power/Desk — not included on Pro or any AppSumo tier.'
                : session.tier === 'core'
                    ? 'Includes screener, comparison and portfolio tracking. Upgrade to Pro for Ask, Dossier and filing key points.'
                    : 'Upgrade for Ask, Dossier, screener and portfolio tracking.';
            if (quota.appsumo && quota.appsumo.isAppSumo) {
                upgradeEl.innerHTML = `Need more Ask questions? <a href="${esc(quota.appsumo.upgradeUrl)}">Upgrade your AppSumo license →</a>`;
                upgradeEl.hidden = false;
            } else {
                upgradeEl.hidden = true;
            }
            section.hidden = false;

            mountCredits(credits);
        } catch (_) { /* profile card is non-blocking */ }
    }
    mountProfile();
})();
