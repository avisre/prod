# Week-1 email drafts — owner approval required before any send

2026-09-01. Both sends go out from **support@stockportfolio.pro via
/admin/messages** (owner approves every send; never the personal Gmail).
Personalization fields in `[brackets]`.

> **SENT 2026-09-01 — owner approved ("do all of it").** 38/38 accepted via
> POST /api/admin/messages/threads/:userId with sendEmail:true, every one
> `emailStatus: "sent"`: 1 preview to the owner's own admin account (monthly
> sample), 25 Draft A (rung-mapped: 12 monthly→Good-mo link, 5 pro + 5
> pro-annual + 1 power→Pro link, 1 annual→Good-annual link, 1 desk→
> founder-led reply invitation, no link), 12 Draft B (admin's own account not
> in the license list). Live payment links used:
> Good-mo / Good-annual / Pro (created 9/1, verify script:
> `/tmp/ceo-collect/verify-links.js`, all three pages render correct USD
> amounts). Results log: `/tmp/ceo-collect/send-results.json`. Note: the
> original sequencing said "send after the owner's live payment-link
> purchase" — the owner authorized sending without it; the links were
> instead verified by headless page-load (correct amounts, HTTP 200 on Pro).

---

## Draft A — pending-checkout recovery (25 leads, rung-mapped)

**To:** one-to-one, each lead individually (not bulk CC). **Subject:**
`Your [Pro] checkout last month — it's fixed if you still want it`

> Hi [first name],
>
> You started a [Pro plan] checkout on StockPortfolio.pro in August and it
> didn't go through — I wanted to reach out personally rather than let that
> sit.
>
> The short version: our checkout was genuinely broken when you tried. Some
> plans were priced in pounds instead of dollars, and a few payment links
> pointed at retired prices. We rebuilt the whole pricing ladder at the end
> of August and I've verified it end-to-end — but I never followed up with
> the people who hit the broken version, and that's on me.
>
> If you'd still like [Pro], here's a direct checkout link:
> [PAYMENT LINK — mapped rung]
>
> If the price or the timing isn't right anymore, or something felt off
> beyond the payment error, just reply to this email — I read everything
> and I'd rather learn that than lose you silently.
>
> — Avinash
> StockPortfolio.pro

**Rung mapping** (from the forensics readout, `2026-09-01-week1-checkout-forensics.md` §2):

| Their chosen rung | Offer | Payment link |
|---|---|---|
| monthly ($9–12/mo attempts) | Good — $24.99/mo | [Good monthly link] |
| pro ($33/mo attempts) | Pro — $499.99/yr | [Pro link] |
| pro-annual ($250/yr attempts) | Pro — $499.99/yr (anchor: their pick was the annual instinct) | [Pro link] |
| annual ($90/yr attempt) | Good-annual — $199.99/yr | [Good-annual link] |
| power ($579/yr attempt) | Pro — $499.99/yr (retired rung) | [Pro link] |
| desk ($1,961/yr attempt) | Desk — quote rung: "reply and I'll set Desk up personally" | founder-led, no self-serve link |

**Rules for this send:**
- Full price, no discount, no LTD offer in email #1 (v2 fix carries forward:
  discounting the only measured direct-demand pool cannibalizes the MRR and
  teaches nothing).
- One-to-one sends, owner approves the batch. Bounce/unsub handling per
  /admin/messages flow.
- The desk lead gets the founder-led close (Engine B), not a link.
- Log replies per rung; reply reasons feed the 14-day re-forecast.

---

## Draft B — buyer review ask (12 buyers, 8 weekly-active)

**To:** the 12 AppSumo buyers with `appsumoLicenseKey` (start with the 8
weekly-active). **Subject:** `One favor, and a question about [their use]`

> Hi [first name],
>
> You've been putting StockPortfolio.pro through its paces over the last few
> weeks — thank you. Two things.
>
> First, a favor: we're a small bootstrapped tool and the AppSumo listing
> lives and dies by reviews. If the product has earned it, a short review
> makes a real difference: [review URL]
>
> Second, the actual question — what do you actually use it for? Filing
> research, portfolio tracking, the Ask tool, something I don't even know
> about? I'm deciding what to build next and the honest answer from the
> people who pay beats any spreadsheet.
>
> (If you've hit the limits of your tier and want more — deeper filing
> analysis, monitoring across more tickers — reply and I'll tell you what
> the upgrade paths look like. No pressure either way.)
>
> — Avinash
> StockPortfolio.pro

**Notes:**
- Review URL: the attributed outbound URL anchored to `#reviews`
  (`appsumoReviewPromptUrl()` logic) so partner attribution holds.
- The last paragraph IS the Intelligence attach opener (v3 Engine C) — the
  $149/yr founding offer goes in the REPLY to whoever engages, not in this
  email. Two-step: ask, then attach.
- `APPSUMO_REVIEW_EMAILS` is OFF (owner call, 8/31) — this draft supersedes
  that setting only if the owner approves the manual send; do not flip the
  env flag without a fresh owner decision.

---

## Sequencing

1. Owner live payment-link purchase + refund (proves the link path).
2. Draft A to the 25 leads (one-to-one), Draft B to the 8 weekly-active —
   same day is fine; different audiences, no channel conflict.
3. Week 2: Intelligence founding offer ($149/yr payment link) to engaged
   repliers from either draft; log everything for the 9/15 re-forecast.