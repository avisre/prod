# Activation family selection

**Selected second family: `REVENUE_HISTORY`**

Revenue/history rows map more directly to a single filed metric route and present lower contamination risk than comparison rows; the comparison export does not meet the repeated, clear-intent bar for a safe second family.

## Evidence snapshot

- Comparison: 11 clear rows, 7 pairs, 17 impressions.
- Revenue/history: 42 direct rows, 26 pages, 54 impressions.

## Decision criteria

| Criterion | Evidence/guardrail |
|---|---|
| Demonstrated GSC demand | Both families are evaluated only from observed query/page rows. |
| Query intent clarity | Explicit comparison language is required for comparison rows; revenue wording must map to revenue history. |
| Product relevance | Both can lead to source-backed research; the selected family preserves the answer-first page. |
| Ranking accessibility | Existing pages with impressions are eligible; no new pages are created. |
| Useful next action | Ask receives structured symbol/metric context, never a prompt in the URL. |
| Repeated pattern | Comparison pairs: 7; direct revenue pages: 26. |
| UX/index risk | One optional module is gated by an explicit flag and observed URL manifest. |

This decision is directional. It is not a forecast and is reversible by leaving `SEO_ACTIVATION_PILOT=false`.
