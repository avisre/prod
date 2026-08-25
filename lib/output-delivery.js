'use strict';

// Shared output primitive — "render a report as an email-ready HTML block".
//
// Three features need the same thing and must never drift apart: the Monitor
// trial-expiry email (proof of what the user actually built), the weekly
// pre-rendered Monitor digest, and any manual one-off send. So the rendering
// lives here once, and it REUSES the existing report generation rather than
// reimplementing it:
//
//   filing-diff           -> backend/filing-monitor.js buildReport/peekReport
//                            (the cached `filing_reports` collection — same
//                            payload the /monitor page renders)
//   fundamentals-snapshot -> backend/ai-chat.js metricsFor() (the screen index
//                            built from the filed XBRL panel; sync, no network)
//   thesis-brief          -> both of the above, composed
//
// Nothing here fetches on its own and nothing here sends: callers pass symbols,
// this returns { html, text }. Sending stays in the jobs that own the decision.

const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
const filingMonitor = require(path.join(BACKEND, 'filing-monitor'));
const aiChat = require(path.join(BACKEND, 'ai-chat'));

const TYPES = ['filing-diff', 'fundamentals-snapshot', 'thesis-brief'];
const MAX_SYMBOLS = 40;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normalizeSymbols(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
    return [...new Set(list.map((s) => String(s || '').toUpperCase().trim()).filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s)))].slice(0, MAX_SYMBOLS);
}

function baseUrl(appUrl) {
    return String(appUrl || process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
}

const fmtB = (n) => (Number.isFinite(n) ? (n >= 1000 ? `$${(n / 1000).toFixed(2)}T` : `$${n.toFixed(1)}B`) : '—');
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const fmtNum = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');

// ---- section builders (one per symbol) ----------------------------------

// The cached filing-change report. cachedOnly keeps a bulk job off the SEC/AI
// path entirely: a digest should mail what's already been paid for, never
// trigger 40 fresh builds.
async function filingDiffSection(symbol, { cachedOnly }) {
    let rep = null;
    try {
        rep = cachedOnly ? await filingMonitor.peekReport(symbol) : await filingMonitor.buildReport(symbol);
    } catch (_) { rep = null; }
    if (!rep || rep.error) return null;
    return {
        symbol,
        kind: 'filing-diff',
        headline: (rep.narrative && rep.narrative.headline) || rep.summary || '',
        summary: rep.summaryPlain || rep.summary || '',
        materiality: rep.materiality ?? null,
        bucket: rep.materialityBucket || null,
        filing: rep.latestFiling || null,
        // accession of the filing this report is keyed on — the dedupe key
        // ingredient for "never send the same filing-change twice".
        accession: (rep.periodic && rep.periodic.accession) || null,
        deltas: (rep.deltas || []).slice(0, 6),
        changes: ((rep.narrative && rep.narrative.changes) || []).slice(0, 5),
        note: rep.note || ''
    };
}

function fundamentalsSection(symbol) {
    const m = aiChat.metricsFor(symbol);
    if (!m) return null;
    return {
        symbol,
        kind: 'fundamentals-snapshot',
        name: m.name || symbol,
        asOf: m.latestFiscalYearEnd || m.latestQuarterEnd || null,
        rows: [
            ['Market cap', fmtB(m.marketCapB)],
            ['P/E', fmtNum(m.pe)],
            ['Net margin', fmtPct(m.netMarginPct)],
            ['Return on equity', fmtPct(m.roePct)],
            ['Revenue CAGR (5y)', fmtPct(m.revCagr5Pct)],
            ['Dividend yield', fmtPct(m.divYieldPct)]
        ],
        note: 'Figures computed from the company\'s filed annual and quarterly statements.'
    };
}

async function thesisSection(symbol, opts) {
    const [diff, fund] = [await filingDiffSection(symbol, opts), fundamentalsSection(symbol)];
    if (!diff && !fund) return null;
    return { symbol, kind: 'thesis-brief', diff, fund };
}

// ---- rendering ----------------------------------------------------------

function renderFilingDiff(s, base) {
    const deltas = s.deltas.length ? `<table style="border-collapse:collapse;margin:10px 0;font-size:13px">${s.deltas.map((d) => `
        <tr><td style="padding:3px 14px 3px 0;color:#64748b">${esc(d.label)}</td>
            <td style="padding:3px 14px 3px 0;color:#0f172a">${esc(d.latest)}</td>
            <td style="padding:3px 0;color:${d.direction === 'up' ? '#15803d' : d.direction === 'down' ? '#b91c1c' : '#64748b'}">${esc(d.change)}</td></tr>`).join('')}</table>` : '';
    const changes = s.changes.length ? `<ul style="margin:8px 0;padding-left:18px;font-size:13px;line-height:1.6;color:#334155">${s.changes.map((c) => `<li><strong>${esc(c.area)}:</strong> ${esc(c.what)}${c.quote ? ` <em style="color:#64748b">“${esc(c.quote)}”</em>` : ''}</li>`).join('')}</ul>` : '';
    const f = s.filing || {};
    return `<div style="padding:2px 0;margin:0 0 22px">
      <div style="font-size:15px;font-weight:700;color:#0f172a">${esc(s.symbol)}
        <span style="font-weight:500;color:#64748b">· ${esc(f.label || f.form || '')} ${esc(f.date || '')}${s.materiality !== null ? ` · materiality ${esc(String(s.materiality))}` : ''}</span>
      </div>
      ${s.headline ? `<div style="font-size:14px;line-height:1.6;color:#0f172a;margin-top:4px">${esc(s.headline)}</div>` : ''}
      ${deltas}${changes}
      <a href="${base}/monitor?symbol=${encodeURIComponent(s.symbol)}" style="font-size:13px;color:#1a4fd6;text-decoration:none">Read the full filing report →</a>
      ${f.url ? ` <a href="${esc(f.url)}" style="font-size:13px;color:#64748b;text-decoration:none">Source filing on SEC EDGAR →</a>` : ''}
    </div>`;
}

function renderFundamentals(s, base) {
    return `<div style="padding:2px 0;margin:0 0 22px">
      <div style="font-size:15px;font-weight:700;color:#0f172a">${esc(s.symbol)}
        <span style="font-weight:500;color:#64748b">· ${esc(s.name)}${s.asOf ? ` · as filed ${esc(s.asOf)}` : ''}</span>
      </div>
      <table style="border-collapse:collapse;margin:8px 0;font-size:13px">${s.rows.map(([k, v]) => `
        <tr><td style="padding:3px 16px 3px 0;color:#64748b">${esc(k)}</td><td style="padding:3px 0;color:#0f172a">${esc(v)}</td></tr>`).join('')}</table>
      <a href="${base}/stocks?symbol=${encodeURIComponent(s.symbol)}" style="font-size:13px;color:#1a4fd6;text-decoration:none">Open the full fundamentals →</a>
    </div>`;
}

function renderSection(s, base) {
    if (s.kind === 'filing-diff') return renderFilingDiff(s, base);
    if (s.kind === 'fundamentals-snapshot') return renderFundamentals(s, base);
    return `<div style="margin:0 0 26px">${s.diff ? renderFilingDiff(s.diff, base) : ''}${s.fund ? renderFundamentals(s.fund, base) : ''}</div>`;
}

function textSection(s, base) {
    if (s.kind === 'filing-diff') {
        const f = s.filing || {};
        return [`${s.symbol} — ${f.label || f.form || ''} ${f.date || ''}${s.materiality !== null ? ` (materiality ${s.materiality})` : ''}`,
            s.headline, ...s.deltas.map((d) => `  ${d.label}: ${d.latest} (${d.change})`),
            ...s.changes.map((c) => `  ${c.area}: ${c.what}`),
            `  ${base}/monitor?symbol=${s.symbol}`, f.url ? `  Source: ${f.url}` : ''].filter(Boolean).join('\n');
    }
    if (s.kind === 'fundamentals-snapshot') {
        return [`${s.symbol} — ${s.name}${s.asOf ? ` (as filed ${s.asOf})` : ''}`,
            ...s.rows.map(([k, v]) => `  ${k}: ${v}`), `  ${base}/stocks?symbol=${s.symbol}`].join('\n');
    }
    return [s.diff ? textSection(s.diff, base) : '', s.fund ? textSection(s.fund, base) : ''].filter(Boolean).join('\n');
}

// ---- public API ---------------------------------------------------------

/**
 * Render an email-ready block for one ticker or a list.
 *
 * @param {string|string[]} tickers
 * @param {'filing-diff'|'fundamentals-snapshot'|'thesis-brief'} type
 * @param {{ cachedOnly?: boolean, appUrl?: string, heading?: string }} [opts]
 * @returns {Promise<{type,symbols,sections,html,text,count}>} `count` is 0 when
 *          nothing rendered — callers should treat that as "nothing to send".
 */
async function renderBlock(tickers, type, opts = {}) {
    if (!TYPES.includes(type)) throw new Error(`Unknown report type: ${type}`);
    const symbols = normalizeSymbols(tickers);
    const base = baseUrl(opts.appUrl);
    const cachedOnly = opts.cachedOnly !== false; // safe default: never trigger builds
    const sections = [];
    for (const sym of symbols) {
        let s = null;
        if (type === 'filing-diff') s = await filingDiffSection(sym, { cachedOnly });
        else if (type === 'fundamentals-snapshot') s = fundamentalsSection(sym);
        else s = await thesisSection(sym, { cachedOnly });
        if (s) sections.push(s);
    }
    const heading = opts.heading || '';
    const html = sections.length
        ? `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a">`
          + (heading ? `<h2 style="font-size:18px;margin:0 0 14px">${esc(heading)}</h2>` : '')
          + sections.map((s) => renderSection(s, base)).join('')
          + `</div>`
        : '';
    const text = sections.length
        ? (heading ? `${heading}\n\n` : '') + sections.map((s) => textSection(s, base)).join('\n\n')
        : '';
    return { type, symbols, sections, html, text, count: sections.length };
}

module.exports = { renderBlock, normalizeSymbols, TYPES };
