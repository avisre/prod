# Internal metric authority-flow audit

This audit checks which rendered page types link to metric routes, the semantic anchor used, and whether a source page has observed Search Console visibility. It does not assume comparison or filing pages deserve priority merely because they have impressions.

## Rendered source pages

| Source | Page type | Metric links | Semantic violations | GSC impressions | GSC position |
|---|---|---|---|---|---|
| `/stocks/WAB` | stock | 10 | 0 | 0 | — |
| `/stocks/WAB/revenue` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/net-income` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/gross-profit` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/eps` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/ebitda` | metric | 0 | 0 | 0 | — |
| `/stocks/WAB/free-cash-flow` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/total-debt` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/shares-outstanding` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/dividend-history` | metric | 9 | 0 | 0 | — |
| `/stocks/WAB/pe-ratio` | metric | 9 | 0 | 0 | — |

## Destination/anchor observations

- `/stocks/WAB` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/revenue` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/revenue` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/revenue` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/revenue` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/revenue` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/revenue` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/revenue` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/revenue` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/revenue` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/net-income` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/net-income` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/net-income` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/net-income` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/net-income` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/net-income` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/net-income` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/net-income` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/net-income` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/gross-profit` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/eps` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/eps` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/eps` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/eps` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/eps` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/eps` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/eps` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/eps` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/eps` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/free-cash-flow` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/total-debt` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.
- `/stocks/WAB/shares-outstanding` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/dividend-history` → `/stocks/WAB/pe-ratio` using anchor `P/E Ratio`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/revenue` using anchor `Revenue`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/net-income` using anchor `Net Income`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/gross-profit` using anchor `Gross Profit`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/eps` using anchor `Earnings per Share (EPS)`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/ebitda` using anchor `EBITDA`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/free-cash-flow` using anchor `Free Cash Flow`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/total-debt` using anchor `Total Debt`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/shares-outstanding` using anchor `Shares Outstanding`.
- `/stocks/WAB/pe-ratio` → `/stocks/WAB/dividend-history` using anchor `Dividend History`.

## Priority rule

Correct semantic anchors are retained; only semantically wrong anchors are corrected. Higher-visibility source pages are recorded for follow-up, but an observed comparison or filing page is not automatically a priority. Ownership evidence, intended-route position, wrong-route position and repeated cross-ticker patterns remain the decision inputs.
