// The public directory listings for the hosted connector — the one place their
// names and URLs live, so /connect, the docs and the cap-hit message cannot
// drift apart.
//
// A `url` is only set once the PUBLIC page has been opened and seen to load:
// both directories answer 403 to anything that is not a signed-in browser, so
// it cannot be checked from a script, and a "see our listing" link that 404s
// costs more credibility than no link. With `url: null` the page falls back to
// `find` — the in-product path, which is true regardless of the URL.
//
// Wording rule: these are directory LISTINGS. Neither vendor is a partner, and
// the Claude entry is a community connector — never "official", "certified",
// "endorsed" or "partner" (test/connect-page.test.js pins that).
const LISTINGS = Object.freeze({
    claude: Object.freeze({
        key: 'claude',
        name: 'Claude',
        directory: 'the Claude connector directory',
        // Slug is permanent (published 2026-10-07).
        url: process.env.CLAUDE_LISTING_URL || 'https://claude.ai/directory/stockportfolio',
        find: 'In Claude, open <b>Customize → Connectors</b>, browse the directory and search for <b>StockPortfolio</b>.'
    }),
    chatgpt: Object.freeze({
        key: 'chatgpt',
        name: 'ChatGPT',
        directory: 'the ChatGPT app directory',
        // Not recorded yet — set CHATGPT_LISTING_URL (or paste it here) once the
        // public link is in hand.
        url: process.env.CHATGPT_LISTING_URL || null,
        find: 'In ChatGPT, open the app directory and search for <b>StockPortfolio</b>.'
    })
});

module.exports = { LISTINGS, list: () => [LISTINGS.claude, LISTINGS.chatgpt] };
