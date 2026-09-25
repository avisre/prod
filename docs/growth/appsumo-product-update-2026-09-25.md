<!--
AppSumo product update post — 2026-09-25. Format and heading style mirror the 9/23 post exactly:
declarative claim headings, clipped fragments, the "…, generally" catch-all, "One honest ask" with
"No rating requested, nothing offered in return." Everything shipped after the 9/23 v7 update post.
Verified before writing (not assumed): origin/main == e74b183e with all features pushed;
/docs/api-mcp 200 from outside; review count 3 (last post said two); API/MCP boundary per the live
402 message ("purchased on or before 22 September 2026"); costs 2/42 with MCP == REST; AI portfolio
creator framed from the owner's ~/.claude/plans/drafta-very-consie-update-gentle-flute.md,
in-development, no date claimed. No model/provider identity, no call offers, no "resonates".
Paste from "Product Update" down.
-->

Product Update

Hey everyone — quick one again from the founder's chair.

The portfolio page got rebuilt this week, after the fund pages. Everything below is live now on every AppSumo tier — open your dashboard and look.

Every fund in your portfolio now opens to the companies underneath

Not the ticker you typed in — the portfolio your funds actually run. The X-Ray reads each fund's own SEC holding report and expands it: a three-ticker portfolio turns out to be 3,514 companies. The largest single exposure gets named — NVIDIA at 6.8%, reached through VOO and VTSAX, not typed in by anyone. An unreadable fund is named with its weight, and bonds and cash inside funds show as held, not companies.

Purchase dates you can trust

Reflecting your dates back turned up something worth sharing: since launch, a holding added without a date silently got the day you added it written into its purchase-date field — our clock, dressed up as your memory. Stopped at every place a holding can be written. The new "Since you bought" section counts time held only from a date you actually gave — total and per position, "you paid $X → $Y today". No date, no duration: counted and disclosed, never estimated.

Your portfolio page, rebuilt

Adding a holding now gets an arrival, not a flash-and-vanish tick — real counts, nothing estimated, the total settling to its true value. A failure says "Nothing was changed — your portfolio is exactly as you left it." And a partial multi-add is called exactly that, never a claim that the whole thing went live.

Filing alerts, generally

Three show at a time and the rest scroll. An empty list — which used to look identical whether the monitor was working or broken — now says "Nothing material filed since you last looked", with what it can measure: companies watched, when the SEC was last read, when the last alert was.

The Dossier now draws the income statement as a flow

Revenue in at the top, each figure it survives to as the next band — gross profit, operating income, pre-tax, net income — the cost between two figures labelled as its own band, segments flowing in by size. Every band is the exact arithmetic difference from the filing: the chart cannot draw a number the filing doesn't support.

The API and MCP server now has a real setup guide

A buyer asked whether one existed. The honest answer was no. /docs/api-mcp is now step by step, per client: Claude, Claude Code, ChatGPT, the Anthropic and OpenAI APIs, any other MCP client, the npm bridge, plain REST. It will never tell you to paste a key into Claude or ChatGPT — both connect through OAuth.

Access, plainly: bought on or before 22 September, API and MCP are included on every tier. From 23 September, they ship on Pro. A lookup costs 2 credits, an ask 42, and MCP and REST cost the same, action for action.

Smaller things this week

    Screener results export to TradingView, one click (Investor and Pro tiers)

    Recharge credits no longer expire at the month boundary

    The free verify page strikes through the told figure and stamps the filed one beside it, and a formatter printing "$15.5 billion" as "$16 billion" is fixed

    The market strip was silently going empty for some symbols — caught, dropped, pinned by a test

What's next: an AI portfolio creator

One click on AI Portfolio, and the AI does the research itself and hands you a stock pick for the week — built on our own proprietary data and workflow, the same filing-cited numbers behind Ask, landing straight into the portfolio you already use, watched by the Filing Monitor, opened by the X-Ray. It's showing promising results in testing. No date promised — you'll read it here first.

One honest ask

Three reviews so far — up one since the last note. If you've spent real time in the product, an honest one helps a great deal — positive, mixed or critical. No rating requested, nothing offered in return. It lives at appsumo.com/account/products.

And the ask that matters more: reply here or email support@stockportfolio.pro with what's missing or confusing. I read everything — and the next upgrade starts with your reply.

One more thing — the deal is in its final window. If you've been meaning to grab a higher tier, sooner beats later.

— Avinash

Founder, StockPortfolio.pro