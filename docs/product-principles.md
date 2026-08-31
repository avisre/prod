# Product principles — StockPortfolio.pro

Standing product direction, written 2026-08-31 after the customer-feedback
round (12 feedback asks sent to AppSumo/lifetime buyers, 2 substantive replies ≈17%;
the decisive one from a long-running buyer). These principles outrank feature
ideas and should be quoted in any build/no-build decision.

## The Alex test

A customer who has used the product for two months put it cleanly: **anyone can
get a chatbot with verified answers, with web search and SEC EDGAR data — that
is a commodity.** What is not a commodity is the dossier: the structured,
comparable, zero-prompting report, and the monitor that digests new filings
over time.

So for every proposed feature, ask:

> **Does this make reports more comparable, or more like a chatbot?**

If the honest answer is "more like a chatbot," it doesn't get built — no matter
how obvious it looks on a competitor's landing page.

## The two halves of the product

1. **Research Dossier** — the unique thing. Structured, comparable across
   companies, zero prompting, plain language, every figure cited to its filing.
   It is the entry surface on the homepage, in the activation email, and on the
   AppSumo listing. Compare (side-by-side dossiers) exists to amplify exactly
   this: the difference the customer sees should be the company, not the questions.
2. **Filing Change Monitor** — the digestion/retention half. The dossier earns
   the customer each time they research; the monitor keeps them, by digesting
   every new filing into plain English on a cadence. It is the answer to "why
   stay subscribed with one watchlist."

Ask is real and loved, but it is the commodity part. It stays a feature —
demoted everywhere to (a) a listed allowance and (b) a follow-up surface after
a dossier, never the front door.

## Standing defaults

- **Plain language is the default, not a mode.** Reports open in plain-English
  sections; analyst detail stays one click away, never in front.
- **Comparability is a feature, not a byproduct.** Any change to dossier
  structure must preserve "same sections, same order, every company."
- **Cited or silent.** A number without its filing is treated as a bug.
- **Entitlements ratchet one way.** Lifetime entitlements (the tier map in
  `lib/tier-limits.js`, `LTD_MONITOR_CAP`) only ever widen, never narrow — that
  map is the single source of truth and marketing copy mirrors it from the code.
- **Measure, don't estimate.** Pricing/cost decisions come from running the
  extractors, not from plausible numbers.

## Do not build (with the customer evidence)

- **More chat-first surfaces** — "anyone can get a chatbot with verified answers
  with web search and SEC EDGAR data" (Alex, AppSumo buyer, Aug 2026).
- **More indicators / more screens** — the complaint pattern across replies was
  discovery and digestion, not missing data. A new indicator that doesn't
  improve comparability or digestion is noise.
- **Real-time anything** — filings land quarterly; the value is the digest, not
  the latency. Real-time feeds pull the product toward the terminal category we
  explicitly decline.
- **Prompt-first research flows** — "you type the ticker, the questions are
  already asked" is the product. Features that require users to write good
  prompts regress the dossier's core advantage.
- **Deeper parity with terminal features** (institutional global/macro/FX,
  tick-by-tick, options) — listed on the AppSumo page as "not the right fit,"
  and the same line holds internally.

## What this dictated (August 2026 decisions)

- Compare view for dossiers (5 credits, cached dossiers only — comparability).
- Homepage reordered Dossier-first for everyone (the front door is the report).
- Activation email inventories Dossier + Monitor + tier cap by name.
- Weekly digest extended to lifetime buyers (digestion for the people who paid once).
- Entry-tier Monitor cap widened 10 → 12 (the only direction it can move).
- AppSumo listing v2 heads with Dossier + Monitor; Ask listed as an allowance.