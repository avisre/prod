# Internal metric-link semantic audit

Generated: **2026-08-16T12:55:28.056Z**

> Rendered anchors are checked against their destination metric. This report is a read-only audit; no links were rewritten.

## Findings

| Source | Destination | Anchor | Destination metric | Status |
|---|---|---|---|---|
| `/stocks/AAP` | `/stocks/AAP/revenue` | Revenue | revenue | OK |
| `/stocks/AAP` | `/stocks/AAP/net-income` | Net Income | net-income | OK |
| `/stocks/AAP` | `/stocks/AAP/eps` | Earnings per Share (EPS) | eps | OK |
| `/stocks/AAP` | `/stocks/AAP/free-cash-flow` | Free Cash Flow | free-cash-flow | OK |
| `/stocks/AAP` | `/stocks/AAP/total-debt` | Total Debt | total-debt | OK |
| `/stocks/AAP` | `/stocks/AAP/shares-outstanding` | Shares Outstanding | shares-outstanding | OK |
| `/stocks/AAP` | `/stocks/AAP/dividend-history` | Dividend History | dividend-history | OK |
| `/stocks/AAP` | `/stocks/AAP/pe-ratio` | P/E Ratio | pe-ratio | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/revenue` | Revenue | revenue | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/net-income` | Net Income | net-income | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/eps` | Earnings per Share (EPS) | eps | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/total-debt` | Total Debt | total-debt | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/shares-outstanding` | Shares Outstanding | shares-outstanding | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/dividend-history` | Dividend History | dividend-history | OK |
| `/stocks/AAP/free-cash-flow` | `/stocks/AAP/pe-ratio` | P/E Ratio | pe-ratio | OK |
| `/stocks/WAB` | `/stocks/WAB/revenue` | Revenue | revenue | OK |
| `/stocks/WAB` | `/stocks/WAB/net-income` | Net Income | net-income | OK |
| `/stocks/WAB` | `/stocks/WAB/eps` | Earnings per Share (EPS) | eps | OK |
| `/stocks/WAB` | `/stocks/WAB/free-cash-flow` | Free Cash Flow | free-cash-flow | OK |
| `/stocks/WAB` | `/stocks/WAB/total-debt` | Total Debt | total-debt | OK |
| `/stocks/WAB` | `/stocks/WAB/shares-outstanding` | Shares Outstanding | shares-outstanding | OK |
| `/stocks/WAB` | `/stocks/WAB/dividend-history` | Dividend History | dividend-history | OK |
| `/stocks/WAB` | `/stocks/WAB/pe-ratio` | P/E Ratio | pe-ratio | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/revenue` | Revenue | revenue | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/net-income` | Net Income | net-income | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/free-cash-flow` | Free Cash Flow | free-cash-flow | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/total-debt` | Total Debt | total-debt | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/shares-outstanding` | Shares Outstanding | shares-outstanding | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/dividend-history` | Dividend History | dividend-history | OK |
| `/stocks/WAB/eps` | `/stocks/WAB/pe-ratio` | P/E Ratio | pe-ratio | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/revenue` | Revenue | revenue | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/net-income` | Net Income | net-income | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/eps` | Earnings per Share (EPS) | eps | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/free-cash-flow` | Free Cash Flow | free-cash-flow | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/total-debt` | Total Debt | total-debt | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/dividend-history` | Dividend History | dividend-history | OK |
| `/stocks/WAB/shares-outstanding` | `/stocks/WAB/pe-ratio` | P/E Ratio | pe-ratio | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/revenue` | Revenue | revenue | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/net-income` | Net Income | net-income | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/eps` | Earnings per Share (EPS) | eps | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/free-cash-flow` | Free Cash Flow | free-cash-flow | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/total-debt` | Total Debt | total-debt | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/shares-outstanding` | Shares Outstanding | shares-outstanding | OK |
| `/stocks/WAB/dividend-history` | `/stocks/WAB/pe-ratio` | P/E Ratio | pe-ratio | OK |

- Total rendered metric links: **44**.
- Semantic flags: **0**.

## Correction rules

- EPS anchors must describe earnings per share/EPS.
- Shares anchors must describe shares outstanding/share count.
- Revenue anchors must describe revenue.
- Dividend anchors must describe dividend history/dividends.
- Generic “view metric”/“learn more” anchors are not used as semantic ownership evidence.
- A company hub may use concise labels without repeating the ticker.
