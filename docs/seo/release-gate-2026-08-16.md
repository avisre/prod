# SEO V1 pre-deployment release gate

Generated: **2026-08-16**. This is a read-only canary decision; no deploy,
recrawl, sitemap submission or IndexNow request was made.

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| WAB EPS/shares/dividend title, H1 and opening answer are distinct | PASS | `docs/seo/production-baseline.md` shows separate metric-specific title/H1/answer text. |
| WAB internal anchor semantics | PASS | `docs/seo/internal-metric-link-audit.md`: 44 links checked, 0 flags. |
| URL, redirect, canonical, robots, sitemap architecture and indexability unchanged | PASS | No `seo-pages.js` diff; renderer diff contains no route/canonical/robots/sitemap changes. |
| Bing page/query export | BLOCKED | No current Bing page/query CSV exists in the checkout or supplied Downloads files. |
| Sitemap contract | PASS locally | 19,762 entries, 0 duplicate/contract issues; representative pages are listed and indexable. |
| Sitemap canonical agreement | PASS locally | 20 canary routes checked; each rendered canonical equals its sitemap URL. |
| Sitemap lastmod guardrail | PASS locally | 20 data-backed canary routes match the existing source-data mtime/snapshot rule; no deploy-wide timestamp change. |
| IndexNow deduplication | PASS locally | Duplicate enqueue test produced 1 queue row for 2 identical URLs; queue is empty in the real workspace and no request was sent. |
| Googlebot/Bingbot/normal-user SSR | PASS locally | 20 routes × 3 user-agent classes; title/H1/answer/period/source/methodology/links present; network calls were blocked and Ollama/external LLM calls remained 0. |
| Full regression suite | PASS | Backend `170/170`; focused SEO tests `8/8`; GSC analysis `7/7`; syntax and `git diff --check` pass. |

## WAB evidence

- EPS: title `WAB Earnings per Share (EPS) History …`; H1 and answer explicitly
  describe diluted EPS.
- Shares: title `WAB Shares Outstanding History …`; H1 and answer explicitly
  describe shares outstanding.
- Dividend: title `WAB Dividend History …`; H1 and answer explicitly describe
  dividends paid and label derived per-share values as approximate.
- Exact anchor labels include `Earnings per Share (EPS)`, `Shares Outstanding`
  and `Dividend History`; no generic ownership anchors were flagged.

## Canary decision

Because Bing page/query data is unavailable, only the 20 existing stock/metric
URLs in [seo-v1-canary-cohort.md](./seo-v1-canary-cohort.md) are eligible for an
initial production canary. Global template rollout is not approved.

Comparison pages remain outside this canary because their current raw answer
does not expose an explicit reporting period. No new comparison-page change was
made.

**SEO V1 CANARY: SAFE TO DEPLOY** — limited strictly to the listed 20 URLs,
subject to the normal production smoke test. Do not submit the full sitemap.
