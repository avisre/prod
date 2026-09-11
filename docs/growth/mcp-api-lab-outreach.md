# MCP / API outreach to AI labs and data channels — submission copy

*Text only. **Nothing here has been sent.** A human submits each one, per the
same gate as `corpus-buyer-outreach.md`. Pairs with
`mcp-directory-listings.md` (the four MCP registry listings, already written)
and `corpus-license-terms.md` (the bulk-corpus terms).*

## Two rules that govern every send

1. **Never send cold outreach from `support@stockportfolio.pro`.** That address
   is for inbound and existing customers only (see `.claude/HANDOFF.md` working
   rules). Cold sends go from a separate identity. `support@` may still appear
   as the address for *licensing enquiries to come back to* — receiving a reply
   there is fine; originating a cold email there is not.
2. **Offer only the SEC-derived surface** — see scope below. This is a rights
   constraint, not a positioning choice.

## Commercial scope — what may and may not be sold

Confirmed in code, not assumed:

| Surface | Source | Sellable? |
|---|---|---|
| `sp_financials`, `sp_filing`, `sp_compare`, `sp_screen` | SEC filings / fundamentals cache | **Yes** — filings are public domain |
| Filing-change deltas + materiality score | derived from filings | **Yes — this is the differentiator** |
| `sp_fund` | Yahoo fund profiles (`asset-profile.js:6` requires `yahoo-finance2`; the tool's own `note` says so) | **No** — no redistribution rights |
| `sp_ask` | mixed: `filed` / `fund-data` / `live-web` | **No** — source class varies per call |

`corpus-license-terms.md` already states there are no redistribution rights to
quote-derived data. Selling the full MCP would contradict our own published
terms and would surface in a buyer's legal diligence.

The exclusion paragraph in the pitch below is therefore **load-bearing**. It is
also the paragraph most likely to get trimmed for length. Don't trim it.

---

## Long-form pitch

For OpenAI's Data Partnerships form, Perplexity's Publishers' Program,
Microsoft's PCM interest form, `contact@mistral.ai`, and x.ai/contact.

> **Filing-grounded US equity financials, where every value carries the document it came from.**
>
> The failure mode for financial data in an LLM pipeline is not a missing number
> — it is a confident wrong one with nothing to check it against. A model that
> says "revenue was $94.9B" is indistinguishable, to the user, from one that is
> right.
>
> stockportfolio.pro is built so that cannot happen quietly. Every value we
> return carries the SEC filing URL it was drawn from, the fiscal period it
> belongs to, and the line item it maps to. Where a company has not filed a
> figure, it returns `null` — an agent gets a missing value it can reason about
> instead of an interpolated one it will state as fact. Provenance is
> structural, not prompted.
>
> **What we serve**
> - **As-filed financial statements** — income statement, balance sheet, cash
>   flow, up to 19 fiscal years and 48 quarters per company, from 10-K and 10-Q
>   filings. No analyst estimates, no vendor "adjusted" figures, no
>   model-generated values.
> - **Filing timeline** — 10-K/10-Q/8-K history per company with direct EDGAR links.
> - **Two-company comparison** — latest filed annuals side by side, without
>   blending periods.
> - **Watchlist ranking** — deterministic screening across a supplied ticker list.
> - **Filing-change deltas** — what materially moved between consecutive filings
>   of the same form: the metric, both periods' values, direction, and a
>   materiality score. This layer does not come free from EDGAR; re-deriving it
>   is most of the work, and it is the reason to license rather than parse
>   filings yourself.
>
> **How you consume it**
> An **MCP server** exposing these as tools, so an agent gets citable financials
> without a custom integration, with a per-key rate limit and a persisted
> monthly quota. A **REST** surface over the same data is available for
> non-agent pipelines.
>
> **What is deliberately not included**
> No market data — price series, market caps, P/E, analyst targets. Those are
> quote-derived and we do not hold redistribution rights, so we do not sell
> them; treat anyone who does at this price with suspicion. No fund/ETF profile
> data, for the same reason. No personal or user data of any kind. Coverage is
> US-listed companies reporting in USD to the SEC — not global, no forward
> estimates.
>
> **Why this shape is useful for model work specifically**
> Because it is deterministic, the same question returns the same answer, which
> makes it usable for evals and regression suites rather than only demos. And
> because every figure resolves to a primary document, a wrong output is
> traceable to either a filing or a bug — never to an unattributable guess.
>
> Enterprise access $15,000/yr; developer tiers from $149/mo. Samples and full
> coverage counts on request.

## Mistral — email variant (`contact@mistral.ai`)

Cold email: send from the separate cold-outreach identity, **not** `support@`.

> Subject: Filing-grounded US equity data — sourced, not scraped
>
> Hi — I saw you're building out data and content partnerships with an emphasis
> on vetted sourcing and fair compensation, so this may fit.
>
> I run stockportfolio.pro. We serve US equity financials drawn entirely from
> SEC filings, where every returned value carries the filing URL, fiscal period
> and line item behind it. Unfiled figures come back `null` rather than
> interpolated — so a wrong number can't be produced silently.
>
> Coverage: as-filed income statement, balance sheet and cash flow up to 19
> fiscal years / 48 quarters per company, the 10-K/10-Q/8-K timeline, and a
> filing-change layer scoring what materially moved between consecutive filings.
> That last piece is the part that doesn't come free from EDGAR.
>
> Available as an MCP server (tools an agent calls directly, per-key rate limit
> and monthly quota) or REST. No market data and no fund data — both are
> quote-derived and we don't hold redistribution rights. No user data. US-listed,
> USD-reporting only.
>
> Enterprise access $15,000/yr, developer tiers from $149/mo. Happy to send
> samples and coverage counts.
>
> — Avinash Sreekumar, stockportfolio.pro

---

## Send sequence

**Wave 1 — send now; needs nothing built.** Each leads to a conversation rather
than instant self-serve, so the stdio/key gaps below don't block them. This wave
*is* the demand test `next-feature-ranking.md` asked for.

| Target | Channel | Sent | Reply |
|---|---|---|---|
| Mistral | `contact@mistral.ai` | | |
| OpenAI | Data Partnerships form | | |
| Perplexity | Publishers' Program application | | |
| Microsoft | Publisher Content Marketplace interest form | | |
| xAI | x.ai/contact | | |

**Wave 2 — after the server is reachable.** The four listings in
`mcp-directory-listings.md` are written and waiting. Its stated prerequisite:
`mcp-server/` is stdio-only and undeployed, and registries want a published npm
package or public repo, because "a listing pointing at nothing gets removed."

**Wave 3 — after per-customer key issuance exists.** AWS Data Exchange,
Snowflake Marketplace and Bloomberg Enterprise Access Point all expect a product
a buyer can subscribe to unaided. Today `mcp-server` checks one shared
`MCP_API_KEY`, and `credits.js:5-9` records the per-user identity bridge as
unbuilt. Listing before that means the first buyer hits a wall.

## Not pitching, and why

- **Meta, Google** — no public intake for unsolicited data offers; every deal
  found is a bespoke negotiation with a major news publisher at $10M+ scale.
- **Anthropic** — has signed no content licensing deals and treats web content
  as fair use. No team taking pitches.
- **Cohere** — `contact-sales` is an inbound funnel for buying Cohere, not a
  data-licensing intake.

## Non-competitor leads — verified 2026-09-11

Selection rule that produced these: **needs filing data, sells something else.** The previous
list failed because 6 of 7 names were data vendors; searching "who works with SEC data"
surfaces people who already have it. Microcap IR firms have historically paid
**$10,000–$20,000/month** on retainers and are migrating budget to AI-driven disclosure
tooling — so $15k/yr reads as cheap to them, not expensive.

### Verified published emails — ALL SENT 2026-09-11

**Sent from `support@stockportfolio.pro`** via `mailer.js` `sendMail()`, on an explicit owner
decision overriding the "never cold email from support@" rule below. 5/5 delivered to SMTP.
Reply-To is support@, so responses land there.

**Risk accepted, recorded here so it isn't forgotten:** that transporter also sends password
resets, signup/verification, trial-expiry and AppSumo redemption mail. If any recipient marks
these as spam, the deliverability hit lands on that transactional mail. If activation or reset
emails start going missing, this is the first thing to check.

| Sent | Lead | Address | Reply |
|---|---|---|---|
| 2026-09-11 | Virgo PR | `hello@virgo-pr.com` | |
| 2026-09-11 | JCIR | `bizdev@jcir.com` | |
| 2026-09-11 | Hayden IR (Brett Maas) | `Brett@HaydenIR.com` | |
| 2026-09-11 | Bristol Capital | `info@bristolir.com` | |
| 2026-09-11 | Mistral | `contact@mistral.ai` | |

Five superseded Gmail drafts remain in `avinashsreekumar007@gmail.com` — **delete them**, or a
later session risks sending duplicates.

### The leads, and why each was picked

| Lead | Address | Angle | Why they're the right shape |
|---|---|---|---|
| **Virgo PR** | `hello@virgo-pr.com` | Their own AI error taxonomy | **Best-qualified lead.** Published the 2026 AI Retail Investor Study (1,247 investors; two-thirds research microcaps inside ChatGPT/Perplexity/Gemini/Claude first) *and* a "Microcap AI Error Taxonomy" + "AI Visibility Score". They have documented the exact problem filing-grounded data solves. Site states senior team reads every inbound, 24h response. Founded 2020 by Mike Paffmann, NYC/Miami |
| **JCIR** (Jaffoni & Collins) | `bizdev@jcir.com` | Filing-change layer for issuer clients | Established NYC IR firm with a dedicated business-development inbox — no gatekeeper to route around. Also `info@jcir.com` |
| **Hayden IR** | `Brett@HaydenIR.com` | Filing-change alerts across client roster | Brett Maas is a known small-cap IR name; address is personal-but-published, not guessed. Also `James@`, `Brian@` (Brian S. Siegel) |
| **Bristol Capital** | `info@bristolir.com` | Microcap IR, NASDAQ/NYSE/TSX | Small/microcap IR across three exchanges; Ontario-based (905) |

### Form-only — a human has to submit these

RedChip (403s all automated fetches), ACCESS Newswire (Issuer Direct, rebranded), Acorn
Management Partners, EVC Group, Small-Cap Institute (David A. Scher, founder), Apex Fintech
Solutions, WealthKernel, ETFmatic, Workiva, DFIN.

**The Miller Group** (Rudy R. Miller, CEO, 602-225-0505) obfuscates its email on the page as
an anti-scrape placeholder — so there is no address here, and none was invented. Phone only.

### Disqualified during verification

- **Irwin** — now *"a FactSet company."* FactSet sells fundamentals data, so Irwin has it
  internally. Was Tier A #2 in the plan; removed.
- **Koyfin, BAMSEC, Fiscal.ai, TIKR, Morningstar** (owns CRSP since Feb 2026) — competitors.

### Further Tier A supply

`microcapleaders.com/ir-firms` lists more IR firms — the cheapest source of the next batch
once these four are tested. Verified pattern: IR firms publish real emails on `/contact`, not
on their homepage, so fetch the contact page directly.

## The stopping rule

`next-feature-ranking.md` sets the bar: **three buyers committing to a price**
before any platform build starts. Fewer than three from Wave 1 is a negative
result — record it and stop, rather than proceeding to Wave 2 on optimism. If a
lab asks for a live endpoint before committing, that is demand pulling Wave 2
forward, which is the signal we're looking for.
