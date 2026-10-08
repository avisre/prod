'use strict';

// /connect is the landing page for the Claude and ChatGPT directory listings,
// and the homepage badge is the claim that sends people there. Both are
// credibility claims, so what this file pins is that they stay CHECKABLE and
// stay TRUE: the listing links come from one file, the free allowance is the
// configured one, and the copy never drifts into implying a partnership.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const seoPages = require('../seo-pages');
const { LISTINGS, list } = require('../../lib/connector-listings');
const anon = require('../mcp-anon');
const botBlocker = require('../bot-blocker');
const attribution = require('../marketing-attribution');
const growth = require('../growth-measurement');

const HTML = seoPages.renderConnect();
const HOME = fs.readFileSync(path.join(__dirname, '../../frontend-v2/index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

test('/connect names both assistants and gives each an anchor the homepage links to', () => {
    for (const l of list()) {
        assert.match(HTML, new RegExp(`id="${l.key}"`), `no #${l.key} anchor`);
        assert.match(HTML, new RegExp(`Add to ${l.name}`));
        assert.match(HOME, new RegExp(`href="/connect#${l.key}"`), `the homepage does not link to /connect#${l.key}`);
    }
});

test('a listing link is rendered only for a listing whose URL is recorded', () => {
    for (const l of list()) {
        const linked = HTML.includes(`data-connect="${l.key}"`);
        assert.equal(linked, Boolean(l.url), `${l.name}: link and recorded URL disagree`);
        if (l.url) assert.ok(HTML.includes(`href="${l.url}"`), `${l.name} link does not point at the recorded URL`);
    }
});

test('the directory URLs live in lib/connector-listings.js and nowhere else', () => {
    const pages = ['frontend-v2/index.html', 'frontend-v2/appsumo.html', 'frontend-v2/register.html',
        'frontend-v2/assets/app.js', 'backend/docs-pages.js'];
    for (const p of pages) {
        assert.doesNotMatch(read(p), /claude\.ai\/directory\/|chatgpt\.com\/(apps|g|plugins\/)[a-z0-9]/i,
            `${p} hardcodes a listing URL — link to /connect instead`);
    }
});

test('the free allowance on the page is the configured one, not a typed number', () => {
    const cfg = anon.config();
    assert.ok(HTML.includes(`${cfg.askLimit} AI answers and ${cfg.lookupLimit} data lookups every ${cfg.windowDays} days`));
    const custom = anon.config({ ANON_MCP_ASK_LIMIT: '7', ANON_MCP_LOOKUP_LIMIT: '11' });
    assert.equal(custom.askLimit, 7);
    assert.equal(custom.lookupLimit, 11);
});

test('nothing claims a partnership or endorsement — these are directory listings', () => {
    const banned = /\b(partner(ed|ship)? with|official(ly)? (partner|app|connector)|certified by|endorsed by|approved by (anthropic|openai)|verified by (anthropic|openai))\b/i;
    const connectSection = HOME.slice(HOME.indexOf('id="connect"'), HOME.indexOf('id="stocks-etfs-funds"'));
    assert.ok(connectSection.length > 200, 'the homepage connect section is missing');
    for (const [name, text] of [['/connect', HTML], ['homepage section', connectSection]]) {
        assert.doesNotMatch(text, banned, `${name} overstates the listing`);
    }
    assert.match(HTML, /not affiliated with either company/);
});

test('the page does not reveal which model provider answers', () => {
    assert.doesNotMatch(HTML, /ollama|glm-?\d/i);
});

test('the homepage shows the listing in the hero, beside the AppSumo rating', () => {
    const hero = HOME.slice(HOME.indexOf('<section class="hero">'), HOME.indexOf('id="home-try"'));
    assert.match(hero, /Available in Claude and ChatGPT/);
    assert.match(hero, /href="\/connect"/);
    assert.match(hero, /5\.0 on AppSumo/, 'the AppSumo badge was displaced');
});

test('/connect is reachable: routed, in the sitemap, and exempt from the bot wall', () => {
    const app = read('backend/app.js');
    assert.match(app, /app\.get\('\/connect'/);
    assert.match(app, /'\/licensing',[\s\S]{0,400}'\/connect'\n\];/, '/connect is not exempt from the signup wall');
    assert.match(read('backend/seo-pages.js'), /'\/api', '\/connect',/);
    const noWebhook = () => false;
    assert.equal(botBlocker.isExemptPath('/connect', noWebhook), true);
    assert.equal(botBlocker.isExemptPath('/connect/', noWebhook), true);
    assert.equal(botBlocker.isExemptPath('/connected-apps', noWebhook), false);
});

test('the assistant channel is attributable instead of landing in "unknown"', () => {
    assert.equal(attribution.referrerSource('https://chatgpt.com/'), 'chatgpt');
    assert.equal(attribution.referrerSource('https://claude.ai/directory/stockportfolio'), 'claude');
    for (const s of ['chatgpt', 'claude', 'connector']) {
        assert.equal(attribution.normalizeSource(s), s);
        assert.equal(growth.normalizeSource(s), s);
    }
    assert.match(anon.SIGNUP_URL, /utm_source=connector/);
});

test('the cap-hit message sends a connector user back to the connector, not to manual setup', () => {
    const notice = anon.askUsageNotice(3, 3);
    assert.match(notice, /register\?plan=monthly/);
    assert.match(notice, /reconnect this StockPortfolio connector/);
    assert.match(notice, /\$79\.99\/month/);
});

test('the setup guide leads with the directory listing for both assistants', () => {
    const docs = read('backend/docs-pages.js');
    assert.match(docs, /listed in the Claude connector directory/);
    assert.match(docs, /listed in the ChatGPT app directory/);
    assert.match(docs, /href="\/connect#claude"/);
    assert.match(docs, /href="\/connect#chatgpt"/);
    assert.doesNotMatch(docs, /two AI answers/);
});
