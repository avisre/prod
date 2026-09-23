'use strict';

// The Ask page (/ask, /ask.html) is a static shell served by express.static.
// Every company and metric page links the same shell with a question prefilled
// (`/ask?q=…`), so those URLs differ only by user state — the served <title>
// and <meta description> are byte-identical for every question.
//
// Measured 2026-09-24: 3,012 distinct prefilled URLs are linked from the
// crawlable pages, each an indexable 200. That is what Bing Webmaster reports
// as "too many pages with identical titles" and "too many pages with identical
// meta descriptions" — its two amber recommendations on 2026-09-24.
//
// So the parameterised variant is served noindex,follow. The template's
// canonical already points at /ask, so ranking consolidates there and the
// prefilled links keep working for visitors.
//
// robots.txt deliberately does NOT disallow /ask?*: a disallowed URL cannot be
// read, so its noindex is never seen and it can still surface as a URL-only
// listing. This is the same reasoning robots.txt records for /login and /news
// ("blocking them here caused a 'blocked by robots.txt' warning instead of a
// clean drop").

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'frontend-v2', 'ask.html');
const NOINDEX_META = '<meta name="robots" content="noindex, follow" />';
const ROBOTS_RE = /<meta[^>]+name=["']robots["'][^>]*>/i;

let template = null;
function loadTemplate() {
    if (template === null) {
        try { template = fs.readFileSync(TEMPLATE_PATH, 'utf8'); } catch (_) { template = ''; }
    }
    return template;
}

// Any query string on /ask is user state (a prefilled question); none of it
// selects content the shell does not already serve at /ask.
function hasUserState(query) {
    return Boolean(query && Object.keys(query).length);
}

// Returns the shell unchanged when there is no user state, so the caller can
// fall through to express.static for the plain /ask page. Pure: the caller
// passes the markup, so the directive can be asserted without touching disk.
function withAskRobots(html, query) {
    if (!html || !hasUserState(query)) return html;
    if (ROBOTS_RE.test(html)) return html.replace(ROBOTS_RE, NOINDEX_META);
    // Inserted immediately before the canonical so the two read together.
    return html.replace('<link rel="canonical"', `${NOINDEX_META}\n  <link rel="canonical"`);
}

function renderAskPage(query) {
    return withAskRobots(loadTemplate(), query);
}

module.exports = { renderAskPage, withAskRobots, hasUserState, loadTemplate, TEMPLATE_PATH, NOINDEX_META };
