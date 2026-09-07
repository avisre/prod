// Profile: tier + plan card, plus the shared Ask/Dossier/Monitor credit meter —
// remaining as the headline, one stacked bar carrying the per-feature split,
// where the wallet came from (plan vs purchased), the month's burn rate, and a
// running-balance ledger. Messages (the support thread) live on this same page
// too, but are driven entirely by the existing bundled assets/messages.js —
// this file only owns the plan + credits card.
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

    // 🧪 AI Paper Portfolio beta: priced in the cost line only when the
    // server says this account is in the experiment. The probe 403s for
    // everyone else, so the feature stays invisible — and the price line
    // stays exactly as it always was for them.
    let aiPaperBeta = false;

    // The recharge SKU, named once. Three call sites used to spell out
    // "150 credits — $14.99" independently (here, the low-balance line, and
    // app.js's out-of-credits notice), which is three places to miss when the
    // pack changes.
    const RECHARGE = { credits: 150, price: '$14.99' };

    // Billable features, in wallet order. `reason` is the ledger's reason field
    // (backend/credits.js), `unit` names the thing a credit bought — a credit is
    // an invented currency and nobody budgets in one. Adding a billable feature
    // means adding a row here and nothing else.
    // `reasons` are the ledger's reason strings (the credits.spend call sites in
    // backend/app.js). Dossier owns two of them: a comparison spends under
    // 'dossier-compare', a reason the old client-side split knew nothing about —
    // so compares were dropped from the breakdown while still counting toward
    // its covered-vs-used check, quietly under-reporting Dossier spend on a
    // split that looked complete.
    const FEATURES = [
        { key: 'ask', reasons: ['ask'], label: 'Ask', seg: 'credits-seg-ask', unit: ['question', 'questions'] },
        { key: 'dossier', reasons: ['dossier', 'dossier-compare'], label: 'Dossier', seg: 'credits-seg-dossier', unit: ['report', 'reports'] },
        { key: 'monitor', reasons: ['monitor'], label: 'Monitor', seg: 'credits-seg-monitor', unit: ['report', 'reports'] }
    ];

    const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

    // Server-side breakdown when the deploy has it (complete for the month by
    // construction), else the old client-side sum over the capped `recent` rows.
    // creditSplit carries the covered >= used guard; here it only decides
    // whether the FALLBACK is trustworthy, instead of deciding whether the user
    // sees a breakdown at all — the old behaviour hid the split from exactly the
    // people whose month was worth splitting.
    function featureSpend(credits, used, recent) {
        const bd = credits && credits.breakdown;
        if (bd && typeof bd === 'object') {
            const out = {};
            let named = 0;
            for (const f of FEATURES) {
                let spent = 0;
                let count = 0;
                for (const reason of f.reasons) {
                    const row = bd[reason] || {};
                    spent += Math.max(0, -(Number(row.delta) || 0));
                    count += Number(row.count) || 0;
                }
                out[f.key] = { credits: spent, count };
                named += spent;
            }
            // Anything billable under a reason this build doesn't know about
            // still has to appear, or the rows won't add up to `used`.
            out.other = { credits: Math.max(0, used - named), count: 0 };
            return out;
        }
        const s = creditSplit(recent);
        if (!recent.length || s.covered < used) return null;
        return {
            ask: { credits: s.ask, count: 0 },
            dossier: { credits: s.dossier, count: 0 },
            monitor: { credits: s.monitor, count: 0 },
            other: { credits: Math.max(0, used - s.ask - s.dossier - s.monitor), count: 0 }
        };
    }

    function mountCredits(credits) {
        const wrap = $('credits-section');
        const allowance = Number(credits.allowance) || 0;
        const used = Number(credits.used) || 0;
        const remaining = Number.isFinite(credits.remaining) ? credits.remaining : Math.max(0, allowance - used);
        const recent = Array.isArray(credits.recent) ? credits.recent : [];
        const hasMonitor = !!credits.hasMonitor;
        const cost = credits.cost || {};
        // plan/purchased ship with the breakdown; an older server returns
        // neither, so the wallet line falls back to describing the total rather
        // than asserting a split it cannot know.
        const purchased = Number(credits.purchased) || 0;
        const planCredits = Number.isFinite(credits.plan) ? Number(credits.plan) : Math.max(0, allowance - purchased);

        // Nothing to show yet (fresh account, or the fetch came back empty)
        // — leave the whole sub-section hidden rather than render a
        // misleading "0 of 0" bar.
        if (!allowance && !used && !recent.length) return;

        const left = Math.max(0, remaining);
        const headline = $('credits-headline');
        headline.innerHTML = `${left} <span class="unit">of ${allowance} credits left</span>`;
        headline.classList.toggle('is-low', allowance > 0 && left / allowance <= 0.15);
        const resetEl = $('credits-reset');
        if (resetEl) resetEl.textContent = formatReset(credits.resetsAt);

        const spend = featureSpend(credits, used, recent);

        // ---- one stacked bar, drawn against the whole wallet ----
        const bar = $('credits-bar');
        const segments = [];
        if (allowance > 0 && spend) {
            for (const f of FEATURES) {
                const amt = (spend[f.key] || {}).credits || 0;
                if (amt > 0) segments.push([f.seg, amt, `${f.label} ${amt}`]);
            }
            const other = (spend.other || {}).credits || 0;
            if (other > 0) segments.push(['credits-seg-other', other, `Other ${other}`]);
        } else if (allowance > 0 && used > 0) {
            segments.push(['credits-seg-ask', used, `${used} used`]);   // no split available
        }
        bar.innerHTML = segments.map(([cls, amt, title]) =>
            `<div class="credits-seg ${cls}" style="width:${Math.min(100, (amt / allowance) * 100)}%;" title="${esc(title)}"></div>`).join('');

        // ---- breakdown table: credits, and the same spend in real units ----
        const breakdownEl = $('credits-breakdown');
        if (spend) {
            const rows = FEATURES
                .filter((f) => f.key !== 'monitor' || hasMonitor || (spend.monitor || {}).credits > 0)
                .map((f) => {
                    const amt = (spend[f.key] || {}).credits || 0;
                    const n = (spend[f.key] || {}).count || 0;
                    const unit = n > 0 ? plural(n, f.unit) : (amt === 0 ? '—' : '');
                    return `<tr>
                      <td><span class="k"><span class="dot ${f.seg}"></span>${f.label}</span></td>
                      <td class="amt">${amt}</td>
                      <td class="unit">${esc(unit)}</td>
                    </tr>`;
                });
            const other = (spend.other || {}).credits || 0;
            if (other > 0) {
                rows.push(`<tr>
                  <td><span class="k"><span class="dot credits-seg-other"></span>Other</span></td>
                  <td class="amt">${other}</td><td class="unit"></td></tr>`);
            }
            if (!hasMonitor) {
                rows.push(`<tr class="upsell"><td colspan="3">Monitor is on Power and Desk — <a href="/upgrade.html">compare plans &rarr;</a></td></tr>`);
            }
            rows.push(`<tr class="total">
              <td>Used this month</td><td class="amt">${used}</td>
              <td class="unit">of ${allowance}</td></tr>`);
            breakdownEl.innerHTML = rows.join('');
            breakdownEl.hidden = false;
        } else {
            breakdownEl.hidden = true;
        }

        // Wallet states the meter can't say in numbers alone. "Out" and
        // "running low" both get the action one click away; the middle case is
        // affordability, which the meter never used to mention — a wallet under
        // the price of a Dossier reads as healthy right up until the refusal.
        const lowEl = $('credits-low');
        const dossierCost = Number(cost.dossier_standard ?? 10);
        if (lowEl) {
            if (remaining <= 0 && allowance > 0) {
                lowEl.innerHTML = `You're out of credits this month. <a href="/recharge.html">Recharge ${RECHARGE.credits} credits — ${RECHARGE.price}</a> to keep using Ask, Dossier and Monitor now.`;
                lowEl.hidden = false;
            } else if (allowance > 0 && remaining / allowance <= 0.2) {
                lowEl.innerHTML = `Running low — <a href="/recharge.html">recharge ${RECHARGE.credits} credits for ${RECHARGE.price}</a>, or <a href="/upgrade.html">upgrade</a> for a bigger monthly wallet.`;
                lowEl.hidden = false;
            } else if (allowance > 0 && remaining < dossierCost) {
                lowEl.innerHTML = `Enough for ${plural(Math.floor(remaining / Number(cost.ask ?? 2)), ['Ask question', 'Ask questions'])}, but not a Dossier (${dossierCost}) — <a href="/recharge.html">recharge ${RECHARGE.credits} credits for ${RECHARGE.price}</a>.`;
                lowEl.hidden = false;
            } else {
                lowEl.hidden = true;
            }
        }

        // ---- where the wallet came from ----
        const walletEl = $('credits-wallet');
        if (walletEl) {
            const source = purchased > 0
                ? `<strong>${planCredits}</strong> from your plan + <strong>${purchased}</strong> purchased this month`
                : `<strong>${planCredits}</strong> credits a month on your plan`;
            walletEl.innerHTML = `Wallet: ${source}. <a href="/recharge.html">Recharge ${RECHARGE.credits} — ${RECHARGE.price}</a>`;
        }

        // ---- pace, from the month's own clock (no extra request) ----
        // Only once enough of the month is behind us for an average to mean
        // anything. This is the line that sells a recharge honestly: it says
        // "you are fine" as readily as it says "you will run out".
        const paceEl = $('credits-pace');
        if (paceEl) {
            const now = new Date();
            const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
            const resetMs = Date.parse(credits.resetsAt || '');
            const daysElapsed = (Date.now() - monthStart) / 86400000;
            const daysTotal = Number.isFinite(resetMs) ? (resetMs - monthStart) / 86400000 : 30;
            const perDay = daysElapsed > 0 ? used / daysElapsed : 0;
            if (used > 0 && allowance > 0 && daysElapsed >= 3 && perDay > 0) {
                const projected = Math.round(perDay * daysTotal);
                const daysToEmpty = remaining / perDay;
                // A margin, not a bare comparison: running out on the 30th of a
                // month that resets on the 1st is not news, and warning about it
                // trains people to ignore the line that matters.
                const daysLeftInMonth = daysTotal - daysElapsed;
                if (daysToEmpty < daysLeftInMonth - 2) {
                    const emptyOn = new Date(Date.now() + daysToEmpty * 86400000)
                        .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                    const short = Math.max(1, Math.round(daysLeftInMonth - daysToEmpty));
                    paceEl.innerHTML = `Pace: about ${perDay.toFixed(1)} credits a day — at this rate you run out around <strong>${emptyOn}</strong>, ${plural(short, ['day', 'days'])} before the reset.`;
                } else if (projected > allowance * 0.95) {
                    // Between the two: not running dry early enough to warn
                    // about a date, but not comfortable either. Calling a
                    // projection of 455 against a 450 wallet "comfortable" is
                    // how a meter loses the reader's trust.
                    paceEl.textContent = `Pace: about ${perDay.toFixed(1)} credits a day — roughly ${projected} of ${allowance} by the reset, so you finish the month close to empty.`;
                } else {
                    paceEl.textContent = `Pace: about ${perDay.toFixed(1)} credits a day — roughly ${projected} of ${allowance} by the reset. Comfortable.`;
                }
                paceEl.hidden = false;
            } else {
                paceEl.hidden = true;
            }
        }

        const costEl = $('credits-cost-line');
        if (costEl) {
            // Deep Dossier costs 30 and appears in the ledger, but was missing
            // from this line entirely — the one price a user could be surprised by.
            const parts = [`Ask ${cost.ask ?? 2}`];
            if (hasMonitor) parts.push(`Monitor report ${cost.monitor ?? 5}`);
            parts.push(`Compare ${cost.dossier_compare ?? 5}`, `Dossier ${cost.dossier_standard ?? 10}`, `Deep Dossier ${cost.dossier_deep ?? 30}`);
            if (aiPaperBeta) parts.push(`AI Paper build ${cost.ai_paper_build ?? 10}`, `AI Paper nightly review ${cost.ai_paper_daily ?? 4}`);
            costEl.textContent = `What things cost — ${parts.join(' · ')}. Re-opening anything you've already run is free.`;
        }

        // ---- activity ledger, with a running balance ----
        const activityWrap = $('credits-activity-wrap');
        const list = $('credits-activity-list');
        const moreBtn = $('credits-activity-more');
        const metaEl = $('credits-activity-meta');
        const total = Number(credits.activityTotal) || 0;

        function renderActivity(rows) {
            // Walk newest -> oldest from the current balance: the balance after
            // the newest row IS `remaining`, and each older row's balance is the
            // newer one's minus its delta. Exact for the rows shown, whatever
            // page of the ledger they came from.
            let running = Math.max(0, remaining);
            list.innerHTML = rows.map((row) => {
                const delta = Number(row.delta) || 0;
                const after = running;
                running = after - delta;
                const when = row.at ? new Date(row.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
                return `<li>
                  <span class="when">${esc(when)}</span>
                  <span class="what">${esc(activityLabel(row.reason, row.refId))}</span>
                  <span class="amt${delta > 0 ? ' is-add' : ''}">${delta > 0 ? '+' : '&minus;'}${Math.abs(delta)}</span>
                  <span class="bal">${after}</span>
                </li>`;
            }).join('');
            if (metaEl) metaEl.textContent = total > rows.length ? `${rows.length} of ${total} this month` : `${plural(rows.length, ['entry', 'entries'])} this month`;
            if (moreBtn) moreBtn.hidden = total <= rows.length;
        }

        if (recent.length) {
            renderActivity(recent);
            activityWrap.hidden = false;
        } else {
            activityWrap.hidden = true;
        }

        if (moreBtn && !moreBtn.dataset.wired) {
            moreBtn.dataset.wired = '1';
            moreBtn.addEventListener('click', async () => {
                moreBtn.disabled = true;
                try {
                    const r = await fetch(`${API}/credits?activityLimit=200`, { headers: auth });
                    if (r.ok) {
                        const all = await r.json();
                        if (Array.isArray(all.recent)) renderActivity(all.recent);
                    }
                } catch (_) { /* the short list stays — nothing is lost */ }
                moreBtn.disabled = false;
            });
        }

        // The plan line above says the same thing in the used frame; with a
        // live meter directly beneath it, it is duplication that disagrees with
        // itself. It stays in the markup as the fallback for when /api/credits
        // is the request that failed (the incident it was written for: a Tier 1
        // buyer reading a stale Ask counter while his wallet had already moved).
        const quotaLine = $('plan-quota');
        if (quotaLine) quotaLine.hidden = true;

        // Collapsed summary meta on the Usage row — the same frame the headline
        // uses, so the header and the panel can't be read as different numbers.
        const usageMeta = $('usage-meta');
        if (usageMeta && $('plan-name').textContent) {
            usageMeta.textContent = `${$('plan-name').textContent} · ${left} of ${allowance} credits left`;
        }

        wrap.hidden = false;
    }

    // ---- Settings card: Ask memory (saved facts) + import from another
    // provider's export. All routes are owner-scoped; the toggle only gates
    // the assistant's automatic saves, the list is editable regardless. ----
    let memoryFacts = [];
    function renderFacts() {
        const list = $('mem-list');
        const settingsMeta = $('settings-meta');
        if (settingsMeta) {
            settingsMeta.textContent = (memoryFacts && memoryFacts.length)
                ? `${memoryFacts.length} fact${memoryFacts.length === 1 ? '' : 's'} saved`
                : 'No facts yet';
        }
        list.innerHTML = (memoryFacts || []).map((f) => `
            <li data-id="${esc(String(f.id))}">
              <span>${esc(f.fact)}</span>
              <button type="button" data-mem-del title="Delete this fact" aria-label="Delete this fact">✕</button>
            </li>`).join('');
        $('mem-empty').hidden = !!(memoryFacts && memoryFacts.length);
        $('mem-list-wrap').hidden = !(memoryFacts && memoryFacts.length);
    }
    async function mountSettings() {
        try {
            const r = await fetch(`${API}/ask/memory`, { headers: auth });
            if (!r.ok) return; // card stays hidden if the store is unreachable
            const data = await r.json();
            memoryFacts = Array.isArray(data.facts) ? data.facts : [];
            $('mem-toggle').checked = !!data.enabled;
            $('mem-panel').style.opacity = data.enabled ? '1' : '0.8';
            renderFacts();
            $('settings-card').hidden = false;
        } catch (_) { /* settings card is non-blocking */ }
    }
    $('mem-toggle').addEventListener('change', async () => {
        const enabled = $('mem-toggle').checked;
        try {
            const r = await fetch(`${API}/ask/memory/consent`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ enabled })
            });
            if (!r.ok) { $('mem-toggle').checked = !enabled; return; }
            $('mem-panel').classList.toggle('paused', !enabled);
            $('mem-panel').style.opacity = enabled ? '1' : '0.8';
        } catch (_) { $('mem-toggle').checked = !enabled; }
    });
    async function addManualFact() {
        const v = $('mem-input').value.trim();
        if (!v) return;
        try {
            const r = await fetch(`${API}/ask/memory`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ fact: v })
            });
            if (!r.ok) return;
            const data = await r.json();
            if (Array.isArray(data.facts)) { memoryFacts = data.facts; renderFacts(); }
            $('mem-input').value = '';
        } catch (_) { /* best-effort */ }
    }
    $('mem-add').addEventListener('click', addManualFact);
    $('mem-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addManualFact(); } });
    $('mem-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-mem-del]');
        if (!btn) return;
        const li = btn.closest('li[data-id]');
        try {
            const r = await fetch(`${API}/ask/memory/${encodeURIComponent(li.dataset.id)}`, {
                method: 'DELETE', headers: auth
            });
            if (r.ok) {
                memoryFacts = memoryFacts.filter((f) => String(f.id) !== String(li.dataset.id));
                renderFacts();
            }
        } catch (_) { /* best-effort */ }
    });
    $('mem-clear').addEventListener('click', () => {
        window.V2.modal({
            label: 'Clear memory',
            title: 'Clear all saved memories?',
            body: 'Every stored fact is deleted from Ask. This cannot be undone.',
            actions: [
                { label: 'Clear all', primary: true, close: false, onClick: async (close) => {
                    try {
                        const r = await fetch(`${API}/ask/memory`, { method: 'DELETE', headers: auth });
                        if (r.ok) { memoryFacts = []; renderFacts(); close(); }
                    } catch (_) { /* keep dialog open */ }
                } },
                { label: 'Cancel' }
            ]
        });
    });

    // ---- Import: client-side digest of the user's own export → AI distils
    // durable facts → checkbox preview → only ticked facts are stored. ----
    let importCandidates = [];
    const MEM_CAP = 50; // keep in step with backend PM_KEEP
    function renderPreview() {
        const wrap = $('import-preview');
        wrap.hidden = !importCandidates.length;
        // warn before the fact (not after): at 50 stored, everything older than
        // the newest 50 is evicted by the import — the caller can untick some
        const over = memoryFacts.length + importCandidates.length - MEM_CAP;
        $('import-preview-note')?.remove();
        if (over > 0 && wrap.parentElement) {
            const note = document.createElement('p');
            note.id = 'import-preview-note';
            note.className = 'small';
            note.style = 'margin:0 0 6px; color:#b45309;';
            note.textContent = `Memory holds ${MEM_CAP} facts — importing all ${importCandidates.length} would drop your ${over} oldest. Untick anything you can live without.`;
            wrap.insertBefore(note, $('import-items'));
        }
        $('import-items').innerHTML = importCandidates.map((f, i) => `
            <label class="small" style="display:flex; gap:8px; align-items:flex-start;">
              <input type="checkbox" data-i="${i}" checked style="margin-top:2px;" />
              <span>${esc(f)}</span>
            </label>`).join('');
    }
    $('import-open').addEventListener('click', () => $('import-file').click());
    $('import-cancel').addEventListener('click', () => {
        importCandidates = [];
        renderPreview();
        $('import-status').textContent = '';
        $('import-file').value = '';
    });
    $('import-confirm').addEventListener('click', async () => {
        const picked = Array.from($('import-items').querySelectorAll('input[data-i]:checked'))
            .map((c) => importCandidates[Number(c.dataset.i)]).filter(Boolean);
        if (!picked.length) return;
        $('import-status').textContent = `Importing ${picked.length}…`;
        try {
            const r = await fetch(`${API}/ask/memory/import`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ facts: picked })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) { $('import-status').textContent = data.message || 'Import failed.'; return; }
            importCandidates = [];
            renderPreview();
            if (Array.isArray(data.facts)) { memoryFacts = data.facts; renderFacts(); }
            $('import-status').textContent = Number(data.dropped) > 0
                ? `Imported ${data.imported ?? picked.length} facts. Memory holds ${MEM_CAP} — ${data.dropped} of your oldest ${data.dropped === 1 ? 'fact was' : 'facts were'} dropped to fit.`
                : `Imported ${data.imported ?? picked.length} facts.`;
        } catch (_) { $('import-status').textContent = 'Import failed — try again.'; }
    });
    // Walk any data export and collect the strings a memory extractor can use:
    // conversational content, `content`/`text`/`memory`-style fields, plain
    // line-based text. Capped hard so a 500 MB export can't wedge the tab.
    function digestExport(obj, out, depth) {
        if (out.length >= 4000 || depth > 12) return;
        if (obj == null) return;
        if (typeof obj === 'string') { out.push(obj); return; }
        if (Array.isArray(obj)) { for (const v of obj) digestExport(v, out, depth + 1); return; }
        if (typeof obj === 'object') {
            for (const key of ['content', 'text', 'memory', 'message', 'prompt', 'q', 'value', 'title']) {
                if (obj[key] != null) digestExport(obj[key], out, depth + 1);
            }
        }
    }
    $('import-file').addEventListener('change', async () => {
        const f = ($('import-file').files || [])[0];
        if (!f) return;
        $('import-status').textContent = 'Reading…';
        const facts = new Set();
        try {
            if (/\.(txt|md)$/i.test(f.name)) {
                (await f.text()).split(/\n{2,}/).forEach((p) => facts.add(p.replace(/\s+/g, ' ').trim()));
            } else {
                const parsed = JSON.parse(await f.text());
                const strings = [];
                digestExport(parsed, strings, 0);
                strings.forEach((s) => {
                    String(s).split(/(?<=[.!?])\s+|\n+/).forEach((piece) => facts.add(piece.replace(/\s+/g, ' ').trim()));
                });
            }
        } catch (_) {
            $('import-status').textContent = 'Could not read that file — JSON, TXT or MD only.';
            return;
        }
        const candidates = [...facts]
            .filter((s) => s.length >= 8 && s.length <= 400)
            .slice(0, 1200)
            .join('\n').slice(0, 50000);
        if (!candidates.trim()) {
            $('import-status').textContent = 'No usable text found in that export.';
            return;
        }
        $('import-status').textContent = 'Distilling facts… (this reads your export on our AI, nothing is stored)';
        try {
            const r = await fetch(`${API}/ask/memory/extract`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ digest: candidates })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) { $('import-status').textContent = data.message || 'Extraction failed.'; return; }
            importCandidates = (data.facts || []).slice(0, 50);
            renderPreview();
            $('import-status').textContent = `${importCandidates.length} candidate facts — untick anything you don't want.`;
            if (!importCandidates.length) $('import-status').textContent = 'Nothing durable enough to import was found in that export.';
        } catch (_) {
            $('import-status').textContent = 'Extraction failed — try again.';
        }
    });
    mountSettings();

    async function mountProfile() {
        try {
            const [sessionR, quotaR, creditsR, aiPaperR] = await Promise.all([
                fetch(`${API}/session`, { headers: auth }),
                fetch(`${API}/ai/chat/quota`, { headers: auth }),
                fetch(`${API}/credits`, { headers: auth }),
                // 403 for everyone else — one cheap JSON round-trip keeps the
                // beta's price line server-gated, not shipped-then-hidden.
                fetch(`${API}/ai-paper-portfolio`, { headers: auth })
            ]);
            const session = await sessionR.json().catch(() => ({}));
            const quota = await quotaR.json().catch(() => ({}));
            const credits = await creditsR.json().catch(() => ({}));
            const aiPaper = await aiPaperR.json().catch(() => ({}));
            aiPaperBeta = aiPaper.enabled === true;

            const section = $('plan-status');
            const nameEl = $('plan-name');
            const quotaEl = $('plan-quota');
            const includesEl = $('plan-includes');
            const upgradeEl = $('plan-upgrade');
            if (!section || !session.subscription) return;

            nameEl.textContent = session.subscription.planName || (session.tier === 'free' ? 'Free' : session.tier === 'core' ? 'Core' : 'Pro');
            if (session.subscription.status === 'trialing' && session.subscription.trialEndsAt) {
                const daysLeft = Math.max(0, Math.ceil((new Date(session.subscription.trialEndsAt) - Date.now()) / 86400000));
                nameEl.textContent = `${nameEl.textContent} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
                if (upgradeEl) {
                    upgradeEl.innerHTML = `Trial ends soon — <a href="/upgrade.html">choose a plan to keep Core →</a>`;
                    upgradeEl.hidden = false;
                }
            }
            // One meter, and it is the one the listing sells. A Tier 1 buyer wrote in
            // on 4 Sep — "on the profile usage page, it still says 0 / 30 Ask questions
            // used this month, which is why I was confused" — while his plan had just
            // moved to a 100-credit wallet. Fall back to the Ask counter only when an
            // older server doesn't return the credit block.
            const wallet = quota.credits;
            quotaEl.textContent = (wallet && Number.isFinite(wallet.allowance) && wallet.allowance > 0)
                ? `${wallet.used} / ${wallet.allowance} AI credits used this month`
                : (Number.isFinite(quota.limit) ? `${quota.used || 0} / ${quota.limit} Ask questions used this month` : '');
            // Lifetime tiers now include the Filing Change Monitor, capped to a
            // company count by tier; a monthly Pro subscription still does not.
            // The cap is resolved SERVER-side (lib/tier-limits.js monitorCapLabel)
            // and is cohort-aware, so a grandfathered buyer keeps their original
            // number. Do not recompute the ladder here: this line used to hardcode
            // 12/40/unlimited, which would have promised a post-cutover buyer more
            // than the product gives them. If an older deploy omits the label, say
            // nothing about the count rather than assert one that may be wrong.
            const ltd = quota.appsumo && quota.appsumo.isAppSumo;
            const monitorCap = (quota.appsumo && quota.appsumo.monitorCapLabel) || '';
            const monitorPhrase = monitorCap ? ` across ${monitorCap}` : '';
            includesEl.textContent = session.tier === 'pro'
                ? (ltd
                    ? `Includes Dossier, filing key points, reverse-DCF, screener & AI verdict, unlimited portfolio tracking, and the Filing Change Monitor${monitorPhrase} — with a weekly email when one of them files something that matters. Thesis Tracker and tax tools remain on Power/Desk.`
                    : 'Includes Dossier, filing key points, reverse-DCF, screener & AI verdict, and unlimited portfolio tracking. The Filing Change Monitor, Thesis Tracker and tax tools are on Power/Desk.')
                : session.tier === 'core'
                    ? 'Includes screener, comparison and portfolio tracking. Upgrade to Pro for Ask, Dossier and filing key points.'
                    : 'Upgrade for Ask, Dossier, screener and portfolio tracking.';
            if (quota.appsumo && quota.appsumo.isAppSumo) {
                upgradeEl.innerHTML = `Need more credits each month? <a href="${esc(quota.appsumo.upgradeUrl)}">Upgrade your AppSumo license →</a>`;
                upgradeEl.hidden = false;
            } else {
                upgradeEl.hidden = true;
            }
            section.hidden = false;

            // Owner-only surfaces (Admin row, customer-messages shortcut).
            // The markup ships hidden and is revealed strictly from the
            // authenticated session's email; every /admin/* page behind the
            // links re-checks the account server-side (customerMessagesAdminOnly
            // / marketingDashboardOnly in backend/app.js).
            const isOwner = String(((session.profile || {}).email) || '').trim().toLowerCase() === 'rin@gmail.com';
            const adminSection = $('admin-section');
            if (adminSection) adminSection.hidden = !isOwner;
            const msgAdminLink = $('messages-admin-link');
            if (msgAdminLink) msgAdminLink.hidden = !isOwner;

            mountCredits(credits);
        } catch (_) { /* profile card is non-blocking */ }
    }
    // messages.js writes into the thread while the section is collapsed
    // (scrollTop on a zero-height element is a no-op), so re-seat the newest
    // bubble once the section actually paints.
    const messagesDetails = $('messages-details');
    if (messagesDetails) {
        messagesDetails.addEventListener('toggle', () => {
            if (!messagesDetails.open) return;
            const msgList = $('message-list');
            if (msgList) msgList.scrollTop = msgList.scrollHeight;
        });
    }
    // /profile.html#admin-section and friends: a hash pointing at a section
    // opens it (:target needs no parsing, so a bogus hash just misses).
    const targetDetail = document.querySelector(':target');
    if (targetDetail && targetDetail.matches('details')) targetDetail.open = true;

    mountProfile();
})();
