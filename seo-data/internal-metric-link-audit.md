# Internal metric-link audit

The audit renders the WAB stock page and its metric pages, then checks anchors whose destination is an existing metric route. Exact concise labels are accepted (for example, `Earnings per Share (EPS)` and `Shares Outstanding`); ticker repetition is not required.

- `/stocks/WAB` — 76 anchors inspected; **0** semantic violations.
- `/stocks/WAB/revenue` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/net-income` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/gross-profit` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/eps` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/ebitda` — 0 anchors inspected; **0** semantic violations.
- `/stocks/WAB/free-cash-flow` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/total-debt` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/shares-outstanding` — 44 anchors inspected; **0** semantic violations.
- `/stocks/WAB/dividend-history` — 43 anchors inspected; **0** semantic violations.
- `/stocks/WAB/pe-ratio` — 44 anchors inspected; **0** semantic violations.

## Violations

No semantically wrong EPS, shares-outstanding, revenue, net-income or dividend-history anchors were found in the rendered WAB set.

Only semantically incorrect anchors are changed; this audit does not recommend a broader internal-link network.
