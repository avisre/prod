# Week-1 kit — Filing Diff demand test (concierge redlines)

2026-09-01. Companion to strategy v3 Weeks 2–3 item 7 and Compression items
3–4. **Measured premise: the feature already exists** — 397 computed diffs in
`filing_diffs` (newest 2026-08-31), endpoint `GET /api/company/:symbol/filing-diff`
(backend/app.js:7649, behind `authMiddleware, proGate`), zero Pro
subscribers behind that gate. This kit turns cached payloads into demo
artifacts and offer copy; no build required.

Quality gate (v3 item 9, mandatory): each brief below was spot-checked
against its payload's stored quotes before inclusion — any redline sent to a
professional must be hand-verified the same way. One hallucinated change
kills the wedge.

---

## 1. Exemplar briefs (concierge demos, ready to send)

Each is formatted as the buyer/prospect would receive it: what changed,
with the filing quote that grounds it. Full payloads:
`/tmp/ceo-collect/diff-payloads.json`.

### Exemplar 1 — TSLA (10-Q diff, filed June 2026)

**What changed in Tesla's latest 10-Q vs the prior filing:**

- **Dilution is real and fast:** shares outstanding rose from ~3.33B
  (Oct 16, 2025) to 3.76B (Apr 16, 2026) — **+430M shares in six months**.
- **Revenue stepped down:** Q1-26 total revenues $22.4B vs $28.1B the prior
  quarter; net income lower.
- **New risk line:** other expense, net widened to $(535)M from $(28)M,
  driven by fair-value changes on the new SpaceX equity investment.

### Exemplar 2 — UPS (10-Q diff)

- **Operating margin fell to 6.0%** (Q1-26); operating profit $1.267B, down
  23.9% YoY; net income down 27%.
- **Ground Saver restructuring:** UPS began outsourcing last-mile delivery of
  a portion of Ground Saver to USPS — transition costs + excess staffing
  charges now explicit in the filing.
- **Liquidity tell most analysts miss:** the accounts-receivable factoring
  program maximum rose from **$395M to $860M** between consecutive filings.

### Exemplar 3 — FDX (10-Q diff)

- **Capex guidance cut:** FY2026 capex lowered to ~$4.1B from $4.5B.
- **MD-11 grounding reclassified:** upgraded from "immaterial" to an explicit
  statement it "had an impact on our financial results" — a risk-factor
  regression between filings.
- **New "Global Trade Policies" risk section** added after the February 2026
  Supreme Court tariff decision.

**Public ungated exemplar pick (Compression item 4): TSLA.** Most
recognizable ticker, most dramatic change (+430M shares), and dilution is a
perennial retail search topic. Newest-diff-free, history/multi-symbol/
watchdog gated behind Pro — per the Compression ruling.

---

## 2. Early-access offer to the 12 buyers (send week 2)

**Subject:** `I built something you won't have seen — want first access?`

> Hi [first name],
>
> You use StockPortfolio.pro already, so you'll know the drill: we read the
> filings. What we just finished building does it in a way I haven't seen
> anywhere else at this price — an automatic redline of what actually
> changed between a company's last two filings. Not a summary. A diff.
>
> Example, from Tesla's latest 10-Q: shares outstanding went from 3.33B to
> 3.76B in six months. That +430M is sitting in the cover page of the filing
> and almost nobody catches it in time.
>
> It's not public yet. First 10 people who say yes get it at
> [$49/yr early-access — or free with a Pro upgrade], locked forever. Reply
> "in" and I'll switch it on for your account today.
>
> — Avinash

**Gate (v3 kill criterion): fewer than 2 of 12 buy → no product exposure;
the diff stays a concierge/demo artifact.**

## 3. B2B sample-first send (Engine B; founder personal email/LinkedIn, never support@)

> Hi [name],
>
> You cover [UPS] — did you catch that their receivables factoring cap
> doubled from $395M to $860M in the last 10-Q, the same quarter they
> started outsourcing Ground Saver last-mile to USPS?
>
> That's from a tool we run that redlines every material change between
> consecutive SEC filings — guidance cuts, risk-factor regressions, liquidity
> tells. I've attached the full UPS redline so you can judge the quality
> yourself. If it would save you an hour on every filing you cover, I'll
> walk you through it — 15 minutes, no deck.
>
> — Avinash

**The attachment IS the pitch** (v3 Compression item 3) — one precomputed
brief per prospect on a company THEY cover, zero marginal cost from the
cache. Expect 0–2 closes from 20–30 sends.

## 4. Verification checklist before any brief leaves the building

1. Quote in the brief matches the payload's stored `quote` field, which
   traces to the filed document (accession + prevAccession recorded).
2. Numbers cross-checked against the filing's XBRL facts where present.
3. No AI-provider identity anywhere in the artifact or the email (trade
   secret rule).
4. The brief carries no advice-adjacent language ("this means you should
   sell") — findings only, sourcing explicit (YMYL/regulatory posture).