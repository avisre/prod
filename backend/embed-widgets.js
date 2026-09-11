'use strict';

// Embeddable widgets — /embed/earnings-quality and /embed/filing-timeline.
//
// A blogger drops one <iframe> on their page and gets a filing-grounded card:
// server-rendered, so it shows data on first paint with no client fetch and no
// JavaScript at all, and self-contained, so it pulls no CSS or JS from
// /assets/ — which matters beyond tidiness: any widget that referenced those
// files would join the ?v= cache-stamp cascade, where a missed bump ships a
// stale bundle for up to a year.
//
// The badge is the product. Every card, including every error card, links back
// to the company page with the embed UTM, because the widget's job is to be the
// thing a reader clicks when they want the rest of the filing.

const freeTools = require('./free-tools');
const { EMBED_CSP, badgeHref, widgetDefinition } = require('./embed-config');

const MAX_FILINGS = 8;

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Filing figures are large and exact; compact them the way the card has room
// for, and keep the exact number in the title attribute so a reader who hovers
// (or a screen reader) still gets the filed value.
function compactUsd(value) {
    if (value == null || !Number.isFinite(Number(value))) return { text: '—', exact: null };
    const n = Number(value);
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    let text;
    if (abs >= 1e12) text = `${sign}$${(abs / 1e12).toFixed(2)}T`;
    else if (abs >= 1e9) text = `${sign}$${(abs / 1e9).toFixed(2)}B`;
    else if (abs >= 1e6) text = `${sign}$${(abs / 1e6).toFixed(1)}M`;
    else text = `${sign}$${abs.toLocaleString('en-US')}`;
    return { text, exact: `${sign}$${abs.toLocaleString('en-US')}` };
}

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f8fafc;color:#0f172a;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{padding:12px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;max-width:640px}
.head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:14px 16px 0}
.sym{font-size:19px;font-weight:700;letter-spacing:-.01em}
.kicker{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:600}
.period{margin-left:auto;font-size:12.5px;color:#64748b}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:#e2e8f0;border-top:1px solid #e2e8f0;margin-top:12px}
.cell{background:#fff;padding:11px 14px}
.cell span{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;font-weight:600}
.cell strong{display:block;font-size:18px;font-variant-numeric:tabular-nums;margin-top:3px}
.verdict{padding:11px 16px;font-size:13.5px;color:#334155;border-top:1px solid #e2e8f0;background:#f8fafc}
table{border-collapse:collapse;width:100%;margin-top:12px;border-top:1px solid #e2e8f0}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid #eef2f7;font-size:13.5px;vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;font-weight:600}
td a{color:#1d4ed8;text-decoration:none;font-weight:600}
td a:hover{text-decoration:underline}
.note{padding:10px 16px;font-size:12.5px;color:#64748b}
.foot{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:12.5px}
.foot a{color:#1d4ed8;text-decoration:none;font-weight:600}
.foot a:hover{text-decoration:underline}
.foot .dot{width:6px;height:6px;border-radius:50%;background:#16a34a;flex:none}
.err{padding:16px;font-size:14px;color:#b91c1c}
.err a{color:#1d4ed8}
`.trim();

function shell(bodyHtml) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StockPortfolio.pro widget</title>
<style>${CSS}</style></head>
<body><div class="wrap"><div class="card">${bodyHtml}</div></div></body></html>`;
}

function foot(widget, symbol) {
    return `<div class="foot"><span class="dot"></span><span>Every value from an SEC filing.</span>
<a href="${esc(badgeHref(widget, symbol))}" target="_blank" rel="noopener">Powered by StockPortfolio.pro &rarr;</a></div>`;
}

function errorCard(widget, symbol, message) {
    return shell(`<div class="err">${esc(message)}</div>${foot(widget, symbol)}`);
}

function cells(pairs) {
    return `<div class="grid">${pairs.map(([label, formatted]) => {
        const title = formatted.exact ? ` title="${esc(formatted.exact)}"` : '';
        return `<div class="cell"><span>${esc(label)}</span><strong${title}>${esc(formatted.text)}</strong></div>`;
    }).join('')}</div>`;
}

function earningsCard(widget, body) {
    const symbol = body.symbol;
    const period = body.period || body.cashFlowPeriod || null;
    const conversion = Number.isFinite(Number(body.cashConversionRatio)) ? Number(body.cashConversionRatio) : null;
    const metrics = [
        ['Revenue', compactUsd(body.revenue)],
        ['Net income', compactUsd(body.netIncome)],
        ['Operating cash flow', compactUsd(body.operatingCashFlow)],
        ['Free cash flow', compactUsd(body.freeCashFlow)],
        ['Cash conversion', {
            text: conversion == null ? '—' : `${(conversion * 100).toFixed(0)}%`,
            exact: conversion == null ? null : `${conversion.toFixed(4)}x operating cash flow / net income`
        }]
    ];
    // Say what the ratio is, not what to do about it: this is a filed-figure
    // card, and the note below it says so.
    const verdict = conversion == null
        ? 'The cash-flow period was not comparable to the income period, so conversion is not shown.'
        : `Operating cash flow covered ${(conversion * 100).toFixed(0)}% of net income for the same filed period.`;
    const source = body.sourceUrl
        ? `<div class="note">Source: <a href="${esc(body.sourceUrl)}" target="_blank" rel="noopener nofollow">SEC EDGAR</a> · informational research, not investment advice.</div>`
        : '<div class="note">Informational research, not investment advice.</div>';
    return shell(
        `<div class="head"><span class="sym">${esc(symbol)}</span><span class="kicker">Earnings quality</span>`
        + `<span class="period">Filed period ${esc(period || '—')}</span></div>`
        + cells(metrics)
        + `<div class="verdict">${esc(verdict)}</div>`
        + source
        + foot(widget, symbol)
    );
}

function timelineCard(widget, body) {
    const symbol = body.symbol;
    const filings = Array.isArray(body.filings) ? body.filings.slice(0, MAX_FILINGS) : [];
    if (!filings.length) return errorCard(widget, symbol, `No recent SEC filings found for ${symbol}.`);
    const rows = filings.map((filing) => `<tr>
<td>${esc(filing.date || '—')}</td>
<td>${esc(filing.label || filing.form || '—')}</td>
<td><a href="${esc(filing.url)}" target="_blank" rel="noopener nofollow">Open filing</a></td>
</tr>`).join('');
    return shell(
        `<div class="head"><span class="sym">${esc(symbol)}</span><span class="kicker">SEC filing timeline</span>`
        + `<span class="period">${filings.length} most recent</span></div>`
        + `<table><thead><tr><th>Date</th><th>Form</th><th>Primary source</th></tr></thead><tbody>${rows}</tbody></table>`
        + '<div class="note">Each row links to the filing at sec.gov. Informational research, not investment advice.</div>'
        + foot(widget, symbol)
    );
}

// Returns { status, html }. Data errors keep the upstream status so a caller
// embedding a bad ticker can tell a typo (400) from a company outside the USD
// coverage (422), but the body is always a rendered card — a broken iframe
// shows an empty box, which tells the person who pasted it nothing.
async function renderEmbed(widget, rawTicker) {
    const definition = widgetDefinition(widget);
    if (!definition) {
        return { status: 404, html: errorCard('earnings-quality', null, 'Unknown widget.') };
    }
    const symbol = freeTools.normalizeSymbol(rawTicker);
    if (!symbol) {
        return {
            status: 400,
            html: errorCard(definition.slug, null, 'Add a ticker to the URL, e.g. ?ticker=NVDA.')
        };
    }

    let result;
    try {
        result = await freeTools.getToolResult(definition.slug, symbol);
    } catch (_) {
        return { status: 502, html: errorCard(definition.slug, symbol, 'Filed data is temporarily unavailable.') };
    }
    const body = (result && result.body) || {};
    if (!result || result.status !== 200 || body.error) {
        const status = result && result.status && result.status >= 400 ? result.status : 502;
        return { status, html: errorCard(definition.slug, symbol, body.error || `No filed data available for ${symbol}.`) };
    }

    const html = definition.slug === 'filing-timeline' ? timelineCard(definition.slug, body) : earningsCard(definition.slug, body);
    return { status: 200, html };
}

// Mounted by app.js, and by the test suite, so the headers and status codes the
// tests assert are the ones production actually serves rather than a copy.
function mountEmbedRoutes(app, { limiter } = {}) {
    const middlewares = limiter ? [limiter] : [];
    app.get('/embed/:widget', ...middlewares, async (req, res) => {
        const result = await renderEmbed(req.params.widget, req.query.ticker || req.query.symbol);
        res.setHeader('Content-Security-Policy', EMBED_CSP);
        res.set('X-Robots-Tag', 'noindex');
        res.set('Cache-Control', 'public, max-age=300, s-maxage=900');
        res.status(result.status).type('html').send(result.html);
    });
}

module.exports = { renderEmbed, mountEmbedRoutes, EMBED_CSP };
