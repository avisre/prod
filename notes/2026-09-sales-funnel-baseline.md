# 2026-09 sales-funnel baseline — measured before the front-door rebuild ships

Snapshot date: 2026-08-31 (local-only build; nothing deployed yet).
Purpose: before turning on the anonymous Ask gate and the email rung, record
what the funnel actually does today so post-launch changes are attributable.

## AI feature mix — credit_ledger, MONTH 2026-08

From `scripts/ai-usage-report.js` (source: MONGODB_URI from the Render env
backup; ledger only exists from 2026-08-29, so earlier months are invisible):

| feature | credits | share | events | users |
|---|---|---|---|---|
| ask    | 64 | 68% | 32 | 3 |
| dossier | 30 | 32% | 3 | 2 |

Rough per-query credit cost of Ask: ~2 credits/question (64 credits / 32
events). At the anon gate's bounded defaults (3/browser, 6/IP/day, 400
global/day), a fully-saturated day is ≤400 anon asks ≈ ≤800 credits. The
ANON_ASK_GLOBAL_DAY=400 ceiling is the real spend bound — no cost surprise is
possible without raising an env var first.

## Cohort sizes (2026-08-31)

- AppSumo LTD buyers: 12; active last 7d: 8/12; ever used Ask: 9/12; ever
  opened a Dossier: 2/12; ever ran Monitor: 0/12.
- Paid Monitor-tier subscribers: 1 (Desk).
- Total paid accounts: check GA4/funnel report after launch — the new
  `anon_*` funnel events land in the same FunnelEvent collection.

## Bing (from the July crawl-budget work)

Bing weekly numbers to snapshot here after the owner pastes them from
Webmaster Tools (no automated access configured on this machine):
last week's impressions, clicks, and the top surfaces. GA4 funnel report is
the ~2-weeks-post-launch readout (existing ledger task).

## What to compare after ~2 weeks of the anon gate being live

1. `anon_ask_started` vs `anon_ask_done` — preview quality loss rate.
2. `anon_wall_shown` → `anon_email_captured` → `anon_email_verified` — the
   new rung's capture rate (what percentage of spenders trade an email).
3. Wall → `/register.html?plan=monthly` checkout starts — did the email rung
   cannibalise or assist paid conversion (watch both, weekly).
4. Global anon asks/day against the 400 ceiling — if it never comes close,
   the 6/IP/day backstop can be loosened with measurement, not vibes.
5. Indexable `/r/:id` shares in Google/Bing — first indexable-share shards in
   the sitemap appear only after an authenticated user publishes.