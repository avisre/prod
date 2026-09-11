'use strict';

// Shared config for the embeddable widgets: the widget list, the iframe snippet
// the tool pages hand out, and the CSP the /embed routes set.
//
// Its own module rather than living in embed-widgets.js because two places need
// the same strings — the renderer that serves /embed/* and the tool pages that
// publish the copy-paste snippet. If those two drifted, the snippet would point
// at a URL that does not render, and nothing else would catch it.

const SITE = 'https://www.stockportfolio.pro';
const EMBED_ORIGIN = 'https://www.stockportfolio.pro';

// The embed is a top-level third-party frame by design, so it needs
// frame-ancestors * — the one page on this site that does. Everything else
// stays as tight as the API-ish pages: inline CSS only, no scripts at all
// (the widgets are server-rendered), no forms, nothing to fetch.
const EMBED_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors *";

const UTM = 'utm_source=embed&utm_medium=widget&utm_campaign=stockportfolio-embed';

const WIDGETS = Object.freeze({
    'earnings-quality': {
        slug: 'earnings-quality',
        title: 'Earnings quality',
        blurb: 'Filed revenue, net income and cash flow with the cash-conversion ratio.',
        suggestedHeight: 330,
        toolPath: '/tools/earnings-quality',
        badgePath: '/stocks/'
    },
    'filing-timeline': {
        slug: 'filing-timeline',
        title: 'SEC filing timeline',
        blurb: 'Recent 10-K, 10-Q, 8-K and Form 4 filings with direct EDGAR links.',
        suggestedHeight: 480,
        toolPath: '/tools/filing-timeline',
        badgePath: '/stocks/'
    }
});

function isWidget(widget) {
    return Object.prototype.hasOwnProperty.call(WIDGETS, String(widget || '').toLowerCase());
}

function widgetDefinition(widget) {
    return isWidget(widget) ? WIDGETS[String(widget).toLowerCase()] : null;
}

// The copy-paste block published on the tool pages. The ticker is a placeholder
// on purpose: a snippet with a hard-coded symbol is useless to the site owner
// copying it, and the widget is per-ticker by design.
function embedSnippet(widget, { ticker = 'NVDA', height } = {}) {
    const definition = widgetDefinition(widget);
    if (!definition) return '';
    const h = height || definition.suggestedHeight;
    return `<iframe src="${EMBED_ORIGIN}/embed/${definition.slug}?ticker=${ticker}"
        width="100%" height="${h}" style="border:0;max-width:640px" loading="lazy"
        title="${definition.title} — StockPortfolio.pro"></iframe>`;
}

// Where the badge points: the company page when we have a ticker, the tool page
// otherwise. Both carry the embed UTM so the referral is attributable.
function badgeHref(widget, symbol) {
    const definition = widgetDefinition(widget);
    if (!definition) return `${SITE}/tools?${UTM}`;
    if (symbol) return `${SITE}/stocks/${encodeURIComponent(symbol)}?${UTM}`;
    return `${SITE}${definition.toolPath}?${UTM}`;
}

module.exports = { SITE, EMBED_ORIGIN, EMBED_CSP, UTM, WIDGETS, isWidget, widgetDefinition, embedSnippet, badgeHref };
