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
        get_fund_profile: (a) => `${(a.symbol || '').toUpperCase()} fund profile`,
        rank_funds: (a) => `Ranked ${a.asset_type === 'etf' ? 'ETFs' : a.asset_type === 'mutual_fund' ? 'mutual funds' : 'ETFs and mutual funds'}`,
        screen_universe: () => 'Screened 1,500 companies',
        get_portfolio: () => 'Your portfolio',
        calculator: () => 'Calculator'
    };

    const SUGGESTIONS = [
        'How has AAPL’s free cash flow trended over the last decade?',
        'What are the top 3 ETFs and mutual funds over 3 months, 1 year and 3 years?',
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

    // Shared controls used by Ask, AI summaries and portfolio briefings. The
    // generated text is placed in the social post/copy buffer, never in a URL.
    if (!window.AIShare) {
        const excerpt = (value, max = 240) => {
            const clean = String(value || '').replace(/\s+/g, ' ').trim();
            return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
        };
        const openShare = (url) => window.open(url, '_blank', 'noopener,noreferrer,width=760,height=620');
        const copyText = async (value) => {
            if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value);
            window.prompt('Copy this AI-generated content', value);
        };
        window.AIShare = {
            mount(container, options = {}) {
                if (!container) return;
                const title = String(options.title || 'stockportfolio.pro AI insight').trim();
                const body = String(options.text || '').trim();
                if (!body) { container.hidden = true; container.innerHTML = ''; return; }
                const pageUrl = String(options.url || window.location.href);
                const shortPost = `${title}\n\n${excerpt(body)}\n\n${pageUrl}`;
                const fullPost = `${title}\n\n${body}\n\n${pageUrl}`;
                container.hidden = false;
                container.innerHTML = '<div class="ai-share"><span class="ai-share-label">Share</span></div>';
                const row = container.firstElementChild;
                const add = (label, action, className = '') => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `ai-share-btn ${className}`.trim();
                    button.textContent = label;
                    button.addEventListener('click', action);
                    row.appendChild(button);
                    return button;
                };
                if (navigator.share) {
                    add('Share…', () => navigator.share({ title, text: body, url: pageUrl }).catch(() => {}), 'ai-share-native');
                }
                add('X / Twitter', () => openShare(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shortPost)}`));
                add('LinkedIn', () => openShare(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}&summary=${encodeURIComponent(excerpt(body, 500))}`));
                add('Facebook', () => openShare(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}&quote=${encodeURIComponent(excerpt(body, 500))}`));
                add('WhatsApp', () => openShare(`https://wa.me/?text=${encodeURIComponent(fullPost.slice(0, 3500))}`));
                const copy = add('Copy', async () => {
                    try {
                        await copyText(fullPost);
                        copy.textContent = 'Copied';
                        window.setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
                    } catch (_) { /* clipboard denied */ }
                });
            }
        };
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
        <div class="ask-msgs" id="askw-msgs" role="log" aria-live="polite" aria-label="Conversation">
          <div class="ask-msg ask-msg-ai">
            <div class="ask-bubble">Ask me about US-listed companies, ETFs, ticker-addressable US mutual funds, or your own portfolio. Company figures come from filed data; fund answers cover costs, holdings, allocation, returns and risk. Every number comes from a retrieved source, never AI memory.</div>
          </div>
        </div>
        <details class="ask-help" id="askw-help" open>
          <summary>What can I ask?</summary>
          <div class="ask-suggestions" id="askw-suggestions"></div>
          <p class="ask-help-hint">Ask reads filed financials, ratio history, health checks, fund data and your own portfolio — then shows you which of those it opened. Shift+Enter for a new line.</p>
        </details>
        <form class="ask-inputrow" id="askw-form">
          <textarea id="askw-input" rows="1" maxlength="8000" placeholder="Ask a financial question…"></textarea>
          <button type="submit" id="askw-send" aria-label="Send" title="Send">➤</button>
        </form>
      </div>`;
    document.body.appendChild(root);

    const $ = (id) => document.getElementById(id);
    const panel = $('askw-panel');
    const msgs = $('askw-msgs');
    const input = $('askw-input');
    const quotaEl = $('askw-quota');
    const history = [];
    const TRACE_PREF = 'ask_trace_open';
    let busy = false;
    let controller = null;   // aborts the in-flight turn when the user hits Stop

    // The send button doubles as the stop button: an agentic turn can run for
    // several seconds, so there is always a visible way out of it.
    function setBusy(state) {
        busy = state;
        const btn = $('askw-send');
        btn.classList.toggle('ask-send-stop', state);
        btn.textContent = state ? '◼' : '➤';
        btn.setAttribute('aria-label', state ? 'Stop generating' : 'Send');
        btn.title = state ? 'Stop generating' : 'Send';
    }

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

    // Renders the finished answer into the bubble that has been streaming all
    // along instead of tearing it down and adding a new one, so the reader
    // never sees a flash or a scroll jump at the moment the answer lands.
    function finishAnswer(question, data, wrap) {
        const target = wrap || addMsg('ai', '<div class="ask-stream"></div>');
        const status = target.querySelector('.ask-status');
        if (status) status.remove();
        target.querySelector('.ask-stream').innerHTML = renderMarkdown(data.answer);
        addChips(target, data.toolsUsed);
        const share = document.createElement('div');
        share.className = 'ai-share-slot';
        target.querySelector('.ask-bubble').appendChild(share);
        window.AIShare.mount(share, { title: `Ask: ${question}`, text: data.answer });
        history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
        if (data.quota) setQuota(data.quota);
    }

    // Every dead end names its cause and offers one click back, so a failed or
    // stopped turn never costs the user the question they typed.
    function addFailure(wrap, message, question, soft) {
        const target = wrap || addMsg('ai', '');
        const status = target.querySelector('.ask-status');
        if (status) status.remove();
        const box = document.createElement('div');
        box.className = 'ask-failure' + (soft ? ' ask-failure-soft' : '');
        const text = document.createElement('span');
        text.textContent = message;
        box.appendChild(text);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ask-retry';
        retry.textContent = '↻ Retry';
        retry.addEventListener('click', () => {
            const spent = box.closest('.ask-msg');
            box.remove();
            // Drop the spent bubble unless it still holds partial text worth keeping.
            const partial = spent && spent.querySelector('.ask-stream');
            if (spent && (!partial || !partial.textContent.trim())) spent.remove();
            send(question);
        });
        box.appendChild(retry);
        target.querySelector('.ask-bubble').appendChild(box);
        msgs.scrollTop = msgs.scrollHeight;
    }

    async function send(question) {
        if (busy) return;
        const help = $('askw-help');
        if (help) help.open = false;
        addMsg('user', esc(question).replace(/\n/g, '<br>'));

        // One live bubble for the whole turn. The research trace is open while
        // the model works, folds into a summary row the moment the first token
        // lands, and stays there afterwards as provenance the reader can reopen.
        const live = addMsg('ai',
            '<div class="ask-trace" hidden>' +
              '<button type="button" class="ask-trace-toggle" aria-expanded="true">' +
                '<span class="ask-trace-caret" aria-hidden="true">▾</span>' +
                '<span class="ask-typing ask-trace-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
                '<span class="ask-trace-label">Researching…</span>' +
              '</button>' +
              '<div class="ask-trace-steps"></div>' +
            '</div>' +
            '<div class="ask-status" role="status" aria-live="polite">' +
              '<span class="ask-typing" aria-hidden="true"><span></span><span></span><span></span></span>' +
              '<span class="ask-status-text">Researching…</span>' +
            '</div>' +
            '<div class="ask-stream"></div>');
        const trace = live.querySelector('.ask-trace');
        const traceToggle = live.querySelector('.ask-trace-toggle');
        const traceLabel = live.querySelector('.ask-trace-label');
        const traceCaret = live.querySelector('.ask-trace-caret');
        const steps = live.querySelector('.ask-trace-steps');
        const streamEl = live.querySelector('.ask-stream');
        const statusEl = live.querySelector('.ask-status');
        const statusText = live.querySelector('.ask-status-text');

        const setTraceOpen = (open) => {
            trace.dataset.open = open ? 'true' : 'false';
            traceToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            traceCaret.textContent = open ? '▾' : '▸';
        };
        setTraceOpen(true);
        const setWorking = (on) => { trace.dataset.working = on ? 'true' : 'false'; };
        setWorking(true);
        traceToggle.addEventListener('click', () => {
            const open = trace.dataset.open !== 'true';
            setTraceOpen(open);
            try { localStorage.setItem(TRACE_PREF, open ? '1' : '0'); } catch (_) { /* private mode */ }
        });

        const t0 = Date.now();
        let stepCount = 0;
        let folded = false;
        // Readers who last left the trace open get it back open; everyone else
        // gets the calm one-line summary.
        const foldTrace = () => {
            if (folded) return;
            folded = true;
            if (!stepCount) { trace.hidden = true; return; }
            const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
            setWorking(false);
            traceLabel.textContent = `Checked ${stepCount} source${stepCount === 1 ? '' : 's'} · ${secs}s`;
            let pref = '0';
            try { pref = localStorage.getItem(TRACE_PREF) || '0'; } catch (_) { /* private mode */ }
            setTraceOpen(pref === '1');
        };

        setBusy(true);
        controller = new AbortController();
        let streamText = '';
        try {
            const r = await fetch(`${API_URL}/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ question, history: history.slice(-8), stream: true }),
                signal: controller.signal
            });
            const ct = r.headers.get('content-type') || '';
            if (!ct.includes('text/event-stream')) {
                // Auth/quota/legacy errors come back as plain JSON.
                const data = await r.json().catch(() => ({}));
                if (r.status === 401) {
                    live.remove();
                    addMsg('ai', 'Please <a href="login.html">log in</a> to use Ask.');
                } else if (r.status === 429) {
                    live.remove();
                    if (data.quota) setQuota(data.quota);
                    const isPro = data.quota && data.quota.limit >= 300;
                    const nudgeHtml = `<div class="ask-limit-nudge">
<div class="ask-limit-preview"><div class="ask-limit-preview-inner">
Revenue grew 18% YoY to $12.4B in fiscal 2024, driven by cloud services (+34%). Net margin expanded to 22.1% from 19.8%. Free cash flow of $2.8B, covering capex 2.4×. P/E of 24× is below the sector median of 28×. Key risk: hardware segment declining 6% per quarter.
</div><div class="ask-limit-preview-label">Upgrade to see answers</div></div>
<div class="ask-limit-msg">You've used all ${data.quota ? data.quota.limit : ''} Ask questions this month.</div>
${isPro ? `<p style="color:var(--ask-muted);font-size:12px">Your Pro quota resets on the 1st.</p>` : `
<div class="ask-limit-plans">
<div class="ask-limit-plan"><b>Core — $12/mo</b><span>25 Ask questions/mo</span></div>
<div class="ask-limit-plan"><b>Pro — $33/mo</b><span>300 Ask questions/mo<br>+ AI summaries</span></div>
</div>
<a class="ask-limit-cta" href="register.html?plan=pro">Upgrade to Pro — 7 days free</a>`}
</div>`;
                    addMsg('ai', nudgeHtml);
                } else if (!r.ok || !data.answer) {
                    addFailure(live, r.status >= 500
                        ? 'Ask’s server had a problem answering that.'
                        : r.status === 408 || r.status === 504
                            ? 'That question took too long and timed out.'
                            : 'That request didn’t go through.', question);
                } else {
                    finishAnswer(question, data, live);
                }
                return;
            }

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
                        stepCount += 1;
                        trace.hidden = false;
                        steps.scrollTop = steps.scrollHeight;
                        // The trace row now carries the working signal itself.
                        statusEl.hidden = true;
                    }
                } else if (event === 'delta') {
                    streamText += data.text || '';
                    streamEl.innerHTML = renderMarkdown(streamText);
                    statusEl.hidden = true;
                    foldTrace();
                } else if (event === 'rollback') {
                    // Text disappearing is the most alarming thing a chat UI can
                    // do, so say why rather than blanking the bubble.
                    streamText = '';
                    streamEl.innerHTML = '';
                    folded = false;
                    setWorking(true);
                    if (trace.hidden) {
                        statusEl.hidden = false;
                        statusText.textContent = 'Rechecking the numbers…';
                    } else {
                        traceLabel.textContent = 'Rechecking the numbers…';
                        setTraceOpen(true);
                    }
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
            foldTrace();
            if (finalData && finalData.answer) {
                finishAnswer(question, finalData, live);
            } else {
                addFailure(live, 'The answer was cut off before it finished.', question);
            }
        } catch (e) {
            foldTrace();
            if (e && e.name === 'AbortError') {
                // Stopping is a choice, not a failure: keep what arrived.
                addFailure(live, streamText
                    ? 'Stopped — the answer above is incomplete.'
                    : 'Stopped before the answer started.', question, true);
            } else {
                addFailure(live, 'Couldn’t reach the server — check your connection.', question);
            }
        } finally {
            setBusy(false);
            controller = null;
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
        // While a turn is running the same button is the emergency exit.
        if (busy) { if (controller) controller.abort(); return; }
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
