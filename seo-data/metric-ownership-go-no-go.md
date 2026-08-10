# Metric ownership go / no-go

This gate separates obvious semantic correctness from speculative ranking/authority work. No new pages, broad AI CTAs, Ask, pricing, Stripe, AppSumo or activation changes are included.

## Dataset

- Latest files: `seo-data/gsc/queries-3m.csv`, `pages-3m.csv`, `query-page-3m.csv`, plus `acquisition.json`.
- Property: `sc-domain:stockportfolio.pro`; window: `2026-05-10` to `2026-08-07`; retrieved `2026-08-10T07:39:58.124298+00:00`.

## Technical state

- Canonical: representative variants are stable on `https://www.stockportfolio.pro`; the historical duplicate warning is not reproduced. HTTP non-www has two edge hops but no loop; no redirect code was changed.
- 5xx: exact historical validation URLs are unavailable; representative current routes are 200. Historical issue remains unresolved for URL-level attribution, not a demonstrated current application defect.

## WAB evidence

The dedicated audit is the source of truth; this compact table preserves the decision rows.

| Query | Ticker | Intended | Routes / impr. | Intended / total | Position | Evidence | Material |
|---|---|---|---|---|---|---|---|
| `&quot;earnings per share - wab&quot;` | WAB | `/stocks/WAB/eps` | /stocks/WAB/dividend-history=647; /stocks/WAB/shares-outstanding=622 | 0 / 1,269 (0.00%) | 2.96 | STRONG_EVIDENCE | yes |
| `&quot;earnings per share - wab&quot; financial` | WAB | `/stocks/WAB/eps` | /stocks/WAB/shares-outstanding=373; /stocks/WAB/dividend-history=364 | 0 / 737 (0.00%) | 2.62 | STRONG_EVIDENCE | yes |
| `&quot;shares outstanding - wab&quot; financial` | WAB | `/stocks/WAB/shares-outstanding` | /stocks/WAB/eps=300; /stocks/WAB/dividend-history=296 | 0 / 596 (0.00%) | 2.48 | STRONG_EVIDENCE | yes |
| `&quot;earnings per share - wab&quot; finance` | WAB | `/stocks/WAB/eps` | /stocks/WAB/dividend-history=168; /stocks/WAB/shares-outstanding=168 | 0 / 336 (0.00%) | 2.71 | STRONG_EVIDENCE | yes |
| `&quot;earnings per share - wab&quot; financial statement` | WAB | `/stocks/WAB/eps` | /stocks/WAB/shares-outstanding=229; /stocks/WAB/dividend-history=13 | 0 / 242 (0.00%) | 1.74 | STRONG_EVIDENCE | yes |
| `&quot;shares outstanding - wab&quot; finance` | WAB | `/stocks/WAB/shares-outstanding` | /stocks/WAB/dividend-history=109; /stocks/WAB/eps=109 | 0 / 218 (0.00%) | 2.37 | STRONG_EVIDENCE | yes |
| `&quot;earnings per share - wab&quot; financial model` | WAB | `/stocks/WAB/eps` | /stocks/WAB/dividend-history=93; /stocks/WAB/shares-outstanding=88 | 0 / 181 (0.00%) | 3.07 | STRONG_EVIDENCE | yes |
| `&quot;earnings per share - wab&quot; financial statements` | WAB | `/stocks/WAB/eps` | /stocks/WAB/shares-outstanding=127; /stocks/WAB/dividend-history=16 | 0 / 143 (0.00%) | 1.68 | STRONG_EVIDENCE | yes |
| `&quot;shares outstanding - wab&quot;` | WAB | `/stocks/WAB/shares-outstanding` | /stocks/WAB/eps=58; /stocks/WAB/dividend-history=37 | 0 / 95 (0.00%) | 5.75 | MODERATE_EVIDENCE | yes |
| `&quot;shares outstanding - wab&quot; financial statement` | WAB | `/stocks/WAB/shares-outstanding` | /stocks/WAB/eps=39; /stocks/WAB/dividend-history=23 | 0 / 62 (0.00%) | 3.05 | MODERATE_EVIDENCE | yes |

The strongest rows show 0 intended EPS impressions versus 1,269 relevant wrong-route impressions, and 0 intended shares impressions versus 596 relevant wrong-route impressions; both are STRONG_EVIDENCE and wrong-route dominant.

## Cross-ticker repetition

DELL has two weak-evidence historical revenue mismatches; GOOGL and GM are surfaced but do not provide the same strong repeated wrong-route pattern in this export; CTSH has no qualifying explicit row. The ownership renderer/report is reusable, but no ticker-specific SEO hack is justified.

## SEO demand affected

- Explicit high-confidence metric-query impressions: **2,738**.
- Materially mismatched query impressions: **2,411** (88.06% of observed explicit metric demand).
- These are query aggregate figures matched by query text, not additive site totals; privacy filtering and query/page non-additivity limit precision.

## Alternative explanations

Weak ranking authority, stale indexed HTML, historical Google state, ambiguous intent and small samples can also explain some rows. The WAB rows are not trivial, but ownership and authority are reported separately; a correct page may still need authority. Canonical instability and the July 28 5xx report are not currently demonstrated causes.

## Decision

**GO — IMPLEMENT REUSABLE OWNERSHIP FIX** (limited to existing metric semantics, exact internal anchors, audit instrumentation and canonical consistency). This is justified by high-confidence WAB wrong-route dominance at STRONG_EVIDENCE. Do not expand into new pages, broad authority networks or per-ticker hacks until post-recrawl evidence supports it.

## Rollback/evidence gate

Record deployment time, wait for meaningful recrawl, and compare non-overlapping PRE/POST ownership counts. A ranking or CTR change alone is not an ownership win. If WAB intended ownership does not improve after adequate post data, treat the ownership hypothesis as falsified and investigate authority/content depth instead.
