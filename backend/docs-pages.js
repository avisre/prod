// Public product documentation at /docs — one server-rendered page per topic.
//
// Built on the free-tools.js pattern (a frozen definitions map + render
// functions + automatic sitemap inclusion) for the same reason: 18 articles as
// 18 files in frontend-v2/ would be 18 copies of the same <head> and 18 more
// places for the cache stamp to drift. One difference from free-tools.js on
// purpose — that file inlines the whole <head> three times, once per render
// function, which is why its stamp appears three times. Everything here goes
// through a single layout().
//
// Two rules this file exists to keep:
//
//  1. NO CREDIT NUMBER IS EVER TYPED HERE. Every figure interpolates
//     credits.COST. public-api.md drifted from the real prices for months
//     precisely because its numbers were hand-written and nothing read them
//     back; docs-pages.test.js parses the rendered HTML to hold this.
//  2. NO NAV OR FOOTER MARKUP. The chrome is whatever V2.nav('')/V2.footer()
//     inject, unstyled by this file, so /docs is byte-identical to every other
//     page. Do not add CSS here that targets .nav/.footer or their children.
const credits = require('./credits');

// Pages quote the LISTED price; the charge is credits.COST (see credits.js).
const COST = credits.LISTED_COST;
// Deep thinking on Ask is charged at this multiple of COST.ask (credits.js).
const DEEP = credits.DEEP_THINKING_FACTOR;
// The keyless allowance is env-switchable, so the docs quote the live config
// instead of a typed number (it said "two" while the default was three).
const ANON = require('./mcp-anon').config();
const STAMP = '20261025-ui33';
const UPDATED = '18 October 2026';

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Sidebar group order. Anything whose `topic` is missing from this list would
// silently vanish from the sidebar, so the test asserts every topic is here.
const TOPIC_ORDER = Object.freeze([
    'Getting started',
    'Research features',
    'Data & discovery',
    'Portfolio',
    'Tools',
    'Billing & access',
    'Developers',
    'Account'
]);

const DOC_PAGES = Object.freeze({
    'getting-started': {
        slug: 'getting-started', topic: 'Getting started',
        title: 'Getting started — StockPortfolio.pro documentation',
        description: 'Create an account, find a company, ask your first question and understand what each action costs.',
        heading: 'Getting started',
        intro: 'StockPortfolio.pro answers questions about public companies from their own SEC filings. This page takes you from a new account to your first answer.',
        tier: 'Everyone',
        steps: [
            'Create an account at <a class="prose-link" href="/register">/register</a>. An account is required before any AI feature will answer — there is no anonymous mode.',
            'Find a company. Use the search box in the header, or open <a class="prose-link" href="/stocks">All stocks</a> to browse. Every company has a page with filings, fundamentals and charts.',
            'Ask a question. The Ask box takes plain English — "how did margins move last year?" — and answers from the filings, quoting what it used.',
            'Watch what you spend. Each AI action draws from a monthly credit allowance shown on your profile. Deterministic pages and the free tools cost nothing.'
        ],
        notes: [
            { title: 'What costs credits and what does not', body: 'Company pages, the screener, comparisons, the portfolio tracker and all 30 free tools are free and unmetered. Only the AI features draw credits: Ask (' + COST.ask + '), a Research Dossier (' + COST.dossier_standard + '), a Filing Monitor report (' + COST.monitor + ') and a dossier comparison (' + COST.dossier_compare + ').' },
            { title: 'Answers cite their sources', body: 'Every AI answer names the filing and period it drew from. If a figure matters to a decision, open the linked filing and check it. The product is a research assistant, not investment advice.' }
        ],
        related: ['ask', 'credits', 'troubleshooting']
    },

    troubleshooting: {
        slug: 'troubleshooting', topic: 'Getting started',
        title: 'Troubleshooting — StockPortfolio.pro documentation',
        description: 'What each error message means and how to fix it, including credit, plan, trial and rate-limit errors.',
        heading: 'Troubleshooting',
        intro: 'Every error this product can show you, what it actually means, and the fix. The code in the first column is the one you will see in an API response or in the browser console.',
        tier: 'Everyone',
        errors: [
            { code: 'ASK_AUTH', status: '401', means: 'You are signed out. Ask requires an account — there is no anonymous mode.', fix: '<a class="prose-link" href="/login.html" rel="nofollow">Sign in</a>, then resend the question.' },
            { code: 'API_ACCESS_REQUIRED', status: '402', means: 'Your plan does not include the REST API or the MCP server.', fix: 'API and MCP access is on the Dev, Monthly, Annual, Pro, Power and Desk plans, on the Investor and Pro AppSumo or DealMirror tiers, and on any AppSumo or DealMirror tier purchased on or before 22 September 2026. See <a class="prose-link" href="/docs/plans">Plans</a>.' },
            { code: 'INSUFFICIENT_CREDITS', status: '402', means: 'This month’s credit allowance is spent.', fix: 'The response carries a <code>resetsAt</code> timestamp — the first moment of next month, UTC, when the allowance refills. Upgrade or top up to continue before then.' },
            { code: 'MONITOR_REQUIRED', status: '402', means: 'The Filing Change Monitor is not on your plan.', fix: 'The Monitor is on Power, Desk, Enterprise and Pro <em>annual</em> — and on lifetime plans. Retired Pro <em>monthly</em> does not include it. See <a class="prose-link" href="/docs/filing-monitor">Filing Monitor</a>.' },
            { code: 'TRIAL_EXHAUSTED', status: '429', means: 'You have used the Monitor trial for today. The trial covers three companies per day.', fix: 'Wait for the daily reset, or move to a plan that includes the Monitor outright.' },
            { code: 'DEEP_THINKING_CREDITS', status: '402', means: 'Deep thinking is on and you have fewer credits left than a Deep thinking question costs (' + (DEEP * COST.ask) + ', ' + DEEP + 'x a normal question).', fix: 'Press the thinking pill in the box and choose Standard to ask at the normal cost, or top up.' },
            { code: 'API_PLAN_NO_WEB_ASK', status: '402', means: 'You are on the Dev plan and tried to use the website’s Ask box. Dev covers the API and MCP server only.', fix: 'Use your API key against <code>/api/v1</code>, or switch to Monthly for Ask inside the app.' },
            { code: 'COMPANY_LIMIT', status: '429', means: 'This account has looked up 50 different companies in the last 24 hours, or 250 in the last 30 days, through the API or a connected assistant. The limit counts different companies, not calls.', fix: 'Companies you already looked up in that time keep working. The response carries <code>resets_at</code>, the moment a new company can be added. If your work genuinely needs more companies, email support.pro.' },
            { code: 'Rate limited', status: '429', means: 'You sent more than 60 API requests in a minute on one key.', fix: 'Back off and retry. The limit is per key, per minute — spread bulk work out rather than running it in parallel.' }
        ],
        notes: [
            { title: 'The answer came back empty or refused', body: 'Two causes. Either the filing genuinely does not contain what you asked — the assistant will say so rather than guess, which is deliberate — or the question was about something outside public-company filings. Rephrase around a specific company and period. An empty answer does not consume the credit twice; retries on a failed answer are not double-charged.' },
            { title: 'A number looks wrong', body: 'Open the filing the answer cites and compare. Figures are read from filed statements, so a mismatch usually means a period mismatch (trailing twelve months against a fiscal year) or a restatement. Foreign filers are converted to USD for display. If it is still wrong, send it to <a class="prose-link" href="/support">support</a> with the ticker and the filing.' },
            { title: 'A page redirected you to the sign-up screen', body: 'Everything except this documentation, the sign-in and sign-up screens, and the legal and support pages requires an account. That is intentional, not a fault.' }
        ],
        related: ['credits', 'plans', 'api-mcp']
    },

    ask: {
        slug: 'ask', topic: 'Research features',
        title: 'Ask — StockPortfolio.pro documentation',
        description: 'Ask about any public company and get answers from its SEC filings, with sources. Regenerate, branch, custom instructions, deep thinking, voice and files.',
        heading: 'Ask',
        intro: 'Ask is the assistant that answers questions about a public company from its own filings. It quotes what it used, and it declines rather than inventing an answer the filings do not support.',
        tier: 'Any paid plan except Dev',
        costKey: 'ask',
        steps: [
            'Open <a class="prose-link" href="/ask">Ask</a>, or use the ask box that sits at the bottom of most pages.',
            'Name the company and be specific about the period. "What did Apple say about services margin in the latest 10-K?" works far better than "is Apple a good buy?".',
            'Read the sources. The answer lists the filings and periods behind it; each one links to the primary document.',
            'Follow up in the same thread. Context carries, so you can drill in without restating the company each time.',
            'Change a question you already sent with the pencil under it (or press <kbd>↑</kbd> in an empty box). Sending the edit replaces that question and every answer after it, so the chat continues from the new wording.'
        ],
        notes: [
            { title: 'Long questions and files', body: 'A question can be up to 60,000 characters, so you can paste a whole section of a filing. You can also attach up to 3 files of up to 10 MB each — images (PNG, JPEG, WebP), PDF, CSV, plain text, Markdown or JSON — with the paperclip, by pasting them into the box, or by dragging them onto it.' },
            { title: 'Deep thinking', body: 'Press Think in the box, next to the send button, and choose High: the assistant works through the question more carefully before it answers. It is slower and costs ' + DEEP + 'x a normal question: ' + (DEEP * COST.ask) + ' credits instead of ' + COST.ask + ', and more for a very long answer. The pill then reads High and it stays on until you choose Standard. If you have fewer credits left than a Deep thinking question needs, you get <code>DEEP_THINKING_CREDITS</code>; choose Standard to ask normally. Analyst and Normal change how the answer is written, not how hard it thinks, and cost the same.' },
            { title: 'Speak your question', body: 'Press the microphone in the box, speak, and press it again to stop (up to a minute). The words land in the box for you to check before you send. Where your browser transcribes the speech itself, the first use downloads a speech model of about 80 MB.' },
            { title: 'Temporary chats', body: 'Signed in, press Temporary chat above the box to start a chat that is not kept: it is not added to your chat list, it is not used for memory, and it does not use your other chats as context. Questions cost the same credits as usual. Opening another chat or pressing the button again ends it.' },
            { title: 'Working with answers', body: 'Under each answer: copy it, regenerate it, branch from it, have it read aloud, rate it, or share it. Code and formulas come in their own block with a Copy button. Each question has its own copy button too, which helps when you reuse a well-worded prompt.' },
            { title: 'Regenerate and answer versions', body: 'Regenerate asks the same question again and puts the new answer in place of the old one. The old answer is kept: the arrows under the answer (‹ 1 / 2 ›) page between versions, and Copy and Read aloud use the version on screen. A saved chat keeps the last 5 versions of each answer. Regenerating an earlier answer removes the messages after it, the same as editing a question, and you are asked first. A regenerate costs the same credits as a new question.' },
            { title: 'Branch in a new chat', body: 'Branch, under any answer in a saved chat, copies the chat up to and including that answer into a new chat named <em>Branch · …</em> and opens it. Use it to try a different follow-up without losing the original, which stays exactly as it was. Branching itself costs no credits.' },
            { title: 'Custom instructions', body: 'Press Custom instructions in the chat list to tell Ask how to answer you: tone, length, format, or what you care about (for example, \u201ckeep it short and lead with the numbers\u201d). Up to 1,500 characters. They apply to every chat, temporary chats included, until you change or clear them. They shape how answers are written, not what is true: figures still come only from filings, and Ask still never gives buy/sell advice.' },
            { title: 'Ask what a filing says, not what to buy', body: 'The assistant is built to be accurate about filed facts and to refuse speculation. Questions about price targets or whether to buy something will get a hedge, because the filings do not answer them. Questions about segment performance, accounting changes, risk-factor wording or year-over-year movement are what it is for.' },
            { title: 'Your chats are saved', body: 'Every chat is kept in the list beside the box, so a question you asked last month is still there with its sources attached. Each chat\'s menu lets you rename it, pin it, download it as a Markdown file or delete it.' },
            { title: 'Keyboard shortcuts', body: 'Press <kbd>Ctrl</kbd> <kbd>/</kbd> (<kbd>⌘</kbd> <kbd>/</kbd> on a Mac) on the Ask page to see them all. <kbd>Enter</kbd> sends and <kbd>Shift</kbd> <kbd>Enter</kbd> starts a new line. With <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>Shift</kbd>: <kbd>O</kbd> new chat, <kbd>C</kbd> copy the last answer, <kbd>S</kbd> show or hide the chat list, <kbd>Backspace</kbd> delete this chat. <kbd>Shift</kbd> <kbd>Esc</kbd> puts the cursor in the box, <kbd>↑</kbd> in an empty box edits your last question, and <kbd>Esc</kbd> cancels an edit.' },
            { title: 'The Dev plan cannot use Ask on the web', body: 'Dev is an API and MCP plan. Its credits are spendable through <code>/api/v1</code> and the MCP server, not through the website’s Ask box — the web box will return <code>API_PLAN_NO_WEB_ASK</code>. Monthly is the cheapest plan with Ask in the app.' }
        ],
        related: ['research-dossier', 'credits', 'troubleshooting']
    },

    'research-dossier': {
        slug: 'research-dossier', topic: 'Research features',
        title: 'Research Dossier — StockPortfolio.pro documentation',
        description: 'Generate a full written research dossier on any public company, built from its filings.',
        heading: 'Research Dossier',
        intro: 'A Dossier is a long-form written report on one company — the business, how it earns, segment performance, balance-sheet position, and what the filings flag as risk. It is generated on demand and takes a few minutes.',
        tier: 'Pro and above',
        costKey: 'dossier_standard',
        steps: [
            'Open <a class="prose-link" href="/dossier">Research Dossier</a> and enter a ticker.',
            'Wait for it to build. A dossier reads the full filing set, so it takes minutes, not seconds. You can leave the page — it keeps building and is on your profile when it is done.',
            'Read it in sections. Each section names the filings behind it, so you can verify any claim against the source.',
            'Refresh it after a new filing. A dossier is a snapshot of the filings available when it was built; rebuilding after a new 10-Q picks up the change and costs the same again.'
        ],
        notes: [
            { title: 'It is built for large filings', body: 'Dossiers handle genuinely long filers — Berkshire Hathaway, the big banks — rather than truncating them. Foreign private issuers filing in other currencies are converted to USD so the figures stay comparable.' },
            { title: 'Rebuilding costs a full dossier', body: 'There is no discounted refresh. A rebuild reads everything again and is charged as a new dossier, so refresh when a filing has actually landed rather than out of habit.' }
        ],
        related: ['compare-dossiers', 'filing-monitor', 'credits']
    },

    'filing-monitor': {
        slug: 'filing-monitor', topic: 'Research features',
        title: 'Filing Monitor — StockPortfolio.pro documentation',
        description: 'Track a company and get a written report on what changed every time it files with the SEC.',
        heading: 'Filing Monitor',
        intro: 'The Monitor watches a company’s SEC filings and, when a new one lands, tells you what changed against the previous filing — new risk-factor language, moved figures, altered disclosures — rather than just telling you a filing exists.',
        tier: 'Power, Desk, Enterprise, Pro annual and lifetime plans',
        costKey: 'monitor',
        steps: [
            'Open <a class="prose-link" href="/monitor">Filing Monitor</a> and add a company to watch.',
            'Wait for the next filing. The Monitor compares the new document against the one before it.',
            'Read the change report. It names what moved, quotes the wording that changed, and links both filings.',
            'Manage your watched companies from the same page. How many you can watch at once depends on your plan.'
        ],
        notes: [
            { title: 'Pro monthly does not include the Monitor', body: 'This is the one plan trap worth knowing. The Monitor is on Power, Power monthly, Desk, Enterprise and Pro <em>annual</em>, plus lifetime plans. The retired Pro <em>monthly</em> plan does not include it, despite the similar name. If you are on Pro monthly and the Monitor asks you to upgrade, that is why.' },
            { title: 'There is a trial', body: 'If your plan does not include the Monitor you can still try it on three companies per day. Past that you will get <code>TRIAL_EXHAUSTED</code> until the next day.' },
            { title: 'Each report costs credits', body: 'Watching a company is free; the written change report generated when it files costs ' + COST.monitor + ' credits. A quiet quarter costs nothing.' }
        ],
        related: ['research-dossier', 'watchlist', 'plans']
    },

    'compare-dossiers': {
        slug: 'compare-dossiers', topic: 'Research features',
        title: 'Comparing dossiers — StockPortfolio.pro documentation',
        description: 'Put two research dossiers side by side and get a written comparison of the two businesses.',
        heading: 'Comparing dossiers',
        intro: 'Once you have dossiers on two companies, you can have them compared directly — how the businesses differ, where the numbers diverge, and what each filing set emphasises that the other does not.',
        tier: 'Pro and above',
        costKey: 'dossier_compare',
        steps: [
            'Build a dossier for each company first. The comparison reads existing dossiers rather than regenerating them, which is why it is much cheaper than building one.',
            'Open <a class="prose-link" href="/dossier">Research Dossier</a> and choose the two to compare.',
            'Read the comparison. It is written against both filing sets, so differences in accounting treatment or segment definition get called out rather than papered over.'
        ],
        notes: [
            { title: 'Why it costs so much less', body: 'A comparison is ' + COST.dossier_compare + ' credits against ' + COST.dossier_standard + ' for a dossier because the expensive work — reading the filings — already happened. If either dossier is stale, rebuild it first or the comparison will reflect the older filings.' }
        ],
        related: ['research-dossier', 'comparisons', 'credits']
    },

    'company-pages': {
        slug: 'company-pages', topic: 'Data & discovery',
        title: 'Company pages — StockPortfolio.pro documentation',
        description: 'Fundamentals, filings, statements and charts for any listed company or fund.',
        heading: 'Company pages',
        intro: 'Every listed company and fund has a page carrying its filed fundamentals, financial statements, recent SEC filings and price history. These pages are deterministic — no AI, no interpretation — and cost nothing to view.',
        tier: 'Any account',
        steps: [
            'Search for a company in the header search box, or browse <a class="prose-link" href="/stocks">All stocks</a>.',
            'Read the statements. Income statement, balance sheet and cash-flow figures come from the filings as filed.',
            'Open the filings list to go straight to the primary documents on EDGAR.',
            'Use the ask box on the page to have anything on it explained in plain words.'
        ],
        notes: [
            { title: 'Funds work too', body: 'ETFs and mutual funds have pages carrying holdings and profile data rather than filed statements. <a class="prose-link" href="/company?symbol=SPY">SPY</a> is a good example.' },
            { title: 'Missing values stay missing', body: 'Where a company has not filed a figure, the page leaves it blank rather than estimating it. A gap on the page is a gap in the filing.' }
        ],
        related: ['screener', 'comparisons', 'free-tools']
    },

    screener: {
        slug: 'screener', topic: 'Data & discovery',
        title: 'Screener — StockPortfolio.pro documentation',
        description: 'Filter the market on filed fundamentals to build a shortlist.',
        heading: 'Screener',
        intro: 'The screener filters listed companies on filed fundamentals — size, growth, margin, leverage and valuation — so you can narrow a universe down to a shortlist worth researching properly.',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Open the <a class="prose-link" href="/screener">screener</a>.',
            'Set your filters. Each one runs against filed values, not estimates.',
            'Sort the results on the column that matters to your thesis.',
            'Open a result to its company page, or send it straight to Ask or a Dossier for the qualitative work.'
        ],
        notes: [
            { title: 'It is free and unmetered', body: 'Screening costs no credits however much you run it. Credits only start once you ask the assistant to interpret something.' }
        ],
        related: ['company-pages', 'comparisons', 'watchlist']
    },

    comparisons: {
        slug: 'comparisons', topic: 'Data & discovery',
        title: 'Comparisons — StockPortfolio.pro documentation',
        description: 'Put companies side by side on filed fundamentals.',
        heading: 'Comparisons',
        intro: 'Comparison pages line companies up against each other on the same filed metrics, so you are reading like against like rather than flipping between two company pages.',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Open <a class="prose-link" href="/compare">Compare</a> and pick the companies.',
            'Read across the rows. Every metric is computed the same way for each company.',
            'For the qualitative side — why the numbers differ — use <a class="prose-link" href="/docs/compare-dossiers">dossier comparison</a> instead.'
        ],
        notes: [
            { title: 'Comparability is flagged, not hidden', body: 'Where two companies report on different fiscal calendars or define a segment differently, the page says so. It does not silently normalise figures that are not actually comparable.' }
        ],
        related: ['compare-dossiers', 'company-pages', 'screener']
    },

    gurus: {
        slug: 'gurus', topic: 'Data & discovery',
        title: 'Gurus — StockPortfolio.pro documentation',
        description: 'See what well-known institutional investors hold and how their positions changed.',
        heading: 'Gurus',
        intro: 'The Gurus section tracks the disclosed holdings of well-known institutional investors from their quarterly 13F filings — what they hold, what they added and what they exited.',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Open <a class="prose-link" href="/gurus">Gurus</a> and pick an investor.',
            'Read the current holdings and the quarter-on-quarter change.',
            'Open any holding to its company page to do the actual work.'
        ],
        notes: [
            { title: 'A 13F is a lagging, partial picture', body: 'Filings arrive up to 45 days after quarter end, cover only US-listed long positions, and exclude shorts and most derivatives. Treat them as a starting point for research, never as a signal to trade on.' }
        ],
        related: ['company-pages', 'portfolio', 'screener']
    },

    'markets-news': {
        slug: 'markets-news', topic: 'Data & discovery',
        title: 'Markets and news — StockPortfolio.pro documentation',
        description: 'Market overview, movers and filing-driven news.',
        heading: 'Markets and news',
        intro: 'The Markets section carries the broad market picture — indices, movers and sector movement — alongside news that is tied back to filings rather than aggregated headlines.',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Open <a class="prose-link" href="/news" rel="nofollow">Markets</a> for the overview.',
            'Check <a class="prose-link" href="/filing-changes">filing changes</a> for companies whose latest filing differs materially from the one before.',
            'Follow anything interesting into a company page, Ask or the Monitor.'
        ],
        notes: [
            { title: 'Filing changes are the useful part', body: 'Price movers tell you what already happened. The filing-changes feed tells you what a company altered in its own disclosures, which is usually where the story is.' }
        ],
        related: ['filing-monitor', 'company-pages', 'watchlist']
    },

    portfolio: {
        slug: 'portfolio', topic: 'Portfolio',
        title: 'Portfolio tracker — StockPortfolio.pro documentation',
        description: 'Track holdings, cost basis and performance, and research what you actually own.',
        heading: 'Portfolio tracker',
        intro: 'The portfolio tracker holds your positions with cost basis so you can see performance, allocation and exposure — and then research the holdings with the same tools you use on anything else.',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Open <a class="prose-link" href="/dashboard" rel="nofollow">Portfolio</a>.',
            'Add your holdings with quantity and cost basis. Accuracy here is what makes the return figures meaningful.',
            'Review allocation and performance. Concentration by position and by sector is worth checking more often than daily return.',
            'Research a holding in place — any position can go straight to its company page, to Ask, or onto the Monitor.'
        ],
        notes: [
            { title: 'Your holdings are private', body: 'Portfolio data is yours. It is not published, shared or used to construct anything public.' },
            { title: 'It tracks, it does not advise', body: 'The tracker reports what you hold and how it has performed. It does not tell you to rebalance, and no part of the product generates trade recommendations.' }
        ],
        related: ['watchlist', 'company-pages', 'gurus']
    },

    watchlist: {
        slug: 'watchlist', topic: 'Portfolio',
        title: 'Watchlist — StockPortfolio.pro documentation',
        description: 'Keep a list of companies you are following without owning them.',
        heading: 'Watchlist',
        intro: 'A watchlist is for companies you are following but do not own. It is the shortlist between "found it in the screener" and "bought it".',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Add a company from its page, from the screener, or from a comparison.',
            'Review the list from your profile.',
            'Promote anything you want told about into the <a class="prose-link" href="/docs/filing-monitor">Filing Monitor</a>, which reports when it files.'
        ],
        notes: [
            { title: 'Watchlist and Monitor are different things', body: 'A watchlist is a list you check. The Monitor is a job that reads each new filing and writes up what changed. Watching costs nothing; Monitor reports cost ' + COST.monitor + ' credits each.' }
        ],
        related: ['filing-monitor', 'portfolio', 'screener']
    },

    'free-tools': {
        slug: 'free-tools', topic: 'Tools',
        title: 'Free tools — StockPortfolio.pro documentation',
        description: 'Thirty deterministic SEC filing, accounting, portfolio and fund tools that need no account.',
        heading: 'Free tools',
        intro: 'Thirty single-purpose calculators over filed data — earnings quality, dilution, filing timelines, fund overlap and more. They are deterministic, use no AI, draw no credits, and need no account.',
        tier: 'No account needed',
        costKey: null,
        steps: [
            'Open <a class="prose-link" href="/tools">the tools index</a> and pick one.',
            'Enter a ticker and run it.',
            'Follow the source link to the filing the numbers came from.'
        ],
        notes: [
            { title: 'No AI, on purpose', body: 'These tools compute from filed values and stop there. Where a figure is missing or two periods are not comparable, they say so rather than estimating — which is exactly what makes them safe to quote.' },
            { title: 'Two of them embed', body: 'The earnings-quality and filing-timeline cards can be embedded on your own site with one iframe and no key.' }
        ],
        related: ['company-pages', 'api-mcp', 'screener']
    },

    credits: {
        slug: 'credits', topic: 'Billing & access',
        title: 'Credits — StockPortfolio.pro documentation',
        description: 'What each AI action costs, when credits reset, and how to see where yours went.',
        heading: 'Credits',
        intro: 'AI features are metered in credits. Everything else — company pages, the screener, comparisons, the portfolio tracker and all the free tools — is unmetered. Your allowance refills at the start of each month.',
        tier: 'All plans',
        costTable: [
            ['Ask a question (web)', 'ask'],
            ['Research Dossier', 'dossier_standard'],
            ['Compare two dossiers', 'dossier_compare'],
            ['Filing Monitor report', 'monitor'],
            ['API data lookup', 'api_lookup'],
            ['API AI answer', 'api_ask'],
            ['MCP data lookup', 'mcp_lookup'],
            ['MCP AI answer', 'mcp_ask']
        ],
        steps: [
            'Check your balance on your <a rel="nofollow" class="prose-link" href="/profile.html">profile</a>. It shows credits used, credits remaining and the reset date.',
            'Read the activity list to see exactly which actions spent what.',
            'Plan around the reset. Allowances refill at the first moment of the next month, UTC.'
        ],
        notes: [
            { title: 'Why the API and MCP prices are higher', body: 'The web app is a person asking a question at human pace. A key is a program, and one that can run continuously. The API and MCP prices reflect what sustained programmatic use actually costs to serve, and they are what makes offering a key on a self-serve plan viable at all.' },
            { title: 'Deep thinking costs more', body: 'An Ask question with Deep thinking on costs ' + DEEP + 'x a normal one: ' + (DEEP * COST.ask) + ' credits instead of ' + COST.ask + '. Temporary chats cost the same as any other chat. See <a class="prose-link" href="/docs/ask">Ask</a>.' },
            { title: 'A failed action is not charged twice', body: 'If an answer fails and you retry, you are not billed for the failure. Charging happens on a delivered result.' },
            { title: 'Plan credits reset; recharge credits carry over', body: 'Your plan allowance is monthly: it resets to the full amount on the 1st rather than accumulating. Recharge credits are different. They are used only after the month\'s plan allowance runs out, and whatever is left carries into the next month until it is spent.' }
        ],
        related: ['plans', 'api-mcp', 'troubleshooting']
    },

    plans: {
        slug: 'plans', topic: 'Billing & access',
        title: 'Plans and access — StockPortfolio.pro documentation',
        description: 'Which plan unlocks which feature, including the Monitor and API access rules.',
        heading: 'Plans and access',
        intro: 'Plans differ in two ways: how many credits you get each month, and which features are unlocked at all. This page covers the second, which is the part that surprises people.',
        tier: 'All plans',
        steps: [
            'See current pricing on the <a class="prose-link" href="/#pricing">pricing section</a> of the home page.',
            'Check which features your plan unlocks against the list below.',
            'Change plan from your <a rel="nofollow" class="prose-link" href="/profile.html">profile</a>. Feature access updates immediately — an upgrade or a downgrade both take effect on the next request, not at the next billing date.'
        ],
        notes: [
            { title: 'Ask', body: 'On every paid plan except Dev. Dev is API-only and will refuse the website’s Ask box with <code>API_PLAN_NO_WEB_ASK</code>.' },
            { title: 'Research Dossier', body: 'Pro and above.' },
            { title: 'Filing Monitor', body: 'Power, Power monthly, Desk, Enterprise and Pro <em>annual</em>, plus lifetime plans. Retired Pro <em>monthly</em> is not included — the names are close, the access is not. Everyone else gets a trial of three companies per day.' },
            { title: 'API and MCP', body: 'The Dev plan, Monthly, Annual, Pro, Power, Power monthly and Desk, plus the Investor and Pro AppSumo and DealMirror tiers. Lifetime buyers who purchased on or before 22 September 2026 also keep it on whichever tier they bought, permanently. Dev exists as the cheap on-ramp for developers evaluating the data — it is a paid plan, not free access.' },
            { title: 'Access is re-checked on every request', body: 'Nothing is granted at signup and cached. If a subscription lapses or is refunded, the feature closes on the next call rather than at the end of a billing cycle.' }
        ],
        related: ['credits', 'api-mcp', 'account']
    },

    'api-mcp': {
        slug: 'api-mcp', topic: 'Developers',
        title: 'API and MCP server — StockPortfolio.pro documentation',
        description: 'Connect Claude, ChatGPT or your own code to the filing data: setup for each MCP client and the REST API, with authentication, costs and rate limits.',
        heading: 'API and MCP server',
        intro: 'Using Claude or ChatGPT rather than writing code? <a class="prose-link" href="/connect">Start here</a>: add StockPortfolio from the directory, try it free without an account, and the Monthly plan ($79.99 a month) covers it after that. The rest of this page is the setup reference. One key covers both developer surfaces: the REST API at <code>/api/v1</code> and the MCP server at <code>/mcp</code>, which plugs the same filing data into Claude, ChatGPT or any other MCP-capable assistant. This page is the setup guide for each of them.',
        tier: 'Dev, Monthly, Annual, Pro, Power, Desk and Investor/Pro lifetime tiers',
        costTable: [
            ['REST data lookup', 'api_lookup'],
            ['REST AI answer', 'api_ask'],
            ['MCP data lookup', 'mcp_lookup'],
            ['MCP AI answer', 'mcp_ask']
        ],
        steps: [
            'Create a key on your <a rel="nofollow" class="prose-link" href="/profile.html">profile</a>. Keys start with <code>sp_live_</code> and are shown once — store it immediately, because it is hashed and cannot be shown again.',
            'Decide which surface you need. An assistant takes the MCP server; your own code can use either the MCP server or the REST API — same data, same wallet, whichever your client speaks.',
            'Follow the setup for your client below. Claude and ChatGPT add the server by URL and sign in, because neither can send a key — they authenticate over OAuth instead, and you paste nothing.',
            'Everywhere else, authenticate with <code>Authorization: Bearer sp_live_...</code> on every request.'
        ],
        setup: [
            {
                title: 'Claude — claude.ai, Claude Desktop and the mobile apps',
                body: 'StockPortfolio is listed in the Claude connector directory, so the short path is to add it from there: open <b>Customize → Connectors</b>, browse the directory, search for <b>StockPortfolio</b> and press <b>Connect</b> — <a class="prose-link" href="/connect#claude">details</a>. It authenticates over OAuth rather than a pasted key, so you approve the sign-in window Claude opens and paste nothing. To add it by hand as a <em>custom connector</em> instead, use this URL:',
                code: 'https://www.stockportfolio.pro/mcp',
                note: 'Manual setup, on a Pro or Max plan: <b>Customize → Connectors → + → Add custom connector</b>, paste the URL, then <b>Add</b>. On Team or Enterprise an owner adds it first (<b>Organization settings → Connectors → Add → Custom → Web</b>) and members then press <b>Connect</b>. Leave <b>Advanced settings</b> — the OAuth client ID and secret fields — empty, because we register each client automatically. Turn it on for a conversation with <b>+ → Connectors</b>.'
            },
            {
                title: 'Claude Code',
                body: 'Claude Code can send a header, so it uses your key directly and skips OAuth entirely.',
                code: `claude mcp add --transport http stockportfolio \\
  https://www.stockportfolio.pro/mcp \\
  --header "Authorization: Bearer sp_live_your_key"`,
                note: 'Confirm it registered with <code>claude mcp list</code>. Add <code>--scope user</code> to make the server available in every project rather than only the one you ran the command in.'
            },
            {
                title: 'Anthropic API — the Messages API',
                body: 'The Messages API connects to a remote MCP server directly, with your key passed as <code>authorization_token</code>. Send the beta header <code>anthropic-beta: mcp-client-2025-11-20</code> alongside the request.',
                code: `{
  "model": "claude-sonnet-5",
  "max_tokens": 1024,
  "mcp_servers": [
    { "type": "url", "url": "https://www.stockportfolio.pro/mcp",
      "authorization_token": "sp_live_your_key" }
  ],
  "messages": [{ "role": "user", "content": "What has NVDA filed recently?" }]
}`,
                note: 'Those calls spend the same credit allowance as the website, at the same prices.'
            },
            {
                title: 'ChatGPT',
                body: 'StockPortfolio is listed in the ChatGPT app directory, so the short path is to add it from there: open the directory, search for <b>StockPortfolio</b> and connect it — <a class="prose-link" href="/connect#chatgpt">details</a>. No Developer mode is needed for the listed app. ChatGPT uses OAuth 2.1 and does not accept a bearer token, so — exactly as with Claude — you approve a sign-in instead of pasting a key. To add it by hand as a custom connector instead, use this URL:',
                code: 'https://www.stockportfolio.pro/mcp',
                note: 'Manual setup only: ChatGPT gates <em>custom</em> connectors behind <b>Developer mode</b> — turn it on under <b>Settings → Security and login</b>, then go to <b>chatgpt.com/plugins → Add → Create MCP App</b>, paste the URL, set <b>Authentication</b> to <b>OAuth</b> and press <b>Create</b>. Whether Developer mode is offered at all can depend on account and workspace policy, and a managed workspace may not offer it. Where neither is open to you, the API routes below reach the same filings at the same prices.'
            },
            {
                title: 'OpenAI API — the Responses API',
                body: 'The Responses API takes a remote MCP server as an <code>mcp</code> tool, with your key in the <code>authorization</code> field.',
                code: `{
  "model": "<your model>",
  "tools": [
    { "type": "mcp", "server_label": "stockportfolio",
      "server_url": "https://www.stockportfolio.pro/mcp",
      "authorization": "sp_live_your_key" }
  ]
}`,
                note: 'OpenAI does not retain that value, so send it on every request.'
            },
            {
                title: 'Any other MCP client',
                body: 'Anything that speaks MCP over Streamable HTTP works with the same URL and a bearer header.',
                code: `POST https://www.stockportfolio.pro/mcp
Authorization: Bearer sp_live_your_key
Content-Type: application/json
Accept: application/json, text/event-stream`
            },
            {
                title: 'A client that only runs local stdio servers',
                body: 'For a client that cannot reach a remote server at all, this npm bridge proxies the same hosted endpoint over stdio.',
                code: `{
  "mcpServers": {
    "stockportfolio": {
      "command": "npx",
      "args": ["-y", "stockportfolio-mcp"],
      "env": { "STOCKPORTFOLIO_API_KEY": "sp_live_your_key" }
    }
  }
}`,
                note: 'Put that in the client\'s own config file — for Claude Desktop it is <code>claude_desktop_config.json</code>. It needs Node 18 or newer, and it holds only the key you give it, which it sends nowhere except this endpoint. Restart the client afterwards: the file is read at startup.'
            },
            {
                title: 'The REST API, from your own code',
                body: 'The REST API is plain HTTP over the same key and the same wallet. A data lookup and an AI answer are the two shapes of call:',
                code: [
                    `curl https://www.stockportfolio.pro/api/v1/financials/NVDA \\
  -H "Authorization: Bearer sp_live_your_key"`,
                    `curl -X POST https://www.stockportfolio.pro/api/v1/ask \\
  -H "Authorization: Bearer sp_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"question":"How did NVDA gross margin change year over year?"}'`
                ],
                note: 'Either header works: <code>Authorization: Bearer sp_live_...</code> or <code>X-Api-Key: sp_live_...</code>. Every path, parameter and response shape is in <a class="prose-link" href="/api">the API reference</a>.'
            }
        ],
        notes: [
            { title: 'Rate limit', body: '60 requests per minute per key. Past that you get a 429 — back off rather than retrying in a tight loop.' },
            { title: 'Lookups and AI answers are priced very differently', body: 'A lookup returns filed data and costs ' + COST.api_lookup + ' credits, on REST and MCP alike. An AI answer costs ' + COST.api_ask + ' on either surface, because it reads and reasons over whole filings. Structure integrations to use lookups for data and reserve AI answers for questions that genuinely need them.' },
            { title: 'Access is checked on every call', body: 'Not just when the key is created. If the plan behind a key lapses, the key stops working immediately with <code>API_ACCESS_REQUIRED</code>.' },
            { title: 'An assistant can try it before anyone buys a key', body: 'Call the MCP endpoint with no key at all and you get a small free allowance — ' + ANON.askLimit + ' AI answers and ' + ANON.lookupLimit + ' data lookups every ' + ANON.windowDays + ' days by default — so a client can see a cited answer before signing up. Past that it asks for a key, and a connector that signed in over OAuth keeps going without one.' },
            { title: 'Keep your key server-side', body: 'A key spends your credit allowance. Never ship one in client-side code or a public repository. Revoke and reissue from your profile if one is exposed.' },
            { title: 'The connector shows no tools', body: 'Restart the client. MCP configuration is read once at startup, so a server added to a running client stays invisible until it restarts.' },
            { title: 'Use the www host, not the bare domain', body: 'Every URL above carries <code>www</code> deliberately. The apex redirect from <code>stockportfolio.pro</code> to <code>www.stockportfolio.pro</code> drops the <code>Authorization</code> header, so a client pointed at the apex arrives as an anonymous caller and quietly falls back to the free allowance instead of your key.' }
        ],
        related: ['credits', 'plans', 'troubleshooting']
    },

    account: {
        slug: 'account', topic: 'Account',
        title: 'Your account — StockPortfolio.pro documentation',
        description: 'Manage your profile, subscription, credit usage, API keys and saved research.',
        heading: 'Your account',
        intro: 'Your <a rel="nofollow" class="prose-link" href="/profile.html">profile</a> is where everything personal lives: subscription, credit usage, API keys, saved dossiers and past Ask threads.',
        tier: 'Any account',
        costKey: null,
        steps: [
            'Open your <a rel="nofollow" class="prose-link" href="/profile.html">profile</a>.',
            'Check credits used, remaining and the reset date, with the activity list behind it.',
            'Manage your subscription — upgrade, downgrade or cancel. Changes to feature access apply on the next request.',
            'Create or revoke API keys if your plan includes them.',
            'Find saved work: past dossiers, Ask threads and Monitor reports are all kept.'
        ],
        notes: [
            { title: 'Cancelling keeps access to the paid period', body: 'A cancelled subscription runs to the end of what you paid for rather than cutting off immediately.' },
            { title: 'Support', body: 'Anything this documentation does not answer goes to <a class="prose-link" href="/support">support</a>, and a person replies within one business day.' }
        ],
        related: ['credits', 'plans', 'api-mcp']
    }
});

// Attach the derived fields once rather than repeating them in all 18 entries.
for (const [slug, page] of Object.entries(DOC_PAGES)) {
    page.slug = slug;
    page.path = '/docs/' + slug;
    page.updated = UPDATED;
    Object.freeze(page);
}


const SITE = 'https://www.stockportfolio.pro';

// Page-local styling only. Per the design brief this file must never style the
// nav or the footer — those are injected by V2.nav('')/V2.footer() and styled
// by system.css, and the whole point is that /docs looks like every other page.
// Accent here is --ink (black), not --accent (blue): a warm neutral #f0eee8
// carries the chips and markers. Because link colour then equals body colour,
// inline prose links need .prose-link's underline or they become invisible.
const STYLE = `
main.docs{padding:40px 0 72px}
.docs-shell{display:grid;grid-template-columns:232px minmax(0,1fr);gap:56px;align-items:start}
@media(max-width:900px){.docs-shell{display:flex;flex-direction:column;gap:36px}main.docs{padding:28px 0 56px}.docs-main{order:1}.docs-side{order:2;border-top:1px solid var(--line);padding-top:24px}}
.docs-side{position:sticky;top:24px}
@media(max-width:900px){.docs-side{position:static}}
.docs-filter{width:100%;height:36px;border:1px solid var(--line-strong);border-radius:var(--radius-sm,6px);padding:0 10px;font:inherit;font-size:var(--text-sm);background:var(--surface);color:var(--ink);margin-bottom:22px}
.docs-filter:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px #f0eee8}
.docs-group{margin-bottom:20px}
.docs-group > p{margin:0 0 7px}
.docs-side a{display:block;font-size:var(--text-sm);color:var(--ink-2);padding:5px 0;text-decoration:none}
.docs-side a:hover{color:var(--ink)}
.docs-side a[aria-current="page"]{color:var(--ink);font-weight:600}
.docs-empty{font-size:var(--text-sm);color:var(--ink-3);margin:0}
.crumb{font-size:var(--text-sm);color:var(--ink-3);margin:0 0 18px}
.crumb a{color:var(--ink-3);text-decoration:none}
.crumb a:hover{color:var(--ink);text-decoration:underline}
.docs-main{max-width:720px}
.docs-main h1{font-size:28px;line-height:1.2;font-weight:650;letter-spacing:-.02em;margin:0 0 12px}
.docs-lead{font-size:var(--text-base);line-height:1.65;color:var(--ink-2);margin:0}
.docs-meta{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0}
.chip{display:inline-block;font-size:var(--text-xs);letter-spacing:.04em;text-transform:uppercase;font-weight:600;color:var(--ink);background:#f0eee8;border-radius:100px;padding:5px 11px}
.docs-sec{margin-top:40px;padding-top:26px;border-top:1px solid var(--line)}
.docs-sec h2{font-size:21px;font-weight:600;letter-spacing:-.01em;margin:8px 0 0}
.docs-sec > p,.docs-sec li{font-size:var(--text-base);line-height:1.65;color:var(--ink-2)}
ol.steps{list-style:none;counter-reset:s;margin:18px 0 0;padding:0}
ol.steps li{counter-increment:s;position:relative;padding:0 0 18px 40px}
ol.steps li::before{content:counter(s);position:absolute;left:0;top:-1px;width:25px;height:25px;border-radius:50%;background:#f0eee8;color:var(--ink);font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center}
ol.steps li:last-child{padding-bottom:0}
.note-item{margin-top:18px}
.note-item b{display:block;font-size:var(--text-base);color:var(--ink);margin-bottom:4px}
.note-item p{margin:0;font-size:var(--text-base);line-height:1.65;color:var(--ink-2)}
table.costs{border-collapse:collapse;width:100%;margin-top:18px;font-variant-numeric:tabular-nums}
table.costs th,table.costs td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px}
table.costs th{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);font-weight:600}
table.costs td{font-size:var(--text-sm);color:var(--ink-2)}
table.costs td:last-child{text-align:right;color:var(--ink);font-weight:600;white-space:nowrap}
table.errs{border-collapse:collapse;width:100%;margin-top:18px}
table.errs th,table.errs td{text-align:left;border-bottom:1px solid var(--line);padding:11px 8px;vertical-align:top}
table.errs th{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);font-weight:600}
table.errs td{font-size:var(--text-sm);line-height:1.6;color:var(--ink-2)}
table.errs td:first-child{white-space:nowrap;color:var(--ink);font-weight:600}
@media(max-width:700px){table.errs,table.errs tbody,table.errs tr,table.errs td{display:block;width:100%}table.errs thead{display:none}table.errs tr{border-bottom:1px solid var(--line);padding:12px 0}table.errs td{border:0;padding:2px 0}}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:#f0eee8;border-radius:4px;padding:1px 5px}
kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82em;background:var(--surface,#fff);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;white-space:nowrap}
.setup{margin-top:26px;padding-top:22px;border-top:1px solid var(--line)}
.setup:first-of-type{margin-top:20px;padding-top:0;border-top:0}
.setup h3{font-size:var(--text-base);font-weight:600;color:var(--ink);margin:0 0 7px}
.setup > p{font-size:var(--text-base);line-height:1.65;color:var(--ink-2);margin:0}
.setup pre{background:#f0eee8;border:1px solid var(--line);border-radius:var(--radius-sm,6px);padding:13px 15px;margin:13px 0 0;overflow-x:auto}
.setup pre code{display:block;background:none;padding:0;font-size:12.5px;line-height:1.6;color:var(--ink);white-space:pre;overflow-wrap:normal}
.setup .setup-note{font-size:var(--text-sm);line-height:1.6;color:var(--ink-3);margin:11px 0 0}
.setup .setup-note code{background:transparent;padding:0;color:var(--ink-2)}
.prose-link{color:inherit;text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:2px}
.prose-link:hover{text-decoration-color:var(--ink)}
.rel a{display:block;font-size:var(--text-base);padding:7px 0;color:var(--ink);text-decoration:none}
.rel a:hover{text-decoration:underline}
.rel a span{color:var(--ink-3);font-weight:400}
.doc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:14px;margin-top:22px}
.doc-card{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px;text-decoration:none}
.doc-card:hover{border-color:var(--line-strong)}
.doc-card b{font-size:var(--text-base);color:var(--ink);margin:7px 0 5px}
.doc-card span{font-size:var(--text-sm);line-height:1.55;color:var(--ink-2);flex:1}
.doc-card em{font-style:normal;font-size:var(--text-xs);color:var(--ink-3);margin-top:12px}
.doc-hero{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin-top:22px;text-decoration:none}
.doc-hero b{display:block;font-size:19px;font-weight:600;color:var(--ink);margin:7px 0 6px}
.doc-hero span{display:block;font-size:var(--text-base);line-height:1.6;color:var(--ink-2);max-width:60ch}
`.replace(/\n/g, '');

// Every credit figure on every page comes through here, so there is exactly one
// place that could disagree with credits.COST — and it cannot, because it reads
// it. Do not add a second formatter.
function costLabel(key) {
    const n = COST[key];
    return n + (n === 1 ? ' credit' : ' credits');
}

// The one <head> in this file. free-tools.js repeats its head three times, which
// is why the cache stamp appears three times in that file; keeping it single
// here means the stamp lives in exactly two places on a rendered page (the
// stylesheet and the script), which is what docs-pages.test.js asserts.
function layout({ title, description, canonical, jsonld, body }) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${canonical}"><link rel="icon" type="image/png" sizes="48x48" href="/Media/icon.png?v=20260729-favicon1"><link rel="apple-touch-icon" href="/Media/icon.png?v=20260729-favicon1"><meta property="og:type" content="article"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap"><link rel="stylesheet" href="/assets/system.css?v=${STAMP}"><script type="application/ld+json">${JSON.stringify(jsonld)}</script><style>${STYLE}</style></head><body><main class="docs"><div class="container docs-shell">${body}</div></main><script src="/assets/app.js?v=${STAMP}"></script><script>V2.nav('');V2.footer();</script>${SEARCH_SCRIPT}</body></html>`;
}

// Client-side only, over the 18 entries already in the markup. There is no
// endpoint and no index to keep in sync, and with JavaScript off the filter box
// is simply hidden and the full list shows — which is the correct degradation
// for a page whose entire job is being readable.
const SEARCH_SCRIPT = `<script>
(function(){var box=document.getElementById('docs-filter');if(!box)return;box.hidden=false;
var links=[].slice.call(document.querySelectorAll('[data-s]')),groups=[].slice.call(document.querySelectorAll('.docs-group')),empty=document.getElementById('docs-empty');
box.addEventListener('input',function(){var q=box.value.trim().toLowerCase(),hits=0;
links.forEach(function(el){var on=!q||el.getAttribute('data-s').indexOf(q)>-1;el.style.display=on?'':'none';if(on&&el.matches('.docs-side a'))hits++;});
groups.forEach(function(g){var any=[].slice.call(g.querySelectorAll('a')).some(function(a){return a.style.display!=='none';});g.style.display=any?'':'none';});
if(empty)empty.hidden=hits>0;});})();
</script>`;

function sidebar(currentSlug) {
    const groups = TOPIC_ORDER.map((topic) => {
        const links = Object.values(DOC_PAGES).filter((p) => p.topic === topic).map((p) => {
            const current = p.slug === currentSlug ? ' aria-current="page"' : '';
            const hay = esc((p.heading + ' ' + p.description + ' ' + p.topic).toLowerCase());
            return `<a href="${p.path}" data-s="${hay}"${current}>${esc(p.heading)}</a>`;
        }).join('');
        return `<div class="docs-group"><p class="label">${esc(topic)}</p>${links}</div>`;
    }).join('');
    return `<aside class="docs-side"><input id="docs-filter" class="docs-filter" type="search" placeholder="Search docs&hellip;" aria-label="Search the documentation" autocomplete="off" hidden>${groups}<p class="docs-empty" id="docs-empty" hidden>No topic matches that.</p></aside>`;
}

function relatedBlock(page) {
    const items = (page.related || []).map((slug) => DOC_PAGES[slug]).filter(Boolean);
    if (!items.length) return '';
    const links = items.map((p) => `<a href="${p.path}">${esc(p.heading)} <span>&mdash; ${esc(p.description)}</span></a>`).join('');
    return `<section class="docs-sec"><p class="label">Related</p><div class="rel">${links}</div></section>`;
}

function notesBlock(page) {
    if (!page.notes || !page.notes.length) return '';
    const items = page.notes.map((n) => `<div class="note-item"><b>${esc(n.title)}</b><p>${n.body}</p></div>`).join('');
    return `<section class="docs-sec"><p class="label">Good to know</p>${items}</section>`;
}

// Per-client setup. `body` and `note` are authored HTML (same trust as `steps`);
// `code` is text and is escaped, so a snippet can contain <, > and quotes
// without being parsed as markup. `code` accepts one snippet or several.
function setupBlock(page) {
    if (!page.setup || !page.setup.length) return '';
    const items = page.setup.map((s) => {
        const snippets = (Array.isArray(s.code) ? s.code : (s.code ? [s.code] : []))
            .map((c) => `<pre><code>${esc(c)}</code></pre>`).join('');
        const note = s.note ? `<p class="setup-note">${s.note}</p>` : '';
        return `<div class="setup"><h3>${esc(s.title)}</h3><p>${s.body}</p>${snippets}${note}</div>`;
    }).join('');
    return `<section class="docs-sec"><p class="label">Connect a client</p><h2>Setup, by client</h2>${items}</section>`;
}

function costBlock(page) {
    if (!page.costTable) return '';
    const rows = page.costTable.map(([label, key]) => `<tr><td>${esc(label)}</td><td>${costLabel(key)}</td></tr>`).join('');
    return `<section class="docs-sec"><p class="label">What it costs</p><h2>Credit costs</h2><table class="costs"><thead><tr><th>Action</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function errorsBlock(page) {
    if (!page.errors) return '';
    const rows = page.errors.map((e) => `<tr><td><code>${esc(e.code)}</code></td><td>${esc(e.status)}</td><td>${esc(e.means)}</td><td>${e.fix}</td></tr>`).join('');
    return `<section class="docs-sec"><p class="label">Error reference</p><h2>What each error means</h2><table class="errs"><thead><tr><th>Code</th><th>Status</th><th>What it means</th><th>What to do</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderDocPage(slug) {
    // hasOwnProperty, not a plain lookup: DOC_PAGES['constructor'] and
    // ['toString'] resolve through Object.prototype and would otherwise render
    // a page with an undefined path and an empty title.
    if (!Object.prototype.hasOwnProperty.call(DOC_PAGES, slug)) return null;
    const page = DOC_PAGES[slug];
    if (!page) return null;
    const canonical = SITE + page.path;
    const chips = [`<span class="chip">${esc(page.tier)}</span>`];
    if (page.costKey) chips.push(`<span class="chip">${costLabel(page.costKey)}</span>`);
    else if (page.costKey === null) chips.push('<span class="chip">No credits</span>');
    const steps = (page.steps || []).map((s) => `<li>${s}</li>`).join('');
    const stepsBlock = steps
        ? `<section class="docs-sec"><p class="label">How to use it</p><h2>Step by step</h2><ol class="steps">${steps}</ol></section>`
        : '';
    const body = `${sidebar(slug)}<div class="docs-main"><p class="crumb"><a href="/docs">Docs</a> &rsaquo; ${esc(page.topic)} &rsaquo; ${esc(page.heading)}</p><h1>${esc(page.heading)}</h1><p class="docs-lead">${page.intro}</p><div class="docs-meta">${chips.join('')}</div>${stepsBlock}${setupBlock(page)}${costBlock(page)}${errorsBlock(page)}${notesBlock(page)}${relatedBlock(page)}<p class="crumb" style="margin:32px 0 0">Last updated ${esc(page.updated)}. Something missing? <a class="prose-link" href="/support">Tell support</a>.</p></div>`;
    return layout({
        title: page.title,
        description: page.description,
        canonical,
        jsonld: {
            '@context': 'https://schema.org', '@type': 'TechArticle',
            headline: page.heading, description: page.description, url: canonical,
            isAccessibleForFree: true, inLanguage: 'en',
            publisher: { '@type': 'Organization', name: 'stockportfolio.pro', url: SITE }
        },
        body
    });
}

function renderDocsIndex() {
    const canonical = SITE + '/docs';
    const hero = DOC_PAGES['getting-started'];
    const cards = Object.values(DOC_PAGES).filter((p) => p.slug !== 'getting-started').map((p) => {
        // Only features that actually cost something carry a price. Printing
        // "No credits" on the eleven that don't turns the one useful signal on
        // this card into noise.
        const meta = p.costKey ? `${esc(p.tier)} &middot; ${costLabel(p.costKey)}` : esc(p.tier);
        const hay = esc((p.heading + ' ' + p.description + ' ' + p.topic).toLowerCase());
        return `<a class="doc-card" href="${p.path}" data-s="${hay}"><p class="label">${esc(p.topic)}</p><b>${esc(p.heading)}</b><span>${esc(p.description)}</span><em>${meta}</em></a>`;
    }).join('');
    const body = `${sidebar(null)}<div class="docs-main" style="max-width:none"><p class="label">Documentation</p><h1>How to use StockPortfolio.pro</h1><p class="docs-lead">Every feature, what it does, what it costs and which plan it is on. Written against the product as it actually behaves.</p><a class="doc-hero" href="${hero.path}"><p class="label">Start here</p><b>${esc(hero.heading)}</b><span>${esc(hero.description)}</span></a><div class="doc-grid">${cards}</div></div>`;
    return layout({
        title: 'Documentation — how to use StockPortfolio.pro',
        description: 'Documentation for every StockPortfolio.pro feature: Ask, Research Dossiers, the Filing Monitor, the screener, portfolios, credits, plans and the API.',
        canonical,
        jsonld: {
            '@context': 'https://schema.org', '@type': 'CollectionPage',
            name: 'StockPortfolio.pro documentation', url: canonical, inLanguage: 'en',
            hasPart: Object.values(DOC_PAGES).map((p) => ({ '@type': 'TechArticle', headline: p.heading, url: SITE + p.path }))
        },
        body
    });
}

module.exports = { DOC_PAGES, TOPIC_ORDER, STAMP, renderDocsIndex, renderDocPage };
