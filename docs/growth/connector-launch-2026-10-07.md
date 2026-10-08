# Connector launch — Claude and ChatGPT directory listings (2026-10-07)

Drafts only. Nothing here has been sent or posted.

**Before any of it goes out:** open both public listing pages in a logged-out window and confirm
they load, then record the ChatGPT URL in `lib/connector-listings.js` (or `CHATGPT_LISTING_URL`).
Every link below goes to `/connect`, which carries the listing links, so the copy does not change
when a URL does.

Wording that stays true: "listed in the Claude connector directory", "listed in the ChatGPT app
directory". Not "partner", "official", "certified" or "endorsed" — the Claude entry is a community
connector.

Free allowance quoted below is the default (3 AI answers, 25 lookups, per 30 days). If
`ANON_MCP_*` is changed on Render, change the copy.

---

## 1. Email to existing customers

**Audience:** live paying accounts, built from the accounts collection at send time — not from a
past broadcast list. Exclude `rin@gmail.com` and the reviewer account.

Two versions, because what the reader can do differs by plan.

### 1a. Plans with API and MCP access (Dev, Power, Desk, Investor/Pro lifetime, pre-23-Sep lifetime)

**Subject:** StockPortfolio now works inside Claude and ChatGPT

Hi {first_name},

StockPortfolio is now listed in the Claude connector directory and the ChatGPT app directory.

That means you can ask about a company in the assistant you already have open and get the filed
numbers back, each with the SEC filing it came from. Your plan already includes it, and it spends
the same credits as the website: 2 per data lookup, 42 per AI answer.

To set it up:

1. Open https://www.stockportfolio.pro/connect?utm_source=email&utm_campaign=connector_launch
2. Pick Claude or ChatGPT and add StockPortfolio from the directory.
3. Sign in with this email address when it asks. There is no key to paste.

A good first question: "What did NVIDIA report for revenue and free cash flow last fiscal year?
Cite the filing."

If anything in the setup does not behave, reply to this email and I will sort it out.

Avinash
StockPortfolio.pro

### 1b. Plans without API and MCP access

**Subject:** Try StockPortfolio inside Claude or ChatGPT, free

Hi {first_name},

StockPortfolio is now listed in the Claude connector directory and the ChatGPT app directory.

You can add it and try it without changing your plan: 3 AI answers and 25 data lookups every 30
days, free, each figure cited to its SEC filing.

https://www.stockportfolio.pro/connect?utm_source=email&utm_campaign=connector_launch

Using it beyond the free allowance needs a plan with API and MCP access. The plans page shows
which ones: https://www.stockportfolio.pro/docs/plans

If you have a question about it, reply here.

Avinash
StockPortfolio.pro

---

## 2. AppSumo

### 2a. Listing copy — API + MCP row (for the v8 draft, `docs/growth/appsumo-listing-v8.md`)

Portal values were not touched. Proposed replacement for the hosted-endpoint line (currently
"Works as a hosted MCP endpoint for any MCP-compatible client, or as a REST API…"):

> Listed in the **Claude connector directory** and the **ChatGPT app directory** — add it in one
> step and sign in, no key to paste. Also a **hosted MCP endpoint** for any other MCP-compatible
> client, and a **REST API** with a key you create yourself.

Proposed FAQ slot (one of the five still open):

> **Can I use it inside ChatGPT or Claude?**
> Yes. StockPortfolio is listed in both directories. Add it there and sign in with your
> StockPortfolio account; it spends the same monthly credits as the website. API and MCP access
> is on the Investor and Pro tiers, and on any tier purchased on or before 22 September 2026.

### 2b. Review ask — only to buyers who have already replied to support

**Subject:** One thing that is new, and a small ask

Hi {first_name},

Since you last wrote, StockPortfolio went live in the Claude connector directory and the ChatGPT
app directory. If you use either, it is one step to add:
https://www.stockportfolio.pro/connect?utm_source=email&utm_campaign=appsumo_connector

If the product has been useful to you, an honest review on AppSumo would help a great deal — three
reviews is all there is so far, and buyers read every one:
https://appsumo.com/products/stockportfoliopro/#reviews

Either way, thank you for the feedback so far.

Avinash

---

## 3. Launch posts

Tracked link pattern: `https://www.stockportfolio.pro/connect?utm_source=<x|linkedin|reddit|hackernews>&utm_campaign=connector_launch`

### X

> StockPortfolio is now listed in the Claude connector directory and the ChatGPT app directory.
>
> Ask about any US company and get the filed numbers back, each one linked to the SEC filing it
> came from. Nothing estimated; if the filing is silent, the value is empty.
>
> Free to try, no account: 3 answers + 25 lookups.
> https://www.stockportfolio.pro/connect?utm_source=x&utm_campaign=connector_launch

Reply to own post with a screenshot of one cited answer inside each assistant.

### LinkedIn

> Assistants are good at explaining a company and unreliable at quoting its numbers. The fix is
> not a better prompt, it is a source.
>
> StockPortfolio is now listed in the Claude connector directory and the ChatGPT app directory.
> Add it once and questions about a US-listed company are answered from its own 10-K, 10-Q and
> 8-K filings, with the filing linked beside every figure. Where a filing does not report a value,
> you get an empty field, not a guess.
>
> It is free to try without an account (3 AI answers and 25 data lookups every 30 days).
>
> https://www.stockportfolio.pro/connect?utm_source=linkedin&utm_campaign=connector_launch

### Hacker News (Show HN)

**Title:** Show HN: SEC filing data as a connector in Claude and ChatGPT, every figure cited

> I built a hosted MCP server over US SEC filings and it was accepted into the Claude connector
> directory and the ChatGPT app directory this week.
>
> What it does: a small set of read-only tools — company search, fundamentals by fiscal period,
> filing search, one filing, and a filing-grounded answer. Every value carries the filing it was read from. A
> value the filing does not report is null and is never interpolated. Prices and market cap are
> deliberately not in it, because I do not hold redistribution rights to a quote feed.
>
> Things that were harder than expected: both clients require OAuth and cannot send a static key,
> so the server does dynamic client registration; the two directories review different things;
> and a keyless free tier turned out to be necessary, because a directory user will not create an
> account before seeing one answer.
>
> Free without an account: 3 AI answers and 25 lookups per 30 days. After that it is $79.99/month.
>
> https://www.stockportfolio.pro/connect?utm_source=hackernews&utm_campaign=connector_launch
>
> Setup notes for every client, including the raw endpoint: https://www.stockportfolio.pro/docs/api-mcp

Post from the owner's own account and stay in the thread; HN flags launch posts whose author does
not answer.

### Reddit

Read each subreddit's self-promotion rule first; several investing subs remove product posts
outright. r/ClaudeAI, r/ChatGPT, r/mcp and r/SideProject allow them with disclosure.

**Title:** I got an SEC-filings connector listed in both the Claude and ChatGPT directories — what I learned

> Disclosure: I built this.
>
> It answers questions about US-listed companies from their own SEC filings and links the filing
> next to each number. If a filing does not report something, it returns empty instead of guessing,
> which is the part I cared most about.
>
> Free to try with no account (3 answers, 25 lookups per 30 days):
> https://www.stockportfolio.pro/connect?utm_source=reddit&utm_campaign=connector_launch
>
> Happy to answer questions about the review process for either directory, or about the OAuth
> side, which took the longest.

---

## 4. Reading the result

Baseline these before the first post, then compare a week later (exclude `rin@gmail.com` and the
reviewer account):

| Step | Event / source |
| --- | --- |
| Connector installed | `mcp_oauth_client_registered` |
| Signed in from the assistant | `mcp_oauth_authorized` |
| Wanted more than the free tier | `mcp_keyless_cap_hit` |
| Came to the site from the assistant | attribution source `chatgpt`, `claude` |
| Clicked the upgrade link inside the assistant | attribution source `connector` |
| Paid | Monthly checkouts with one of those sources (the cap-hit link goes to Monthly since 2026-10-08; Dev before) |

Check distinct user agents before quoting any visitor count from `/connect` — most first-party
"visitors" on this site are bots.
