# Ask company-story recovery — 2026-10-05

## Defect and repair

The question `tell me thes touy of amd` did not select the company-story policy. Once a quote resolved AMD, it selected the full financial-report policy and required unrelated report tools. A second defect affected correctly recognised stories: research depended entirely on the model choosing the appropriate tools. Either path could end in a partial price receipt.

The shared policy now recognises conservative story-word misspellings and company-history requests while preserving instrument identity, ambiguous listings, funds, short limits and price-history lookups. Recognised company stories receive annual statement history and original business excerpts before generation. A bounded historical-document attempt selects primary annual documents from SEC submissions metadata, rather than relevance-ranked exhibits. Missing core evidence triggers the existing shared supplemental tool. These requests use existing tool budgets and add no model extraction calls.

The prose auditor also rejected supported amounts in the original AMD MD&A, including prior-year cash and named division revenue. It now recognises explicit scaled monetary amounts in source-bound original filing excerpts, with matching business labels, native currency and explicit period years. Generated summaries and unsupported amounts remain rejected. These narrative amounts cannot become chart observations or calculator inputs.

## Evidence

### Production follow-up

The first deployed candidate, `35905879`, **still returned a 26-word partial receipt** for the exact question through the authenticated REST API. Its statement tool failed while original filing retrieval succeeded. A separate deterministic production fundamentals call returned five revenue/net-income periods: the financial data existed.

The online resolver adds 240 compatible calculations to AMD's data, including 48 annual income calculations. Ask included the entire calculation history in a five-period statement result. Even after reducing the statement to one period, that payload was **97,183 bytes**, beyond the 65,536-byte tool limit. Offline snapshot reads did not include those live calculations.

The correction scopes calculated receipts to the requested statement/period window, omits a duplicate SEC calculation only when its exact inputs, currencies, scopes and source identities are already supplied, and preserves attributed supplemental calculations. Budget trimming now keeps calculations aligned with retained periods. Narrative excerpts fit the remaining context while typed financial values and provenance remain intact; additional control/correction space is reserved inside the unchanged aggregate budget.

Deterministic reproduction now supplies **five AMD periods in 13,080 bytes**. Complete live projected reports in both modes, including history, all requested tools, supplementation and correction, pass the context checks. Seven-company payload measurements are in `online-context-matrix.json`; TSM's unavailable quarterly ratios remain a specific data gap. These tests make zero model calls. The failed production receipt is retained in `production-failure-35905879.json`.

The reviewer login is an API-only account: website Ask correctly returns `API_PLAN_NO_WEB_ASK`. Production inference verification therefore uses the authorized `/api/v1/ask` route with the exact wording; it does not establish website streaming, production thread persistence or authenticated browser rendering.

Follow-up gates: **527/527 targeted**, **35/35 financial/context regressions**. Full suite **1,380/1,386**: the same five baseline failures plus an intermittent direct-LTD referral-replay assertion, which passes **4/4 standalone**. Dataset and resource checks pass. Financial statements and the aggregate context ceiling are unchanged; narrative space also reserves the later correction/control messages.

### Initial repair checks

- Fresh synthesis of the exact question: **1,018 prose words**, `source: ai`, zero numerical audit findings, four model calls, 32.8 seconds. The saved response predates the final primary-document selection refinement; its old exhibit link is not evidence of a historical primary-document check.
- Final-code deterministic replay of that answer: **1,018 words, zero findings**, zero model calls.
- Final primary-document lookup against SEC: AMD 2020 10-K, filed 2021-01-29, `amd-20201226.htm`; excludes exhibits. This is a candidate until its text is retrieved and reviewed.
- Actual renderer with the saved answer: **1100px and 390px**, two faceted panels, all period labels retained, no horizontal overflow, invalid chart geometry or browser errors. This is loopback rendering, not authenticated production browser verification.
- Targeted deployment regressions: **523/523 passed**. Final monetary/source regressions: **61/61 passed**.
- Final full suite: **1,377/1,382 passed**. The five failures reproduce on unchanged production main: metric ownership/navigation (two), money formatting (one), reasoning effort coupling (one), bounded health-cache source assertion (one). The earlier concurrent social-compose timeout passes standalone and in the final full run.
- Dataset validation: **5,564,534 verified values**, zero errors. Exhaustive public rendering: **6,099 profiles, 28,804 metric pages, 2,897 comparisons, nine sitemap shards**, zero errors.
- Resource gate passed: 315 MiB RSS, 123ms cold public render, 20.7ms event-loop delay, 58.4ms health response.

The saved model response and screenshots are company-only test artifacts. Numerical audit success does not independently validate every qualitative historical claim. Production deployment, authentication and a fresh deployed answer are checked separately after this commit is released. The repair preserves the existing 1,600-word ceiling, visual freedom and 32,000-character answer storage. No frontend asset code changed.
