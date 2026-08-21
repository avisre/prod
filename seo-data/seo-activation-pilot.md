# SEO activation pilot record

## Scope

- Feature flag: `SEO_ACTIVATION_PILOT=false` by default.
- Initial pilot is **100% exposure** for eligible organic visitors, not URL-hash randomization and not a statistically powered A/B test.
- Fixed family: observed EPS/earnings pages. Selected second family: `REVENUE_HISTORY`.
- No new pages, broad internal-link network, pricing, Stripe or AppSumo changes.

## Hypothesis

A visitor who arrived from an organic search query about a filed metric may use one relevant, structured research action after seeing the answer, data and source. The pilot measures whether that action is used, not whether impressions equal commercial intent.

## Observed baseline

- Local GSC export retrieved: `2026-08-10T07:39:58.124298+00:00`.
- Eligible pages in the observed manifest: **34**.
- WAB/EPS rows (if present) are retained as an observed signal, not proof of purchase intent:

  - `"earnings per share - wab"` — 845 impressions, 0 clicks, 0.00% CTR, position 2.55.
  - `"earnings per share - wab" "shares outstanding - wab"` — 892 impressions, 0 clicks, 0.00% CTR, position 1.57.
  - `"earnings per share - wab" "shares outstanding - wab" financial` — 5 impressions, 0 clicks, 0.00% CTR, position 1.40.
  - `"earnings per share - wab" "shares outstanding - wab" financial statement` — 7 impressions, 0 clicks, 0.00% CTR, position 1.29.
  - `"earnings per share - wab" "shares outstanding - wab" financial statements` — 2 impressions, 0 clicks, 0.00% CTR, position 1.00.
  - `"earnings per share - wab" finance` — 174 impressions, 0 clicks, 0.00% CTR, position 1.59.
  - `"earnings per share - wab" financial` — 383 impressions, 0 clicks, 0.00% CTR, position 1.65.
  - `"earnings per share - wab" financial data` — 6 impressions, 0 clicks, 0.00% CTR, position 2.00.
  - `"earnings per share - wab" financial model` — 95 impressions, 0 clicks, 0.00% CTR, position 1.65.
  - `"earnings per share - wab" financial statement` — 229 impressions, 0 clicks, 0.00% CTR, position 1.63.
  - `"earnings per share - wab" financial statements` — 142 impressions, 0 clicks, 0.00% CTR, position 1.65.
  - `"shares outstanding - wab" "earnings per share - wab"` — 53 impressions, 0 clicks, 0.00% CTR, position 1.47.
  - `financial data "earnings per share - wab"` — 2 impressions, 0 clicks, 0.00% CTR, position 1.50.
  - No WAB `/eps` or `/net-income` page is eligible for the activation module because the observed query/page evidence maps to neighboring metric pages; this is an ownership-fix signal, not a reason to broaden eligibility.

## Treatment module

- EPS/earnings: `Explain these earnings changes` → `/ask?symbol=...&metric=eps&content_id=seo-eps-next-action`.
- Revenue/history: `Explain this revenue change` → `/ask?symbol=...&metric=revenue&content_id=seo-revenue-next-action` when selected.
- Comparison is not enabled unless the evidence report selects it; no prompt text is placed in URL state.
- Existing canonical URL, title, H1, answer, data, chart/table, source and methodology remain unchanged and above the optional module.

## Event flow

`organic landing` → `seo_next_action_click` → `ask_landing` → `ask_first_query_submitted` → `ask_response_completed` / `source_opened` → existing signup/trial/paid events.

Metadata is allowlisted page context only; prompts, research text, cookies, credentials and tokens are excluded. Organic is derived from first-party referrer/acquisition state; `source=organic` cannot override it.

## Rollback and evaluation

- Roll back only the module by setting `SEO_ACTIVATION_PILOT=false`; ranking-only title/H1 changes remain independently reversible.
- Wait at least 28 days and reportable sessions before drawing directional conclusions; classify results as strong, weak, no-signal or negative.
- Review ranking (impressions/CTR/position), action clicks, Ask activation/source opens, signups/trials and paid events separately.

## Adversarial review

- Impressions can be accidental long-tail matching, especially for comparisons; quality reports explicitly test this.
- Average position hides country/device/day variation; no fixed-rank claim is made.
- A CTA can reduce trust or CTR; keep the answer-first layout and monitor ranking/CTR.
- Navigation is not activation; Ask landing alone is not counted as meaningful use.
- Attribution must preserve signed first touch and must not be overwritten by URL parameters.
- The eligibility manifest prevents index bloat and broad all-ticker rollout.
- The current sample is small; no significance claim or revenue forecast is permitted.
