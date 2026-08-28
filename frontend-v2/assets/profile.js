// Profile: tier + Ask quota (same content dashboard's old plan card showed),
// plus the shared Ask+Dossier credit ledger with a used/allowance bar, an
// Ask-vs-Dossier split, and an itemized recent-activity list. Messages (the
// support thread) live on this same page too, but are driven entirely by
// the existing bundled assets/messages.js — this file only owns the plan +
// credits card.
(function () {
    'use strict';
    const { API, token, esc, nav, footer } = window.V2;
    nav('profile');
    footer();

    const $ = (id) => document.getElementById(id);
    if (!token()) {
        $('locked').hidden = false;
        return;
    }
    $('authed').hidden = false;

    const auth = { Authorization: `Bearer ${token()}` };

    function activityLabel(reason, refId) {
        if (reason === 'ask') return 'Ask question';
        if (reason === 'dossier') {
            const [symbol, depth] = String(refId || '').split(':');
            const kind = depth === 'deep' ? 'Deep Dossier' : 'Standard Dossier';
            return symbol ? `${kind}: ${symbol}` : kind;
        }
        return 'Credit use';
    }

    function mountCredits(credits) {
        const wrap = $('credits-section');
        const allowance = Number(credits.allowance) || 0;
        const used = Number(credits.used) || 0;
        const remaining = Number.isFinite(credits.remaining) ? credits.remaining : Math.max(0, allowance - used);
        const recent = Array.isArray(credits.recent) ? credits.recent : [];

        // Nothing to show yet (fresh account, or the fetch came back empty)
        // — leave the whole sub-section hidden rather than render a
        // misleading "0 of 0" bar.
        if (!allowance && !used && !recent.length) return;

        $('credits-used-label').textContent = `${used} / ${allowance} credits used`;
        $('credits-remaining-label').textContent = `${Math.max(0, remaining)} left`;
        const fill = $('credits-bar-fill');
        const pctUsed = allowance > 0 ? Math.min(100, (used / allowance) * 100) : 0;
        fill.style.width = `${pctUsed}%`;
        fill.classList.toggle('is-high', pctUsed >= 85);

        // Ask/Dossier split, derived from the same `recent` rows the
        // activity list renders below — one source of truth, no extra
        // request. recentActivity() is capped server-side, so on a very
        // heavy month those rows may not cover the full `used` total; only
        // show the split when they plausibly do, rather than render a
        // partial breakdown that looks complete but isn't.
        let ask = 0, dossier = 0, covered = 0;
        for (const row of recent) {
            const amt = Math.max(0, -Number(row.delta) || 0);
            covered += amt;
            if (row.reason === 'ask') ask += amt;
            else if (row.reason === 'dossier') dossier += amt;
        }
        const breakdownEl = $('credits-breakdown');
        if (recent.length && covered >= used) {
            const max = Math.max(ask, dossier, 1);
            breakdownEl.innerHTML = [['Ask', ask], ['Dossier', dossier]].map(([label, amt]) => `
                <div class="credits-split-row">
                  <span class="small muted">${label}</span>
                  <div class="credits-split-track"><div class="credits-split-fill" style="width:${(amt / max) * 100}%;"></div></div>
                  <span class="small" style="text-align:right;">${amt} credits</span>
                </div>`).join('');
            breakdownEl.hidden = false;
        } else {
            breakdownEl.hidden = true;
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
