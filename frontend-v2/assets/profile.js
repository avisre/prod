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

    // ---- Settings card: Ask memory (saved facts) + import from another
    // provider's export. All routes are owner-scoped; the toggle only gates
    // the assistant's automatic saves, the list is editable regardless. ----
    let memoryFacts = [];
    function renderFacts() {
        const list = $('mem-list');
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
