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

## Chinese labs — Wave 1 extension (verified 2026-09-11)

Owner-directed addition to Wave 1: pitch the live MCP/API surface to Chinese AI
labs. Same two rules as every other send (SEC-derived surface only; cold sends
not from `support@` **except** where the owner explicitly accepted that risk —
which this batch repeats, same as the 9/11 IR batch above).

### Verified BD channels

| Company | HQ | Channel | Confidence |
|---|---|---|---|
| **Zhipu AI / Z.ai** | Beijing | `service@zhipuai.cn` — in the zhipuai.cn footer, explicitly labeled **商务合作** | High (label verified on the official page) |
| **Moonshot AI (Kimi)** | Beijing | `growth@moonshot.cn` — published on moonshot.cn/about; secondary route: `platform.kimi.com/contact-sales` form | High (official page) |
| **DeepSeek** | Hangzhou | **No BD channel published.** Only generic `service@deepseek.com` (site footer) and `api-service@deepseek.com` (API docs) | High (that none exists) |
| **MiniMax (稀宇科技)** | Shanghai | `api@minimaxi.com` — in the platform docs contact page under **商务合作、开票、退款**; `api@minimax.io` is the international alias for the same function | High (official docs) |
| **01.AI (零一万物)** | Beijing | **No BD email published** — footer 商务合作 links are dead `#` placeholders. Only a Feishu 生态合作 form (login required) and a 预约咨询 booking anchor | High (that no email exists) |

`deepseek-en.com` is a documented lookalike domain (Qianxin XLab tracks 2,650+
DeepSeek-impersonating domains) — never use contact details from it. Same for
`hailuoaiminimax.com` (advertises its own info@/support@ addresses; NOT official
MiniMax — official domains are minimax.io / minimaxi.com / minimax.cn).

Alibaba/Qwen and Baidu (ERNIE / AI Cloud): research complete — rows added below.

| **Alibaba (Qwen / Tongyi)** | Hangzhou | `qianwen_opensource@alibabacloud.com` — the official QwenLM GitHub org profile address (open-source-community oriented, English-facing). **No BD-labelled intake exists**: tongyi.aliyun.com publishes only a QR code, aliyun.com China is chat+phone only. Alibaba Cloud's sales/partner addresses (`contact.us@`, `AlibabaCloudPartner@`, `Go-Global-Partner@`) are wrong-function — cloud-channel BD, not the model team | High (address published) / medium (right function) |
| **Baidu (ERNIE / AI Cloud)** | Beijing | **No BD email published.** ERNIE's enterprise intake is a Chinese-only web form (文心一言云服务合作咨询, business email required); `partner_feedback@baidu.com` / `eco_support@baidu.com` are channel-partner contacts, not data licensing; `yiyan-service@baidu.com` is consumer support — **do not use**. `ir@baidu.com` is investor relations only | High (that no BD email exists) |

**Why Alibaba is a real fit**: Alibaba's own training-data disclosure (updated
Sep 2026) states Qwen's corpus includes *"non-public data provided by partners
under agreement"* — an explicit acknowledgment that they license third-party
data. There is simply no dedicated data-licensing intake, so the Qwen org address
is the only route in; expect it to be community-handled, and treat a forward to
the right team as a win.

**Why Baidu is a real fit but email-unreachable**: they formally recruit data
vendors (百度AI数据服务类生态合作伙伴计划 on ai.baidu.com — 数据采集商/数据标注商),
built media-domain models with Xinhua's corpus, and signed a copyright-content
deal with Visual China (视觉中国). Appetite is proven; every route is a form or a
wrong-function address. Form-only, owner action.

**Caveat recorded**: `ACPN_Support@alibabacloud.com` appears in search snippets
but could not be verified on any official page — do not use it.

**Why MiniMax is a good fit**: founder Yan Junjie has publicly said training data
includes purchased high-quality corpora from data vendors — they demonstrably buy
third-party data, and their March 2026 Tencent Cloud partnership explicitly covers
an AI 数据采集生态 (data-supply ecosystem). No publisher-licensing deal published.

**Why 01.AI is a weaker fit but not dead**: they abandoned frontier pre-training
(now building on DeepSeek, enterprise focus), so training-corpus appetite is low —
but their **Investor AI** product implies real appetite for licensed *financial*
data. No email route exists, so this one needs the Feishu form or the booking
path, submitted by a human.

### Bilingual pitch (EN + 中文), sent 2026-09-11

> **Subject: Filing-grounded US equity data — sourced, not scraped / 基于申报文件的美国股票财务数据**
>
> Hi — I run stockportfolio.pro. We serve US equity financials drawn entirely
> from SEC filings, where every returned value carries the filing URL, fiscal
> period and line item behind it. Unfiled figures come back `null` rather than
> interpolated — so a wrong number can't be produced silently.
>
> Coverage: as-filed income statement, balance sheet and cash flow up to 19
> fiscal years / 48 quarters per company, the 10-K/10-Q/8-K timeline, and a
> filing-change layer scoring what materially moved between consecutive filings.
> That last piece is the part that doesn't come free from EDGAR.
>
> Available as a hosted **MCP server** (tools an agent calls directly, per-key
> rate limit and a metered monthly credit allowance) or **REST** — both live
> today. No market data and no fund data — both are quote-derived and we don't
> hold redistribution rights. No user data. US-listed, USD-reporting filers only.
>
> Enterprise access $15,000/yr, developer tiers from $149/mo. Happy to send
> samples and coverage counts.
>
> — Avinash Sreekumar, stockportfolio.pro
>
> ---
>
> 您好——我是 stockportfolio.pro 的创始人。我们提供的美国股票财务数据全部来自
> SEC 申报文件（10-K / 10-Q），每一个返回值都附带其来源的 filing 链接、所属财期
> 与对应科目（line item）。未申报的数值一律返回 `null`，而不是插值估算——因此不会
> 悄无声息地产生错误数字。
>
> 覆盖范围：按原样呈现（as-filed）的利润表、资产负债表与现金流量表，每家公司最多
> 19 个财年 / 48 个季度；10-K/10-Q/8-K 申报时间线；以及 filing-change 层——对同一
> 表单相邻两次申报之间发生实质性变动的指标给出方向与重要性评分。最后一层并非
> EDGAR 免费提供，重新推导它正是这项工作的大部分价值所在。
>
> 交付方式：托管 **MCP server**（agent 可直接调用的工具，按 key 限流，按月计量的
> credit 额度）或 **REST** 接口，两者目前均已上线。不包含行情数据与基金数据——
> 这些源自报价数据，我们不具备再分发权利；也不包含任何用户数据。覆盖范围为在美国
> 上市、以美元申报的公司。
>
> 企业授权 $15,000/年，开发者档位自 $149/月起。可提供样例数据与覆盖数量统计。
>
> —— Avinash Sreekumar, stockportfolio.pro

---

## Western labs — forms and direct channels (2026-09-11)

**Owner-directed acquisition signal — read this before editing the copy.** The
owner asked for a *subtle* openness to acquisition in the Western-lab approach.
The chosen wording ("quiet door") is the closing paragraph below, and it applies
to **Western labs only** — never the Chinese labs (already sent a clean licensing
pitch), never the IR firms. It is deliberately a separate paragraph *after* the
pricing line, not folded into it: adjacent to "$15,000/yr" it would read as
*"$15k is a rounding error — just buy us,"* which undercuts the licence price.
If a lab replies to the licence and the conversation goes further, that is the
signal working as intended.

### Copy (English only — no Chinese needed for these)

> Hi — I run stockportfolio.pro. We serve US equity financials drawn entirely
> from SEC filings, where every returned value carries the filing URL, fiscal
> period and line item behind it. Unfiled figures come back `null` rather than
> interpolated — so a wrong number can't be produced silently.
>
> Coverage: as-filed income statement, balance sheet and cash flow up to 19
> fiscal years / 48 quarters per company, the 10-K/10-Q/8-K timeline, and a
> filing-change layer scoring what materially moved between consecutive filings.
> That last piece is the part that doesn't come free from EDGAR.
>
> Available as a hosted **MCP server** (tools an agent calls directly, per-key
> rate limit and a metered monthly credit allowance) or **REST** — both live
> today. No market data and no fund data — both are quote-derived and we don't
> hold redistribution rights. No user data. US-listed, USD-reporting filers only.
>
> Enterprise access $15,000/yr, developer tiers from $149/mo. Happy to send
> samples and coverage counts.
>
> We're independent and building this to last — but if any of this is more
> useful to you as a deeper conversation than as a licence, I'm easy to reach.
>
> — Avinash Sreekumar, stockportfolio.pro

### Channels — verified 2026-09-11

Only **three** of the seven have any real intake, and **no Western lab publishes
a corp-dev or M&A inbound route**. The last column is the point of this table:
the quiet door is a *conversational* line, so it only travels where a human
reads prose. Two labs can carry it; one must never receive it.

| Lab | Intake | URL / address | What it actually is | Quiet door |
|---|---|---|---|---|
| **Perplexity** | `publishers@perplexity.ai` | email — verified on the official Perplexity blog | Publishers' Program: citation + revenue share, **not** classic training-data licensing. Framing adapted below. | ✅ **sent here** |
| **OpenAI** | Data Partnerships form | `https://openai.com/form/data-partnerships/` | Real data-licensing intake, public, structured fields. | ⚠️ one closing line only, and only if a free-text field exists |
| **Microsoft** | PCM Interest Registration Form | `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=v4j5cvGGr0GRqy180BHbR1qEBAms6XZAiDBk6zoHgJVURDZJODMwT1RQUUk0REpaS1BCUU5JSUY3Mi4u` | Anonymous interest registration for Publisher Content Marketplace. Function dropdown includes "Business Development, Partnerships & Licensing". | ❌ **never** |
| **xAI** | none | — | No data-licensing intake, no corp-dev route. Only `support@` / `media@` / `safety@` and a general sales form. | ❌ |
| **Anthropic** | none | — | Claude Partner Network form is services-partners-only (10+ employees); no publisher licensing deal has ever been signed. | ❌ |
| **Meta** | none | — | No public intake of either kind. | ❌ |
| **Google** | none | — | No public intake of either kind. | ❌ |

**Why Microsoft gets no quiet door — do not "fix" this.** Microsoft's own
unsolicited-submission policy states it *"does not consider or accept unsolicited
proposals or ideas."* An acquisition hint in their PCM form doesn't merely fail to
land — it risks the data-licensing submission that *is* legitimate. The line stays
out entirely.

**The honest read on the signal:** of the seven, exactly one channel can carry it
(Perplexity's inbox). OpenAI's form is a structured intake with no field for it;
the rest have no route at all. Acquisition conversations at this scale travel
through bankers and warm intros, not intake forms — so this is a single quiet
shot, not a campaign. That is worth knowing before spending the line.

### Paste-ready submissions

**Numbers used below were measured on this machine, not estimated** (2026-09-11):
6,042 companies with stored as-filed statement histories, ~965 MB of statement
JSON, 7,602 company master records, 3,840 companies in the screener universe.

#### Perplexity — `publishers@perplexity.ai` (send as-is)

Perplexity's program pays *publishers* for citations, so the pitch leads with
being citable primary-source material rather than with a licence. Same body as
the Western-lab copy above, with this opening paragraph replacing the first:

> Hi — I run stockportfolio.pro. Perplexity's Publishers' Program is built around
> citing sources; what we have is a body of US equity financials that is
> *nothing but* citations. Every value we return is drawn from an SEC filing and
> carries the filing URL, fiscal period and line item behind it. Unfiled figures
> come back `null` rather than interpolated — so a wrong number can't be produced
> silently, and any answer built on it is checkable back to the primary document.

…then the coverage, MCP/REST, scope-exclusion and pricing paragraphs verbatim,
then the quiet-door paragraph.

#### OpenAI — Data Partnerships form

**Browser-only — no automated path, and don't build one.** The form sits behind
Cloudflare (`cf-mitigated: challenge`; plain fetch returns 403 with a JS
challenge page). It is *not* a captcha and a normal browser passes it silently —
so this is a 2-minute human job, not a blocker. Defeating the challenge from a
script would be an anti-bot workaround, which is off-limits in this repo.
Recorded here so a later session doesn't spend time rediscovering it.

Contact fields: **Avinash Sreekumar** / `support@stockportfolio.pro` /
stockportfolio.pro.

| Field | Value |
|---|---|
| Data type | Structured financial-statement data derived from SEC filings (income statement, balance sheet, cash flow), as-filed, plus filing-change deltas |
| Estimated size | ~965 MB of statement JSON across 6,042 companies; 7,602 company master records |
| Format | JSON, one record per company, line items keyed by fiscal period. Also available live over REST and a hosted MCP server |
| Public archive or private dataset | Public archive — the underlying filings are SEC public records; the derived layer is ours |
| Do you have the rights to share this data? | **Yes.** Derived entirely from SEC public filings. Contains no market data, no fund data, no personal data, and no third-party licensed content |
| Free-text / notes | Optional, one line only — the quiet-door sentence. Omit if no such field exists; do not force it into another field |

#### Microsoft — PCM Interest Registration Form

Function dropdown: **Business Development, Partnerships & Licensing**. Fill the
content description from the OpenAI table above, minus the rights row's "no
market data" caveat wording (keep it — it's accurate) and **minus the quiet
door**, per the policy note above.

#### xAI / Anthropic / Meta / Google — nothing to submit

No intake exists. Not a form to fill in later; there is no door. Any future
approach here is a warm intro, not a submission.

---

## Send sequence

**Wave 1 — send now; needs nothing built.** Each leads to a conversation rather
than instant self-serve, so the stdio/key gaps below don't block them. This wave
*is* the demand test `next-feature-ranking.md` asked for.

| Target | Channel | Sent | Reply |
|---|---|---|---|
| Mistral | `contact@mistral.ai` | 2026-09-11 | |
| Perplexity | `publishers@perplexity.ai` | 2026-09-11 | **Auto-reply 2026-09-11 16:10** from `publishers+noreply@perplexity.ai`: fill the form at `pplx.ai/publisher-program`. **Form submitted 2026-09-11** (confirmation: "Thank you for your submission… We've received your message") — Avinash Sreekumar / Founder / support@stockportfolio.pro / United States, free-text carries the filing-grounding pitch. No human has read the pitch yet — see the form note below |
| OpenAI | Data Partnerships form — **no email exists** | ❌ form-only | |
| Microsoft | PCM interest form — **no email exists** | ❌ form-only | |
| xAI | no intake exists (no BD or data-licensing channel published) | ❌ unpitchable | |
| Zhipu AI / Z.ai | `service@zhipuai.cn` (商务合作) | 2026-09-11 | |
| Moonshot AI (Kimi) | `growth@moonshot.cn` | 2026-09-11 | |
| MiniMax (稀宇科技) | `api@minimaxi.com` (商务合作) | 2026-09-11 | |
| 01.AI (零一万物) | Feishu 生态合作 form / 预约咨询 — **no email exists** | ❌ form-only | |
| Alibaba (Qwen / Tongyi) | `qianwen_opensource@alibabacloud.com` (QwenLM org; no BD intake exists) | 2026-09-11 | ❌ **Bounced 2026-09-11 15:36** — `552 mailbox is full`. Permanent; needs a different route or drop |
| Baidu (ERNIE / AI Cloud) | ERNIE enterprise form — **no BD email exists** | ❌ form-only | |

**Perplexity's reply is a form, and the form does not fit a data vendor.** Read
2026-09-11: `pplx.ai/publisher-program` redirects to a Google Form
(`forms.gle/9ibqnNTRCzgdwmdH9`) asking for **Media Organization Name, Contact
Name, Contact Title, Email, Publication Geo/Region**, plus one free-text box. There
is no field for a data/API product, no field for what is being licensed, and the
program is described as paying *publishers* for citations — the same mismatch the
pitch already had to work around. The only place a data pitch can land is the
free-text box, which is where the filing-grounding argument has to go. Auto-reply
also warns response times are long "due to an extremely high volume of interest."
Treat this as a low-probability channel, not a live conversation.

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
- **DeepSeek** — no BD or partnership channel is published anywhere on
  deepseek.com; only a generic `service@deepseek.com`. Their own EU AI Act
  training-content disclosure confirms they *do* sign commercial licensing
  agreements and buy third-party datasets — the appetite exists, the intake
  doesn't. Routing a BD pitch through the generic service inbox is a last
  resort, not a plan.

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
