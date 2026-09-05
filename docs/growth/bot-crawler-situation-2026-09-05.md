# Bot / crawler situation — full context brief

**Written 2026-09-05.** Self-contained handoff so a fresh session needs no prior thread.
Every number below was measured live against production Mongo on this date; the exact
queries are included so they can be re-run rather than trusted.

---

## TL;DR

- **68% of all traffic is bots** (15,355 of 22,417 classified events since 2026-07-30).
- **Meta's AI crawler alone is 11,832 hits — 53% of ALL traffic on the site.** Steady,
  not accelerating.
- The AI companies **self-identify by user agent**, so they are individually
  identifiable and contactable. Full inventory below.
- ~~**`robots.txt` currently says `User-agent: *` / `Allow: /`**~~ — **CORRECTED, see
  "Corrections to this brief".** `robots.txt` has had a full AI-crawler section since
  2026-07-24. Meta was simply *absent* from it, so it inherited `*` / `Allow: /`.
- **ACTION TAKEN 2026-09-05: all bots are now blocked except Googlebot and Bingbot,
  and the block is enforced server-side (403), not merely requested in robots.txt.**
  See "What was changed" at the bottom, including what it costs.
- **A previous claim of a "Singapore bot farm" was WRONG and is retracted** — see the
  correction section. Do not carry it forward.

---

## Where the data lives

`funnel_events` (Mongo, `strict:false` schema at `backend/app.js:2800`) stores per-request
attribution written by `backend/marketing-attribution.js`. **22,417 events carry a
classified user agent**, starting 2026-07-30.

Fields that matter:

| field | coverage | notes |
|---|---|---|
| `userAgent` | 22,414 | full UA string |
| `trafficClass` | 22,414 | `crawler` / `browser` / `automation` / `unknown` |
| `isBot` | 22,414 | boolean |
| `referrer` | 21,164 | |
| `country` | 7,340 | ISO-2; **partial coverage — do not treat as a full census** |
| `ip` | **0** | never stored. No IP-level identification is possible. |

Connect from `backend/` (deps live there, not repo root):

```js
require("dotenv").config();               // backend/.env holds MONGODB_URI
const m = require("mongoose");
await m.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
const f = m.connection.db.collection("funnel_events");
```

Node on PATH may be old; the working binary on this machine is `/opt/homebrew/bin/node`
(v26.4.0). The `~/.nvm/.../v22.22.0` path named in CLAUDE.md **does not exist here**.

---

## Measured: traffic composition

```
crawler      13,900
browser       7,062
automation    1,305
unknown         147
             ------
             22,414   (isBot: 15,355 = 68%)
```

**Distinct paths crawled by bots: 11,879. By humans: 1,309.** Bots are enumerating the
entire long-tail SEC page inventory; humans touch a tenth of it.

---

## Measured: the named AI crawlers (the contactable list)

```js
f.countDocuments({ userAgent: { $regex: "<pattern>", $options: "i" } })
```

| Company | UA pattern | Hits | Last seen |
|---|---|---:|---|
| **Meta AI** | `meta-externalagent` | **11,832** | 2026-09-04 |
| Anthropic | `claude-user`, `anthropic-ai`, `claudebot` | 74 | 2026-09-04 |
| Amazon | `amazonbot` | 65 | 2026-08-30 |
| OpenAI | `chatgpt-user`, `oai-searchbot`, `gptbot` | 40 | 2026-09-03 |
| ByteDance | `bytespider` | 37 | 2026-09-04 |
| Apple | `applebot` | 17 | 2026-09-04 |
| Perplexity | `perplexity` | 5 | 2026-09-03 |
| Mistral | `mistral` | 2 | 2026-08-25 |

No hits for Google-Extended, Cohere, Common Crawl, Diffbot or xAI in this window.

### Meta crawl rate per day — steady, NOT accelerating

Spiked **1,496 on 2026-07-30** (first day of logging, likely an initial full crawl), then
settled into a variable **150–600/day** band with no upward trend. Recent: 380 (9/1),
255 (9/2), 231 (9/3), 434 (9/4).

What Meta takes: `/stocks`, `/compare/<A>-vs-<B>`, individual `/stocks/<TICKER>` pages —
i.e. the public SEO inventory, exactly what the free tier is designed to expose.

### The unidentifiable remainder

`trafficClass: automation` (1,305) is anonymous and not a sales prospect:
~1,122 HeadlessChrome (versions 143–151) and 141 `curl/8.18.0`. **Some of this is
likely our own Playwright/screenshot harness** — it has not been separated out.

---

## Corrections to this brief (added 2026-09-05, after reading the code)

Two claims in the original draft were checked against the repo and are **wrong**:

1. **"`robots.txt` contains no AI-crawler rules at all."** False. `frontend/robots.txt`
   has carried a ~20-agent AI section since 2026-07-24 — GPTBot, ChatGPT-User,
   OAI-SearchBot, anthropic-ai, ClaudeBot, Claude-Web, PerplexityBot, Perplexity-User,
   Google-Extended, Applebot-Extended, CCBot, Bytespider, Amazonbot, cohere-ai, Diffbot,
   FacebookBot, facebookexternalhit. `git show main:frontend/robots.txt` confirms this is
   live, not branch-only. The real gap was narrower and more specific: **`meta-externalagent`
   was never listed**, so the single heaviest crawler on the site inherited `*` / `Allow: /`.
2. **"`_marketingRequestFields` is never consumed / the dashboard panel is half-wired
   WIP."** False — see Code state below. It renders.

The business conclusion survives both corrections, but the reasoning changes: the problem
was never "we allow everything", it was "we curated a list and Meta wasn't on it".

## CORRECTION: there is no Singapore bot farm

An earlier session claimed a Singapore bot farm based on GA4 (Singapore = 291 of 440
active users, 66%, with 15s average engagement). **Server-side data does not support
this.** Of 22,417 classified events, **Singapore is 43**. Recorded countries skew
US / DE / RU / IN / GB:

```
US crawler 1927 | DE crawler 1671 | DE browser 1314 | US browser 697
RU crawler  506 | US automation 255 | IN automation 173
```

Caveat: `country` is only present on 7,340 of 22,417 events, so this is a sample, not a
census. The GA4 Singapore figure remains **unexplained** — it is a genuine open question,
but it is not corroborated by our own logs and must not be restated as fact.

---

## Code state

- `backend/marketing-attribution.js` — `classifyUserAgent()` (line ~155) has an
  `ai_agent` branch matching `chatgpt-user|claude-user|perplexity-user|google-extended|
  anthropic-ai|meta-externalagent|cohere-ai|oai-searchbot`, plus a generic bot/crawler
  branch. `recordTouch()` builds `userAgent`/`trafficClass`/`isBot`/`country` onto
  `req._marketingRequestFields`.
- `_marketingRequestFields` is written in `requestFields()`
  (`marketing-attribution.js:338`) and read back on the same request at line 307.
- The admin dashboard panel **is wired end to end**, not half-wired: `directUaMap` is
  built at `app.js:11343`, returned as `directBreakdownRows` at `11385`, rendered to
  rows at `11603`, wrapped as `directBreakdownPanel` at `11615`, and spliced into the
  page at `11618`. It is still **unreviewed and untested**, which is a different problem
  from being unfinished.
- That work was **committed** in `d22e0880` on branch `relist-credit-meter`, which
  `git branch --contains` confirms is **not on `main`**. So the `ai_agent` traffic class
  **is not running in production** — which is exactly why the composition table above
  has no `ai_agent` bucket and Meta's 11,832 hits land in `crawler` instead (Meta's UA
  string ends in `.../webmasters/crawler`, which the generic branch matches).
- `robots.txt` is served from `frontend/robots.txt` (route at `app.js:9643`, also
  reachable through `express.static` at `2337`) with `Cache-Control: max-age=3600` — one
  hour, so a change to it goes live promptly. It is **not** subject to the `?v=` stamp
  rule that governs `.js`/`.css`.

---

## The business question, assessed honestly

The idea under consideration was: identify the crawlers, then sell them MCP access.

**Arguments against, which should be answered before any effort goes in:**

1. **You are already giving it away.** `Allow: /` means nobody needs to buy what they
   can take. There is no leverage in an inbound pitch against a free, permitted feed.
2. **The volume isn't there except for Meta.** Anthropic at 74 hits and OpenAI at 40 are
   a rounding error, not a licensing conversation.
3. **Blocking has a real cost.** `chatgpt.com` and `copilot.microsoft.com` send actual
   human referral sessions today (Clarity 7-day: chatgpt.com 2, copilot 1; GA4:
   `chatgpt.com/ai-assistant` 3 users). Disallowing those crawlers removes the site from
   the answer surfaces producing that traffic.

**The one asymmetry worth acting on:** Meta took 11,832 pages and returns no referral
traffic whatsoever, where OpenAI's 40 hits do send humans back. A `Disallow` targeted at
`meta-externalagent` **only** — leaving OpenAI, Anthropic and Perplexity allowed — costs
nothing currently being received, and is the only move that creates a reason for anyone
to discuss terms.

**The MCP play that more plausibly makes money** is not selling to labs but using MCP as
a *distribution channel to developers and analysts* who would pay $39–149 themselves.
See `docs/growth/mcp-directory-listings.md` (exists, never opened).

---

## Open questions / not yet known

- Why does GA4 report 66% Singapore when server logs show 43 events? Unresolved.
- How much of `automation` (1,305) is our own Playwright harness vs third-party scrapers?
  Not separated.
- Bandwidth/compute cost of serving 15,355 bot requests — never measured. Note the
  Monitor/Dossier cache means marginal cost per *cached* page is ~0.
- Whether Meta's crawl respects `robots.txt` `Disallow` in practice — untested.
- No IP data is stored, so ASN/datacenter attribution is impossible without adding it.

## Reproducing the headline numbers

```js
// composition
f.aggregate([{$match:{trafficClass:{$ne:null}}},{$group:{_id:"$trafficClass",n:{$sum:1}}},{$sort:{n:-1}}])
// one company
f.countDocuments({userAgent:{$regex:"meta-externalagent",$options:"i"}})
// daily trend
f.aggregate([{$match:{userAgent:{$regex:"meta-externalagent",$options:"i"}}},
  {$group:{_id:{$dateToString:{format:"%Y-%m-%d",date:{$ifNull:["$at","$timestamp"]}}},n:{$sum:1}}},{$sort:{_id:1}}])
// what they take
f.aggregate([{$match:{userAgent:{$regex:"meta-externalagent",$options:"i"}}},
  {$group:{_id:"$path",n:{$sum:1}}},{$sort:{n:-1}},{$limit:20}])
// country x class
f.aggregate([{$match:{country:{$ne:null}}},{$group:{_id:{c:"$country",t:"$trafficClass"},n:{$sum:1}}},{$sort:{n:-1}}])
```

---

## What was changed (2026-09-05)

The first pass here was a Meta-only `Disallow`. The owner overrode it: **block all
bots except Google and Bing, and enforce it server-side.** That is what shipped.

### 1. Enforcement — `backend/bot-blocker.js` (new)

robots.txt is a request. The 1,305 headless-Chrome and curl events in this document
are proof that the crawlers costing the most are the ones that ignore it. So the
policy is enforced in middleware, mounted at `app.js:339` — ahead of the rate
limiters, `ssrCacheMw` and `express.static`, so a refused crawler costs one regex
rather than an SSR render.

Blocked: named AI crawlers (Meta, OpenAI, Anthropic, Perplexity, Google-Extended,
Apple, Amazon, ByteDance, Cohere, CCBot, Diffbot), non-Google/Bing search engines,
SEO backlink scrapers (Semrush, Ahrefs, MJ12, Dot, BLEX), headless browsers, HTTP
libraries (curl, wget, python-requests, Scrapy, Go, okhttp, Postman), and empty
user agents. Response is `403` plus a licensing contact address.

**Never blocked, whatever the user agent:**

| exempt | why |
|---|---|
| `/stripe/webhook`, `/appsumo/webhook` | These sit **outside `/api`** and arrive from non-browser agents. Blocking them silently breaks purchases and LTD redemptions. This is the single most dangerous edge in the change. |
| `/api/*` | Auth'd and separately rate-limited; also the MCP server and the app's own browser XHR, which must not be UA-filtered. |
| `/robots.txt`, `/sitemap.xml`, `/sitemaps/*`, `/llms*.txt`, `/.well-known/*` | A blocked crawler must still be able to read the rules it is bound by. |

**A user agent is a self-declaration, so it is not the only check.** Four layers,
each catching what the one above it cannot:

| layer | catches | how |
|---|---|---|
| 1. UA denylist | Bots that admit what they are | Pattern match. Most named AI crawlers self-identify on purpose - it is how they ask to be recognised. Useless against a liar. |
| 2. IP verification | "I am Googlebot" impostors | Reverse DNS the client IP, require an official hostname, then **forward-resolve that hostname and require it back to the same IP**. Anyone can point a PTR record at googlebot.com; nobody else can change what googlebot.com resolves to. Google's own documented method. |
| 3. Header consistency | A Chrome UA string pasted onto curl | Real Chromium 89+ always sends `sec-ch-ua`; Chrome/Firefox/Safari send `sec-fetch-*`; every browser sends `accept-language`. A forged UA usually sends none. **Any one of them present clears the request** - deliberately lenient, so a stripping proxy is never mistaken for a scraper. |
| 4. Per-IP page rate | A scraper that lies flawlessly | Real headless Chrome, real headers, rotating UAs - nothing about the request identifies it, so the only tell left is behaviour. 100 page navigations per IP per 5 minutes. A reader never reaches it; a crawler enumerating 11,879 paths does nothing else. Assets and verified crawlers are exempt. |

Layer 2 matters more than it looks: the moment the policy became "Google and Bing
only", the cheapest move available to every scraper became claiming to be Googlebot.
Without the forward-confirm step, the allowlist would be the vulnerability.

It **fails open** on first sight of an unseen crawler IP: the first request is served
while the lookup runs, because blocking real Googlebot over a slow DNS response costs
far more than the handful of requests an impostor gets in the meantime. Verdicts are
cached per IP for 6 hours, and a DNS *failure* resolves to "unknown" and is retried -
never to "impostor", so a DNS incident cannot deindex the site.

**What none of this stops, stated plainly:** a scraper running real headless Chrome
behind a rotating residential proxy pool, staying under the rate limit, is
indistinguishable from a human at the application layer. No Express middleware fixes
that - it needs something at the network edge that sees traffic across many sites.
Cloudflare's free tier (Bot Fight Mode / managed challenge) in front of Render is the
obvious next step and would be stronger than everything above combined. What this
module does is raise the cost from *zero* to *you need a proxy pool and patience*.

**Switches** — `BOT_BLOCK_ENABLED=false` (kill switch), `BOT_BLOCK_DRY_RUN=true`
(log what would be blocked, block nothing), `BOT_BLOCK_BYPASS_TOKEN` with the
`x-bot-bypass` header, or the marker `stockportfolio-internal` anywhere in the UA —
**our own Playwright/screenshot harness looks exactly like a scraper and needs one of
these two.**

### 2. Declaration — `frontend/robots.txt` rewritten

`User-agent: *` is now `Disallow: /`. Googlebot, Googlebot-Image,
Google-InspectionTool, Storebot-Google, Bingbot and BingPreview are allowed;
~30 named agents are explicitly refused. `Google-Extended` gets its own refusal
group so that a future "let's allow Google" edit cannot quietly re-admit Google's
AI training crawler, which is a different agent from Googlebot.

### 3. Tests — 17, all passing

`backend/test/bot-blocker.test.js` (10) and a rewritten
`backend/test/robots-policy.test.js` (7). The load-bearing test asserts that
**robots.txt and bot-blocker.js agree agent by agent**: they are one policy living in
two files, and drift is silent in both directions — robots.txt saying yes while the
server 403s, or saying no while the server serves. Also pinned: real browser UAs are
never blocked, and the payment webhooks survive a blocked user agent.

```
cd backend && node --test test/bot-blocker.test.js test/robots-policy.test.js
```

No existing test loads `app.js` (nothing uses supertest), so the new middleware
could not have broken the rest of the suite.

## What this costs, stated plainly

- **Social link previews are off.** facebookexternalhit, Twitterbot, LinkedInBot and
  Slackbot are refused, so posts linking this site on X, LinkedIn, Facebook or Slack
  render as a bare URL with no title card. This is the one blocked group that costs
  *us* rather than them. Reversal is one line: `ALLOW_SOCIAL_PREVIEWS = true` in
  bot-blocker.js, plus allowing them in robots.txt.
- **DuckDuckGo, Yandex, Baidu and Apple search are gone**, along with the AI answer
  surfaces. chatgpt.com and copilot.microsoft.com were sending a small number of real
  human sessions (Clarity 7-day: 2 and 1); those stop.
- **Any uptime monitor hitting `/` with no user agent now gets a 403.** Nothing in
  the exempt list covers `/`. Check this after deploy.
- Organic search via Google and Bing is untouched, which is where the traffic
  actually comes from.

## After deploy — what to watch

1. **Search Console + Bing Webmaster crawl stats.** Googlebot and Bingbot fetches
   should be unchanged. Any drop means the allowlist is wrong, and that is the one
   failure worth reverting for immediately (`BOT_BLOCK_ENABLED=false`).
2. **A test purchase.** The webhook exemption is asserted in tests, but it is the
   highest-cost failure in this change and deserves one real confirmation.
3. **`stats()` from the blocker**, and the daily-trend query above. It now also
   reports `verifiedCrawlerIps` and `impostorCrawlerIps` — **a non-zero impostor count
   is the interesting number**, because it means something was actively posing as
   Googlebot to get past the allowlist. Meta holding at 150–600/day in `funnel_events`
   while the blocker reports refusals means Meta is ignoring robots.txt and being
   stopped anyway, which is a concrete fact to open a licensing conversation with.
4. **`forged-browser` and `rate-limit` counts in `stats()`.** These are the two layers
   that can touch real users. If either shows meaningful volume against addresses that
   look like readers, loosen it: raise `BOT_BLOCK_NAV_MAX`, or drop layer 3.

Optional, and worth 24 hours first: deploy with `BOT_BLOCK_DRY_RUN=true`, read
`stats()`, confirm nothing you depend on is in the list, then enforce.

### Environment note

CLAUDE.md points at `~/.nvm/versions/node/v22.22.0/bin/node`. **That path does not
exist on this machine.** The working binary is `/opt/homebrew/bin/node` (v26.4.0),
which is what every test run above used. CLAUDE.md should be corrected separately.
