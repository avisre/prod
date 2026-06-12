// Ask — the tool-grounded financial chatbot widget.
// Self-contained: builds its own DOM (launcher + panel), needs only
// css/ask.css and a logged-in token in localStorage. Drop into any page with:
//   <script src="js/ask.js" defer></script>
(function () {
    'use strict';

    function resolveApi() {
        if (typeof window.resolveApiUrl === 'function') return window.resolveApiUrl();
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return `${window.location.protocol}//${window.location.host}/api`;
        return 'https://stockportfolio.pro/api';
    }
    const API_URL = resolveApi();
    const token = () => localStorage.getItem('token');

    const TOOL_LABELS = {
        get_financials: (a) => `${(a.symbol || '').toUpperCase()} ${a.statement || ''} statements`,
        get_ratios_history: (a) => `${(a.symbol || '').toUpperCase()} ratio history`,
        get_health_checks: (a) => `${(a.symbol || '').toUpperCase()} health checks`,
        get_quote: (a) => `${(a.symbol || '').toUpperCase()} snapshot`,
        screen_universe: () => 'Screened 1,500 companies',
        get_portfolio: () => 'Your portfolio',
        calculator: () => 'Calculator'
    };

    const SUGGESTIONS = [
        'How has AAPL’s free cash flow trended over the last decade?',
        'Which companies grew revenue 10%+ a year with a 20%+ net margin?',
        'Is my portfolio concentrated in one sector?',
        'Run the health checks on AMZN and explain the failures.'
    ];

    // --- Minimal markdown renderer (bold/italic/code, headers, lists, tables) ---
    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function inline(s) {
        return s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    }
    function renderMarkdown(text) {
        const lines = esc(String(text || '')).split('\n');
        const out = [];
        let list = null; // 'ul' | 'ol'
        let i = 0;
        const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
        while (i < lines.length) {
            const line = lines[i];
            // table block
            if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
                closeList();
                const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()));
                out.push('<div class="ask-tablewrap"><table><thead><tr>');
                out.push(cells(line).map((c) => `<th>${c}</th>`).join(''));
                out.push('</tr></thead><tbody>');
                i += 2;
                while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                    out.push('<tr>' + cells(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>');
                    i++;
                }
                out.push('</tbody></table></div>');
                continue;
            }
            const h = line.match(/^(#{1,4})\s+(.*)$/);
            const ul = line.match(/^\s*[-*]\s+(.*)$/);
            const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (h) { closeList(); out.push(`<p class="ask-h">${inline(h[2])}</p>`); }
            else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); }
            else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); }
            else if (line.trim() === '') { closeList(); }
            else { closeList(); out.push(`<p>${inline(line)}</p>`); }
            i++;
        }
        closeList();
        return out.join('');
    }

    // --- DOM ---
    const root = document.createElement('div');
    root.id = 'askw-root';
    root.innerHTML = `
      <button type="button" id="askw-launcher" aria-label="Open Ask, the financial research assistant">
        <span class="ask-spark">✦</span> Ask
      </button>
      <div id="askw-panel" hidden>
        <div class="ask-head">
          <div>
            <span class="ask-title"><span class="ask-spark">✦</span> Ask</span>
            <span class="ask-sub">grounded in SEC filings</span>
          </div>
          <div class="ask-head-right">
            <span class="ask-quota" id="askw-quota"></span>
            <button type="button" class="ask-close" id="askw-close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="ask-msgs" id="askw-msgs">
          <div class="ask-msg ask-msg-ai">
            <div class="ask-bubble">Ask me about any US-listed company (all ~10,400 SEC registrants — not just the S&amp;P 1500) — statements back to ~2007, ratios, health checks, screener, or your own portfolio. Every number comes from filed data, never from AI memory.</div>
          </div>
          <div class="ask-suggestions" id="askw-suggestions"></div>
        </div>
        <form class="ask-inputrow" id="askw-form">
          <textarea id="askw-input" rows="1" maxlength="1000" placeholder="Ask a financial question…"></textarea>
          <button type="submit" id="askw-send" aria-label="Send">➤</button>
        </form>
      </div>`;
    document.body.appendChild(root);

    const $ = (id) => document.getElementById(id);
    const panel = $('askw-panel');
    const msgs = $('askw-msgs');
    const input = $('askw-input');
    const quotaEl = $('askw-quota');
    const history = [];
    let busy = false;

    SUGGESTIONS.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ask-suggestion';
        b.textContent = s;
        b.addEventListener('click', () => { input.value = s; input.focus(); autoGrow(); });
        $('askw-suggestions').appendChild(b);
    });

    function setQuota(q) {
        if (!q || !Number.isFinite(q.limit)) { quotaEl.textContent = ''; return; }
        quotaEl.textContent = `${Math.max(0, q.limit - q.used)} of ${q.limit} left this month`;
        quotaEl.classList.toggle('ask-quota-low', q.limit - q.used <= 1);
    }
    async function refreshQuota() {
        if (!token()) return;
        try {
            const r = await fetch(`${API_URL}/ai/chat/quota`, { headers: { Authorization: `Bearer ${token()}` } });
            if (r.ok) setQuota(await r.json());
        } catch (_) { /* quota badge is best-effort */ }
    }

    function addMsg(kind, html) {
        const wrap = document.createElement('div');
        wrap.className = `ask-msg ask-msg-${kind}`;
        wrap.innerHTML = `<div class="ask-bubble">${html}</div>`;
        msgs.appendChild(wrap);
        msgs.scrollTop = msgs.scrollHeight;
        return wrap;
    }
    function addChips(wrap, toolsUsed) {
        if (!Array.isArray(toolsUsed) || !toolsUsed.length) return;
        const seen = new Set();
        const row = document.createElement('div');
        row.className = 'ask-chips';
        toolsUsed.forEach((t) => {
            const fn = TOOL_LABELS[t.tool];
            const label = fn ? fn(t.args || {}) : t.tool;
            if (seen.has(label)) return;
            seen.add(label);
            const chip = document.createElement('span');
            chip.className = 'ask-chip' + (t.ok === false ? ' ask-chip-miss' : '');
            chip.textContent = label;
            row.appendChild(chip);
        });
        if (row.children.length) {
            const src = document.createElement('span');
            src.className = 'ask-chip-src';
            src.textContent = 'Sources:';
            row.insertBefore(src, row.firstChild);
            wrap.querySelector('.ask-bubble').appendChild(row);
        }
    }

    function finishAnswer(question, data) {
        const wrap = addMsg('ai', renderMarkdown(data.answer));
        addChips(wrap, data.toolsUsed);
        history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
        if (data.quota) setQuota(data.quota);
    }

    async function send(question) {
        if (busy) return;
        const sug = $('askw-suggestions');
        if (sug) sug.remove();
        addMsg('user', esc(question).replace(/\n/g, '<br>'));
        // Live bubble: tool-progress lines on top, streamed answer below,
        // typing dots while we wait. Replaced by the final render on 'done'.
        const live = addMsg('ai',
            '<div class="ask-steps"></div><div class="ask-stream"></div>' +
            '<div class="ask-working"><span class="ask-typing"><span></span><span></span><span></span></span> Researching…</div>');
        const steps = live.querySelector('.ask-steps');
        const streamEl = live.querySelector('.ask-stream');
        const workingEl = live.querySelector('.ask-working');
        busy = true;
        $('askw-send').disabled = true;
        try {
            const r = await fetch(`${API_URL}/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ question, history: history.slice(-8), stream: true })
            });
            const ct = r.headers.get('content-type') || '';
            if (!ct.includes('text/event-stream')) {
                // Auth/quota/legacy errors come back as plain JSON.
                const data = await r.json().catch(() => ({}));
                live.remove();
                if (r.status === 401) {
                    addMsg('ai', 'Please <a href="login.html">log in</a> to use Ask.');
                } else if (r.status === 429) {
                    if (data.quota) setQuota(data.quota);
                    const isPro = data.quota && data.quota.limit >= 300;
                    const nudgeHtml = `<div class="ask-limit-nudge">
<div class="ask-limit-preview"><div class="ask-limit-preview-inner">
Revenue grew 18% YoY to $12.4B in fiscal 2024, driven by cloud services (+34%). Net margin expanded to 22.1% from 19.8%. Free cash flow of $2.8B, covering capex 2.4×. P/E of 24× is below the sector median of 28×. Key risk: hardware segment declining 6% per quarter.
</div><div class="ask-limit-preview-label">Upgrade to see answers</div></div>
<div class="ask-limit-msg">You've used all ${data.quota ? data.quota.limit : ''} Ask questions this month.</div>
${isPro ? `<p style="color:var(--ask-muted);font-size:12px">Your Pro quota resets on the 1st.</p>` : `
<div class="ask-limit-plans">
<div class="ask-limit-plan"><b>Core — £9/mo</b><span>25 Ask questions/mo</span></div>
<div class="ask-limit-plan"><b>Pro — £25/mo</b><span>300 Ask questions/mo<br>+ AI summaries</span></div>
</div>
<a class="ask-limit-cta" href="register.html?plan=pro">Upgrade to Pro — 7 days free</a>`}
</div>`;
                    addMsg('ai', nudgeHtml);
                } else if (!r.ok || !data.answer) {
                    addMsg('ai', 'Something went wrong — please try again.');
                } else {
                    finishAnswer(question, data);
                }
                return;
            }

            let streamText = '';
            let finalData = null;
            const handle = (event, data) => {
                if (event === 'tool') {
                    const fn = TOOL_LABELS[data.tool];
                    const label = fn ? fn(data.args || {}) : data.tool;
                    if (![...steps.children].some((c) => c.textContent === label)) {
                        const d = document.createElement('div');
                        d.className = 'ask-step' + (data.ok === false ? ' ask-step-miss' : '');
                        d.textContent = label;
                        steps.appendChild(d);
                    }
                } else if (event === 'delta') {
                    streamText += data.text || '';
                    streamEl.innerHTML = renderMarkdown(streamText);
                    workingEl.style.display = 'none';
                } else if (event === 'rollback') {
                    streamText = '';
                    streamEl.innerHTML = '';
                    workingEl.style.display = '';
                } else if (event === 'done') {
                    finalData = data;
                }
                msgs.scrollTop = msgs.scrollHeight;
            };
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let sep;
                while ((sep = buf.indexOf('\n\n')) !== -1) {
                    const block = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    let ev = 'message'; let dataStr = '';
                    for (const ln of block.split('\n')) {
                        if (ln.startsWith('event:')) ev = ln.slice(6).trim();
                        else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
                    }
                    if (!dataStr) continue;
                    let parsed = {};
                    try { parsed = JSON.parse(dataStr); } catch (_) { continue; }
                    handle(ev, parsed);
                }
            }
            live.remove();
            if (finalData && finalData.answer) {
                finishAnswer(question, finalData);
            } else {
                addMsg('ai', 'Something went wrong — please try again.');
            }
        } catch (_) {
            live.remove();
            addMsg('ai', 'Network problem — please try again.');
        } finally {
            busy = false;
            $('askw-send').disabled = false;
            msgs.scrollTop = msgs.scrollHeight;
        }
    }

    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('askw-form').requestSubmit();
        }
    });
    $('askw-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        if (!token()) {
            addMsg('ai', 'Ask needs an account — <a href="login.html">log in</a> or <a href="register.html">start a 7-day free trial</a>. Core plans include 25 Ask questions a month; Pro includes 300.');
            return;
        }
        input.value = '';
        autoGrow();
        send(q);
    });

    $('askw-launcher').addEventListener('click', () => {
        const open = panel.hidden;
        panel.hidden = !open;
        if (open) { input.focus(); refreshQuota(); }
    });
    $('askw-close').addEventListener('click', () => { panel.hidden = true; });
})();
