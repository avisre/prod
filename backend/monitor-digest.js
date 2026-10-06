// Weekly Filing Monitor digest — "what changed in your watchlist this week".
//
// The retention engine for the Monitor plans: lifecycle email is the single
// biggest SaaS retention lever, and for a "never miss what changed" product
// the weekly digest IS the renewal mechanism. Power/Desk/enterprise and
// lifetime buyers are opted out by default; Pro Annual is opted IN explicitly
// (see digestOptInAt in app.js). For each subscriber's holdings + watchlist
// we build the Monitor report (cache-aware — only companies that filed in the
// last week make the cut), rank by materiality, and mail a cited summary with
// a deep link back into the app. Numbers come from filing-monitor; this only
// composes and addresses. Sending + scheduling live in app.js.

const filingMonitor = require('./filing-monitor');

const RECENT_DAYS = 8;     // only include companies that filed this past week
const MAX_SYMBOLS = 40;    // bound the per-user SEC/AI work
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function daysSince(dateStr) {
    const t = Date.parse(dateStr);
    return t ? (Date.now() - t) / 86400000 : Infinity;
}

// Build the "filed this week" item list for a set of symbols, ranked by materiality.
async function collectItems(symbols, { recentDays = RECENT_DAYS } = {}) {
    const syms = [...new Set((symbols || []).map((s) => String(s || '').toUpperCase().trim()).filter(Boolean))].slice(0, MAX_SYMBOLS);
    const items = [];
    for (const sym of syms) {
        let rep = null;
        try { rep = await filingMonitor.buildReport(sym); } catch (_) { rep = null; }
        if (rep && !rep.error) {
            const filed = rep.latestFiling && rep.latestFiling.date;
            if (filed && daysSince(filed) <= recentDays) {
                items.push({
                    symbol: sym,
                    materiality: rep.materiality || 0,
                    bucket: rep.materialityBucket || 'low',
                    summary: rep.summary || '',
                    filing: rep.latestFiling || null
                });
            }
        }
        await sleep(150); // SEC fair-use pacing
    }
    return items.sort((a, b) => b.materiality - a.materiality);
}

function renderEmail(name, items, appUrl, unsubUrl) {
    const base = String(appUrl || 'https://stockportfolio.pro').replace(/\/$/, '');
    const rows = items.map((it) => `
      <div style="padding:2px 0;margin:0 0 18px">
        <div style="font-size:15px;font-weight:700;color:#1c1b18">${esc(it.symbol)}
          <span style="font-weight:500;color:#726e65">· ${esc((it.filing && it.filing.label) || '')} ${esc((it.filing && it.filing.date) || '')} · materiality ${esc(String(it.materiality))}</span>
        </div>
        <div style="font-size:14px;line-height:1.6;color:#45423c;margin-top:4px">${esc(it.summary)}</div>
        <a href="${base}/monitor?symbol=${encodeURIComponent(it.symbol)}" style="font-size:13px;color:#1c1b18;text-decoration:underline">Read the full filing report →</a>
      </div>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1c1b18">
      <h1 style="font-size:20px;margin:0 0 6px">What changed in your watchlist this week</h1>
      <p style="font-size:14px;color:#726e65;margin:0 0 20px">${items.length} compan${items.length === 1 ? 'y' : 'ies'} filed — read for you, every figure taken from the filing.</p>
      ${rows}
      <p style="font-size:12px;color:#a09c93;line-height:1.6;margin-top:24px;border-top:1px solid #e8e6e0;padding-top:12px">
        You're receiving this because the Filing Monitor is active on your account. Educational, not investment advice.<br/>
        <a href="${esc(unsubUrl)}" style="color:#a09c93">Unsubscribe from these digests</a>
      </p>
    </div>`;
    const text = `What changed in your watchlist this week\n\n`
        + items.map((it) => `${it.symbol} — ${(it.filing && it.filing.label) || ''} ${(it.filing && it.filing.date) || ''} (materiality ${it.materiality})\n${it.summary}\n${base}/monitor?symbol=${it.symbol}\n`).join('\n')
        + `\n—\nYou're receiving this because the Filing Monitor is active on your account. Not investment advice.\nUnsubscribe: ${unsubUrl}`;
    return { html, text };
}

// Returns { subject, html, text, count } or null when nothing material filed.
async function buildUserDigest(user, { appUrl, unsubUrl, symbols, recentDays } = {}) {
    const items = await collectItems(symbols, { recentDays });
    if (!items.length) return null;
    const top = items[0];
    const subject = items.length === 1
        ? `${top.symbol} just filed — what changed`
        : `${items.length} of your watchlist filed this week — what changed`;
    const { html, text } = renderEmail(user && user.name, items, appUrl, unsubUrl);
    return { subject, html, text, count: items.length };
}

module.exports = { collectItems, buildUserDigest, renderEmail };
