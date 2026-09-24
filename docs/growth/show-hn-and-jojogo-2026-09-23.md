# Show HN post + AppSumo reply to jojogo (drafts, 2026-09-23)

Both need the owner's accounts (Hacker News, AppSumo partner portal), so they
are drafts. Facts verified live on 9/23: keyless `POST /mcp` answered a real
`sp_financials NVDA` call from production; keyless allowance is 2 AI asks + 50
lookups per IP per 30 days (`mcp-anon.js`), global ceiling 100 keyless asks/day.

## Show HN

**Title (67 chars):**
Show HN: An MCP server that cites the SEC filing behind every number

**URL:** https://www.stockportfolio.pro/api

**Text:**

I run StockPortfolio.pro, a research tool that answers questions about US
companies from their SEC filings. The MCP server is the part I think people
here will find useful.

The problem it solves: ask a general assistant what a company's free cash flow
was last year and you get a confident number you can't check. This server
returns values as filed in 10-Ks and 10-Qs, each tagged with its fiscal period
and an SEC source link. If a company never filed a figure, you get null, not an
estimate.

You can try it without signing up. The keyless tier gives 50 lookups and 2 AI
questions per IP every 30 days:

    claude mcp add --transport http stockportfolio https://www.stockportfolio.pro/mcp

Cursor or any HTTP MCP client can point at the same URL, and there's an npm
bridge for stdio clients: `npx -y stockportfolio-mcp`.

Tools: financial statements going back up to 19 years, the 10-K/10-Q/8-K
timeline, a two-company comparison, watchlist ranking, and an Ask tool that
answers in English and labels whether each part came from a filing, fund data
or the web.

Limits, up front: US-listed, USD-reporting companies only, and no price data.
It's a solo project. What I'd most like to hear is any case where a number
doesn't match the filing.

**Before posting:**
- Post on a weekday, 8-10am US Eastern.
- The keyless AI questions stop at 100/day across everyone
  (`ANON_MCP_GLOBAL_ASK_DAY`). A front-page day would hit that within hours;
  lookups aren't capped that way. Decide whether to raise it for the day.
- Singapore and China visitors get a 402 on keyless access (geo wall), so a
  commenter there will see "not available in your region".

## AppSumo reply to jojogo

(Their question, 9/22: "Is there any integration with Tradingview? ... I could
tie in my research on stockportfolio.pro by using your sort function then
overlap with my tradingview system criteria to find certain good trades.")

> Thanks for this. It was a good enough idea that we built it this week.
>
> The screener now has an **Export to TradingView** button. Run a screen on
> fundamentals (growth, margins, debt, whatever you filter on), sort it however
> you like, then export. You get the tickers in that order as the
> comma-separated list TradingView's watchlist "Import list" accepts. Import it
> and apply your own TradingView criteria on top.
>
> It's on the Investor and Pro tiers.
>
> It's one-way (StockPortfolio.pro → TradingView) for now; there's no live sync.
> If you try it and the workflow is missing a step, reply here and tell me which
> step.
>
> Avinash
