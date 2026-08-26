# Consolidated Status — 2026-08-25

One-stop reference merging the 2026-08-25 status brief with the source documents it referenced. Each section is a compact summary — see the **Source index** at the bottom for the full original file if you need raw detail.

---

## 1. Git / Render Deploy State

- Branch `main`. Uncommitted: `.claude/HANDOFF.md` (modified) + untracked `frontend/data/screen-index.json`, `mcp-server/data/`, `scripts/broadcast-ai-features.js`.
- Last 10 commits (08-24→08-25): `d9c6fef5` zh redirect fix → `0ad3e2b6` China segment (geo tracking, Alipay/WeChat checkout, zh page) → 4 sitemap/robots fixes → `fccb4dd4` ticker sitemap fix → `6af94404` visual Normal mode/unit econ → `cfa66be7` Stripe embedded checkout/register/admin messaging → `d0e897fd` (08-22) fundamentals refresh.
- **Render `prod` (srv-d4kc6schg0os73al6t10) matches local HEAD.** Live deploy `dep-da6b690n74is739p699g` = commit `d9c6fef5`, finished 2026-08-24 21:11 UTC. No drift.

## 2. AppSumo Config

- `backend/share-copy.js` `DEFAULT_APPSUMO_DEAL_URL` updated in `cfa66be7` (08-24) to add `utm_source=partner-link&utm_medium=referral&utm_campaign=partner-255732`. **Deployed to prod.**
- ⚠ Render env var `APPSUMO_ATTRIBUTED_URL` is **not set** — app runs on the hardcoded fallback (by design, but HANDOFF.md doesn't call this out).

## 3. MCP Server

- **Not deployed as a Render service** (checked all 9 services on the account — no mcp-server entry).
- Local-only, with an untracked `mcp-server/data/quota.json` (08-25 01:40) — looks like dev/test state, not committed.

## 4. AppSumo Numbers (from `docs/growth/appsumo-analysis.md`, through 2026-08-20 — no fresher pull exists)

| Metric | Value |
|---|---:|
| Orders / payable codes | 9 |
| Gross GMV | $801.00 |
| Discounts | $88.58 |
| Partner revenue/payout | $183.97 |
| Refunds | 0 |
| Redeemed / unredeemed licences | 7 / 2 |
| Tier mix | 3 Starter / 3 Investor / 3 Pro |
| Public review | 1, "5 tacos" |
| 7-day listing conversion | 122 visitors, 1.64% (2 orders) |

Key findings: all 9 buyers were pre-existing AppSumo users (no new-to-AppSumo signal yet, though the 90% new-customer payout tier is the biggest untapped lever — 7 new-to-AppSumo Tier-3 orders would close the founder-revenue gap). Five recurring buyer anxieties: ETF coverage, tier-to-plan mapping, Ask reliability, export capability, API/MCP + compound alerts. One presale buyer explicitly wanted Tier 3 and offered to pay directly.
**Portal must be checked manually for anything newer than 08-20/08-21** — nothing fresher cached.

## 5. Marketing / Outreach

- `docs/growth/` — nothing changed since 08-21.
- `marketing/targeted-acquisition/OUTREACH-QUEUE.md` — still **6/12 sent (as of 2026-08-22)**. Reachable-12 queue, score-ranked:

| prospect | route | status |
|---|---|---|
| SUB-03 (SPCX) | email | **SENT** |
| SUB-05 (BRK) | X DM | skipped (X dropped) |
| PRO-01 | email | **SENT** |
| PRO-03 | contact form | **SENT** |
| SA-07 (DMLP) | SA messaging | blocked (no SA session) |
| SUB-13 (QCOM) | X DM | dropped (reply deleted) |
| SUB-15 (JET2.L) | email | **SENT** |
| SUB-17 | X DM | skipped (X dropped) |
| PRO-06 | contact form | **SENT** |
| PRO-08 | email | **SENT** |
| SUB-18 (WIX) | X DM | dropped (reply deleted) |
| SA-14 (PRCH) | LinkedIn | blocked (wrong person) |

No new outreach activity logged since 08-22. `prospects.csv` unchanged, 52 rows.

## 6. SEO / Search Console

- `docs/seo/bing-opportunities.csv` and `seo-data/gsc-position-analysis.md` are both dated **2026-08-16** — no pull newer than the 08-06/08-09 baseline you're tracking against. Position-analysis file breaks queries into clusters (earnings/EPS, revenue, shares/dilution, comparisons, filings, other metrics) but has no fresher property-level totals than what's already on file.
- **No new GSC/Bing/analytics exports exist since 08-16.**

## 7. Open Bugs / TODOs (`docs/qa/BUGS-2026-08-21.md`, local QA, no prod mutation)

| # | Severity | Issue | Status |
|---|---|---|---|
| BUG-001 | P1 | Homepage promises "3 free Ask, no signup" but `ANON_ASK_LIMIT` defaults to 0 → anon gets 401 immediately | NOT FIXED — needs owner call: set env var or change copy |
| BUG-002 | P2 (env) | Local `PORT=8765` collides with `localyze-dashboard` process | WORKAROUND (used 8766 for QA) |
| BUG-003 | P3 (env) | `npm test` 1/171 fail — `social-compose.test.js` missing optional `selenium-webdriver` dep | NOT FIXED, not installing unapproved deps |
| BUG-004 | P3 | Compare accepts duplicate ticker (AAPL,AAPL) with no warning | NOT FIXED, low priority |
| BUG-005 | P2 | No CSV export on free-tools pages (admin CSV exists, gated) | NOT IMPLEMENTED — correct per spec |
| BUG-006 | P2 (blocked) | Monitor/alerts/Filing Diff/attribution correctly gated behind Power/Desk/Pro, but untestable without a paid-tier test account | BLOCKED — needs DB-inserted test user |

**Summary:** P0: 0, P1: 1, P2: 3 (2 blocked), P3: 2, Env: 1. No P0 blocks core research flows (homepage, company, filings, screener, compare, fund).

---

## Notes / Contradictions

No contradictions found between HANDOFF.md, the status brief, and current repo/Render state. Two untracked files (`frontend/data/screen-index.json`, `scripts/broadcast-ai-features.js`) aren't explained anywhere — flag for the owner to confirm they're intentional in-progress work before they get lost or accidentally committed.

---

## Source index

| Section | Source file |
|---|---|
| 1, 3 | git log, Render API (`srv-d4kc6schg0os73al6t10`) |
| 2 | `backend/share-copy.js`, Render env vars |
| 4 | `docs/growth/appsumo-analysis.md` |
| 5 | `marketing/targeted-acquisition/OUTREACH-QUEUE.md`, `prospects.csv` |
| 6 | `docs/seo/bing-opportunities.csv`, `seo-data/gsc-position-analysis.md` |
| 7 | `docs/qa/BUGS-2026-08-21.md` |
| overall | `.claude/HANDOFF.md`, `docs/status-2026-08-25.md` |
