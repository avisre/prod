# Listing v5 → AppSumo: what was sent, and the portal submission that follows

## SENT 2026-09-06 — reply into the William thread

Sent from avinashsreekumar007@gmail.com into "StockPortfolio.pro — final-period
promotion and deal-end confirmation" (thread `19fe6db19d1ec258`, message
`1a073591327afe4f`). It (1) accepts William's process, (2) answers his open question
about custom "Best for" values, (3) asks what the overwrite covers before we submit,
(4) flags the tier-description change honestly, (5) asks him to fix "Uses AI: No".

## The process William actually requires — his email of 1 Sep

This **supersedes** the internal rule "never edit listing versions in the portal, email
William instead." He has set the process out himself, and it is the opposite:

> 1) I put that new version you'd once created + submitted back to DRAFT.
> 2) When you review and edit this draft — keep in mind — it is NOT A 1:1 MIRROR of the
>    live product page — our system does not communicate in reverse — a key failing
> 3) As you make edits, be sure EVERY FIELD is exactly as you'll want it — **it will
>    overwrite the entire page content wise.**
> 4) Let me know when you've made the edits AND SUBMITTED → I will then "approve them"
>    triggering them to be pushed to the page
> 5) Then, we can note any irregularities — and fix from there ASAP.

So the copy is **not** emailed to him. **Avinash edits the draft in the Partner Portal and
submits it**, then emails William, who approves it into the live page.

Step 3 is the dangerous one: the draft is not seeded from the live page, so **any field
left empty overwrites the live equivalent with nothing.** That is why the sent email asks
what is in scope before touching it.

## Portal submission checklist — do not submit until every line is filled

Source copy: `docs/growth/appsumo-listing-v5.md`, sections *Product title* → *Words to
avoid*. Do not paste the internal sections ("Before this is submitted", "Owner checklist",
"What changed vs v4", "Classification").

- [ ] **Confirm with William what the overwrite covers** (FAQs / update posts / images).
      Blocking — everything below depends on the answer.
- [ ] Product title, tagline, opening
- [ ] Feature blocks in order: Research Dossier → Filing Change Monitor → credits → Ask
- [ ] Tier table: **100 / 300 / 800 AI credits**, Monitor **1 / 4 / 8**, prices unchanged
      at $39 / $79 / $149
- [ ] Per-action costs: Dossier 10 · Monitor report 5 · Compare 5 · Ask 2
- [ ] **Omit the $14.99 / 150-credit top-up** until `STRIPE_PRICE_ID_CREDITS_TOPUP` is set
      on Render — the route returns `TOPUP_UNAVAILABLE` without it
- [ ] **Omit Deep Dossier** — `?depth=deep` is URL-only, no buyer can invoke it
- [ ] Proof block (Claim Ledger), Limits paragraph, Integrity note — verbatim from v5
- [ ] The five founder FAQs — **re-enter them if they are in scope**, or they are wiped
- [ ] Images: existing hero/banner unchanged, then `01-dossier-nvda-decision-brief.png`,
      `02-dossier-nvda-financial-trajectory.png`, `03-filing-change-monitor-nvda.png`
      (owner decision 2026-09-06: ship as-is; nav reads "Ask AI", product now says
      "Research" — one label, nothing else stale)
- [ ] Category AI primary / Finance secondary; tags `research`, `sec-filings`,
      `due-diligence`, `ai`, `ai-assistant`; drop `portfolio-tracker`
- [ ] Keep the classification as **Software**, not an AI Skill — a hosted research app
      (Avinash established this with William on 11 Aug)
- [ ] Submit, then email William so he can approve

## Left to William (he owns these, we cannot)

- The **"Uses AI: No"** flag.
- Custom **"Best for"** values — he confirmed on 31 Aug he can make them custom and asked
  for ideas; the sent email gives him Individual investors / Finance researchers /
  Financial analysts.
- **"Alternative to"** — remove Bloomberg Terminal, keep Koyfin and SeekingAlpha.
- Radar placement: he has "zero control over the collection algo" and has raised several
  internal tickets. Do not re-ask; it is not his to give.

## Standing constraints from the thread

- The listing must stay **live and transactable through Sunday 4 October** (90-day Radar
  minimum, William 10 Aug). Do not let a version submission take the page down.
- Review eligibility: William found **no AppSumo account** for `drmakineni@msn.com`, so
  Kris must contact support@appsumo.com himself with his username or code. Already
  relayed; nothing further owed to William on it.
- Revenue share: 90% on new customers via the partner link; otherwise 25% of net revenue
  up to $50K. **Payouts are NET 60**, after the 60-day refund window.

## Superseded

`docs/appsumo-william-listing-update-draft.md` — asked AppSumo to approve a **feature
reduction** that was never made. Marked DO NOT SEND.
