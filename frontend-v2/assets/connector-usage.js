/* Connector usage on the profile page: this month's Claude / ChatGPT / API
   calls folded into sessions, the calls that were refused, the balance with a
   refill button beside it, and a CSV of the month. Data: /api/credits/connector.
   Standalone on purpose: it reads nothing from profile.js and draws only into
   #connector-usage, so either file can change without the other. */
(function () {
  'use strict';
  const root = document.getElementById('connector-usage');
  if (!root || !window.V2 || !window.V2.token || !window.V2.token()) return;
  if (root.dataset.wired === '1') return;
  root.dataset.wired = '1';

  const API = window.V2.API;
  const auth = () => ({ Authorization: `Bearer ${window.V2.token()}` });
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many}`;

  const TOOL_LABELS = {
    get_company_fundamentals: 'fundamentals',
    search_companies: 'company search',
    search_filings: 'filing search',
    get_filing: 'filing text',
    ask_filings: 'AI answer'
  };
  const toolLabel = (t) => TOOL_LABELS[t] || String(t || '').replace(/[-_]/g, ' ');

  // "8 Oct, 12:56 to 13:24" in the reader's own timezone; the end carries its
  // date only when the session ran past midnight.
  function when(startIso, endIso) {
    const s = new Date(startIso);
    const e = new Date(endIso);
    const day = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const time = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (time(s) === time(e) && day(s) === day(e)) return `${day(s)}, ${time(s)}`;
    return `${day(s)}, ${time(s)} to ${day(s) === day(e) ? '' : `${day(e)}, `}${time(e)}`;
  }

  // Every call in the session, in order: when, which tool, what about, what it
  // cost. This is the answer to "what did I use it for".
  function itemRows(s) {
    const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const rows = (s.items || []).map((it) => `<tr${it.refused ? ' class="cu-refused"' : ''}>`
      + `<td class="t">${esc(time(it.at))}</td>`
      + `<td class="k">${esc(toolLabel(it.tool))}</td>`
      + `<td class="s">${it.subject ? esc(it.subject) : '<span class="muted">not recorded</span>'}</td>`
      + `<td class="c">${it.refused ? `refused: ${esc(it.refused)}` : plural(it.credits, 'credit', 'credits')}</td></tr>`).join('');
    if (!rows) return '';
    const dropped = s.itemsDropped ? `<p class="small muted" style="margin:8px 0 0;">${plural(s.itemsDropped, 'more call is', 'more calls are')} in the CSV.</p>` : '';
    return `<div class="cu-items-wrap"><table class="cu-items">${rows}</table></div>${dropped}`;
  }

  function sessionRow(s, index) {
    const who = s.client || (s.via === 'api' ? 'API key' : 'AI assistant');
    const parts = [esc(who), esc(when(s.start, s.end))];
    if (s.calls) parts.push(plural(s.calls, 'call', 'calls'), plural(s.credits, 'credit', 'credits'));
    if (s.refused) parts.push(`<span class="cu-refused">${plural(s.refused, 'refused', 'refused')}</span>`);
    const tools = (s.tools || []).map((t) => `${num(t.count)} ${esc(toolLabel(t.tool))}`).join(', ');
    const refused = (s.refusedBy || []).map((r) => `${num(r.count)} refused: ${esc(r.label)}`).join('; ');
    const subjects = (s.subjects || []).map((x) => `<span class="cu-chip">${esc(x)}</span>`).join('');
    const body = [
      tools ? `<p class="small muted" style="margin:0 0 8px;">${tools}</p>` : '',
      refused ? `<p class="small cu-refused" style="margin:0 0 8px;">${refused}</p>` : '',
      subjects ? `<div class="cu-chips">${subjects}</div>` : '<p class="small muted" style="margin:0 0 4px;">These calls were made before the connector began recording what was asked for (8 Oct 2026), so only the tool and the time are known.</p>',
      itemRows(s)
    ].join('');
    // The newest session starts open: it is the one the reader came to check.
    return `<li><details${index === 0 ? ' open' : ''}><summary>${parts.join(' · ')}</summary><div class="cu-body">${body}</div></details></li>`;
  }

  function paceLine(d) {
    const p = d.pace;
    if (Number(d.remaining) <= 0) {
      return d.refused
        ? `You are out of credits and ${plural(d.refused, 'call was', 'calls were')} refused this month. A refill works the moment the payment settles.`
        : 'You are out of credits. A refill works the moment the payment settles.';
    }
    if (!p) return '';
    if (p.minutesLeft < 1) return 'At this pace your credits run out within the next minute.';
    return `At this pace, your credits last about ${plural(p.minutesLeft, 'more minute', 'more minutes')}.`;
  }

  // One sentence for an account on (or past) its free connector trial
  // (mcp-trial.js on the server): what is left, when it ends, and what comes
  // after. The only place on the page a trial account's connector status
  // appears.
  function trialLine(t) {
    if (!t || !t.started) return '';
    if (t.ended) {
      return 'Your free connector trial has ended and does not renew. It continues on the Monthly plan — <a rel="nofollow" href="/upgrade.html">see plans</a>.';
    }
    const ends = t.endsAt ? new Date(t.endsAt) : null;
    const when = ends && !Number.isNaN(ends.getTime())
      ? `, ${ends.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} (${plural(t.daysLeft, 'day', 'days')} left)`
      : '';
    return `Free trial: <strong>${t.lookupsLeft} of ${t.lookupsLimit} lookups</strong> and <strong>${t.asksLeft} of ${t.asksLimit} AI answers</strong> left${when}. After that the connector needs the Monthly plan.`;
  }

  function render(d) {
    if (!d) return;
    const trial = d.trial && d.trial.started ? d.trial : null;
    if (!(d.hasApiAccess || d.sessionCount > 0 || trial)) return;
    root.hidden = false;
    // A trial account has no wallet yet: the balance, the refill button and
    // the pace forecast speak to credits it does not have, so the trial line
    // carries the whole story instead.
    const walletless = Boolean(trial) && !d.hasApiAccess;
    const line = trialLine(trial);
    const trialEl = $('cu-trial');
    if (trialEl) {
      trialEl.innerHTML = line;
      trialEl.hidden = !line;
    }
    $('cu-meta').textContent = walletless
      ? `Free ${trial.days ? `${trial.days}-day ` : ''}trial`
      : (d.sessionCount
        ? `${plural(d.calls, 'call', 'calls')} · ${plural(d.credits, 'credit', 'credits')} this month${d.refused ? ` · ${num(d.refused)} refused` : ''}`
        : 'No calls this month');
    $('cu-balance').textContent = `${num(d.remaining)} of ${num(d.allowance)} credits left`;
    $('cu-balance').hidden = walletless;
    const refill = root.querySelector('a[href="/recharge.html"]');
    if (refill) refill.hidden = walletless;
    const pace = walletless ? '' : paceLine(d);
    $('cu-pace').textContent = pace;
    $('cu-pace').hidden = !pace;
    $('cu-pace').classList.toggle('cu-refused', !walletless && Number(d.remaining) <= 0);
    $('cu-sessions').innerHTML = (d.sessions || []).map(sessionRow).join('')
      || (walletless
        ? '<li class="small muted" style="padding:12px 14px;">Trial calls are counted by the trial line above, not itemised by session.</li>'
        : '<li class="small muted" style="padding:12px 14px;">Nothing yet. Calls made from Claude or ChatGPT will be listed here by session.</li>');
    const more = d.sessionCount - (d.sessions || []).length;
    $('cu-more').textContent = more > 0 ? `${plural(more, 'earlier session is', 'earlier sessions are')} in the CSV.` : '';
    $('cu-csv').hidden = !d.sessionCount;
  }

  $('cu-csv').addEventListener('click', async () => {
    const btn = $('cu-csv');
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/credits/connector.csv`, { headers: auth() });
      if (!r.ok) throw new Error('export failed');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = (r.headers.get('Content-Disposition') || '').replace(/^.*filename="?([^";]+)"?.*$/, '$1') || 'connector-calls.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (_) {
      $('cu-more').textContent = 'The CSV could not be downloaded. Please try again.';
    }
    btn.disabled = false;
  });

  fetch(`${API}/credits/connector`, { headers: auth() })
    .then((r) => (r.ok ? r.json() : null))
    .then(render)
    .catch(() => {});
})();
