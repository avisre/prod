# Conservative query ownership audit

Generated: **2026-08-16T12:57:55.097Z**
Inputs: Google `/home/hardoker77/Downloads/new/prod-main/seo-data/gsc/query-page-3m.csv` (981 rows); Bing **not available**; 981 combined query/page rows; 632 unique query groups.

> Statuses are diagnostic only: `CORRECT` means the observed dominant metric route matches a single high-confidence phrase; `WRONG_METRIC` means it does not; `AMBIGUOUS` never justifies a rewrite; `UNKNOWN` has no reliable metric route. Generic terms such as earnings, profit, sales, dilution, buyback and valuation remain ambiguous.

## Status counts

- **WRONG_METRIC:** 30
- **AMBIGUOUS:** 440
- **CORRECT:** 127
- **UNKNOWN:** 35

## Explicit ownership rows

| Query | Ticker | Intent | Expected | Dominant | Status | Intended / total | Rate | Wrong-route imp. | Competing routes | Position | CTR |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| "earnings per share - wab" | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 1269 | 0.00% | 1269 | 1 | 2.96 | 0.00% |
| "earnings per share - wab" financial | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/shares-outstanding` | **WRONG_METRIC** | 0 / 737 | 0.00% | 737 | 1 | 2.62 | 0.00% |
| "shares outstanding - wab" financial | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/eps` | **WRONG_METRIC** | 0 / 596 | 0.00% | 596 | 1 | 2.48 | 0.00% |
| "earnings per share - wab" finance | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 336 | 0.00% | 336 | 1 | 2.71 | 0.00% |
| "earnings per share - wab" financial statement | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/shares-outstanding` | **WRONG_METRIC** | 0 / 242 | 0.00% | 242 | 1 | 1.74 | 0.00% |
| "shares outstanding - wab" finance | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 218 | 0.00% | 218 | 1 | 2.37 | 0.00% |
| "earnings per share - wab" financial model | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 181 | 0.00% | 181 | 1 | 3.07 | 0.00% |
| "earnings per share - wab" financial statements | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/shares-outstanding` | **WRONG_METRIC** | 0 / 143 | 0.00% | 143 | 1 | 1.68 | 0.00% |
| "shares outstanding - wab" | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/eps` | **WRONG_METRIC** | 0 / 95 | 0.00% | 95 | 1 | 5.75 | 0.00% |
| "shares outstanding - wab" financial statement | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/eps` | **WRONG_METRIC** | 0 / 62 | 0.00% | 62 | 1 | 3.05 | 0.00% |
| dell technologies historical revenue fy2016 fy2017 fy2018 fy2019 fy2020 fy2021 fy2022 fy2023 fy2024 fy2025 | DELL | REVENUE | `/stocks/DELL/revenue` | `/stocks/DELL/shares-outstanding` | **WRONG_METRIC** | 0 / 15 | 0.00% | 15 | 1 | 9.00 | 0.00% |
| "shares outstanding - wab" financial model | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/eps` | **WRONG_METRIC** | 0 / 14 | 0.00% | 14 | 1 | 3.86 | 0.00% |
| "shares outstanding - wab" financial statements | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 11 | 0.00% | 11 | 1 | 1.64 | 0.00% |
| dell technologies historical annual revenue fy2016 fy2017 fy2018 fy2019 fy2020 fy2021 fy2022 fy2023 fy2024 fy2025 | DELL | REVENUE | `/stocks/DELL/revenue` | `/stocks/DELL/shares-outstanding` | **WRONG_METRIC** | 0 / 11 | 0.00% | 11 | 0 | 12.09 | 0.00% |
| "earnings per share - wab" financial data | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 6 | 0.00% | 6 | 1 | 2.00 | 0.00% |
| "shares outstanding - wab" financial data | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 6 | 0.00% | 6 | 0 | 1.00 | 0.00% |
| financial data "earnings per share - wab" | WAB | EPS | `/stocks/WAB/eps` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 2 | 0.00% | 2 | 0 | 1.50 | 0.00% |
| financial data "shares outstanding - wab" | WAB | SHARES | `/stocks/WAB/shares-outstanding` | `/stocks/WAB/dividend-history` | **WRONG_METRIC** | 0 / 2 | 0.00% | 2 | 0 | 5.00 | 0.00% |
| adt annual revenue | ADT | REVENUE | `/stocks/ADT/revenue` | `/stocks/ADT/net-income` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 48.00 | 0.00% |
| adt shares outstanding | ADT | SHARES | `/stocks/ADT/shares-outstanding` | `/stocks/ADT/eps` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 75.00 | 0.00% |
| annual revenue disney | DIS | REVENUE | `/stocks/DIS/revenue` | `/stocks/DIS/net-income` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 64.00 | 0.00% |
| dell technologies historical annual revenue last 10 years fy2015 to fy2025 | DELL | REVENUE | `/stocks/DELL/revenue` | `/stocks/DELL/shares-outstanding` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 18.00 | 0.00% |
| dell technologies historical revenue 10 years fy2015 to fy2025 | DELL | REVENUE | `/stocks/DELL/revenue` | `/stocks/DELL/gross-profit` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 17.00 | 0.00% |
| dell technologies revenue fy2016 fy2017 fy2018 fy2019 fy2020 fy2021 fy2022 fy2023 fy2024 fy2025 | DELL | REVENUE | `/stocks/DELL/revenue` | `/stocks/DELL/shares-outstanding` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 18.00 | 0.00% |
| gm annual revenue | GM | REVENUE | `/stocks/GM/revenue` | `/stocks/GM/gross-profit` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 77.00 | 0.00% |
| gm yearly revenue | GM | REVENUE | `/stocks/GM/revenue` | `/stocks/GM/gross-profit` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 77.00 | 0.00% |
| lincoln electric annual revenue | LECO | REVENUE | `/stocks/LECO/revenue` | `/stocks/LECO/net-income` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 56.00 | 0.00% |
| lyft net income | LYFT | NET_INCOME | `/stocks/LYFT/net-income` | `/stocks/LYFT/revenue` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 65.00 | 0.00% |
| mirion technologies revenue | MIR | REVENUE | `/stocks/MIR/revenue` | `/stocks/MIR/net-income` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 60.00 | 0.00% |
| new york times annual revenue | NYT | REVENUE | `/stocks/NYT/revenue` | `/stocks/NYT/net-income` | **WRONG_METRIC** | 0 / 1 | 0.00% | 1 | 0 | 62.00 | 0.00% |
| msci dividend indexes | MSCI | DIVIDEND | `/stocks/MSCI/dividend-history` | `/stocks/MSCI/dividend-history` | **CORRECT** | 14 / 14 | 100.00% | 0 | 0 | 50.36 | 0.00% |
| wells fargo dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 6 / 6 | 100.00% | 0 | 0 | 63.33 | 0.00% |
| disney s dividend history | DIS | DIVIDEND | `/stocks/DIS/dividend-history` | `/stocks/DIS/dividend-history` | **CORRECT** | 5 / 5 | 100.00% | 0 | 0 | 84.40 | 0.00% |
| wells fargo stock dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 4 / 4 | 100.00% | 0 | 0 | 40.75 | 0.00% |
| wfc dividend history | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 4 / 4 | 100.00% | 0 | 0 | 66.75 | 0.00% |
| dell shares outstanding 2026 | DELL | SHARES | `/stocks/DELL/shares-outstanding` | `/stocks/DELL/shares-outstanding` | **CORRECT** | 3 / 3 | 100.00% | 0 | 0 | 10.00 | 0.00% |
| jazz pharmaceuticals total debt cash fy2025 | JAZZ | DEBT | `/stocks/JAZZ/total-debt` | `/stocks/JAZZ/total-debt` | **CORRECT** | 3 / 3 | 100.00% | 0 | 0 | 13.33 | 0.00% |
| nutanix revenue | NTNX | REVENUE | `/stocks/NTNX/revenue` | `/stocks/NTNX/revenue` | **CORRECT** | 3 / 3 | 100.00% | 0 | 0 | 44.67 | 0.00% |
| rh aero systems revenue | RH | REVENUE | `/stocks/RH/revenue` | `/stocks/RH/revenue` | **CORRECT** | 3 / 3 | 100.00% | 0 | 0 | 71.33 | 0.00% |
| wells fargo dividend history | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 3 / 3 | 100.00% | 0 | 0 | 61.67 | 0.00% |
| wfc dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 3 / 3 | 100.00% | 0 | 0 | 81.33 | 0.00% |
| $vsts vestis corporation $vsts earnings revenue financials | VSTS | REVENUE | `/stocks/VSTS/revenue` | `/stocks/VSTS/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 50.00 | 0.00% |
| concentrix revenue | CNXC | REVENUE | `/stocks/CNXC/revenue` | `/stocks/CNXC/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 70.50 | 0.00% |
| disney revenue | DIS | REVENUE | `/stocks/DIS/revenue` | `/stocks/DIS/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 62.00 | 0.00% |
| fortive revenue 2023 | FTV | REVENUE | `/stocks/FTV/revenue` | `/stocks/FTV/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 68.00 | 0.00% |
| ge healthcare revenue | GEHC | REVENUE | `/stocks/GEHC/revenue` | `/stocks/GEHC/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 55.00 | 0.00% |
| googl shares outstanding 2025 | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 9.00 | 0.00% |
| google net income | GOOGL | NET_INCOME | `/stocks/GOOGL/net-income` | `/stocks/GOOGL/net-income` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 53.50 | 0.00% |
| google shares outstanding | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 46.50 | 0.00% |
| hban ex dividend date | HBAN | DIVIDEND | `/stocks/HBAN/dividend-history` | `/stocks/HBAN/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 62.50 | 0.00% |
| henry schein revenue | HSIC | REVENUE | `/stocks/HSIC/revenue` | `/stocks/HSIC/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 46.00 | 0.00% |
| kkr stock dividend | KKR | DIVIDEND | `/stocks/KKR/dividend-history` | `/stocks/KKR/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 49.00 | 0.00% |
| marriott dividend history | MAR | DIVIDEND | `/stocks/MAR/dividend-history` | `/stocks/MAR/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 42.00 | 0.00% |
| netflix yearly revenue | NFLX | REVENUE | `/stocks/NFLX/revenue` | `/stocks/NFLX/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 63.50 | 0.00% |
| schrodinger revenue | SDGR | REVENUE | `/stocks/SDGR/revenue` | `/stocks/SDGR/revenue` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 45.50 | 0.00% |
| starwood property trust dividend | STWD | DIVIDEND | `/stocks/STWD/dividend-history` | `/stocks/STWD/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 51.00 | 0.00% |
| waste management dividend | WM | DIVIDEND | `/stocks/WM/dividend-history` | `/stocks/WM/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 59.50 | 0.00% |
| wells fargo ex dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 68.00 | 0.00% |
| wfc dividend date | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 85.50 | 0.00% |
| wm dividend history | WM | DIVIDEND | `/stocks/WM/dividend-history` | `/stocks/WM/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 37.00 | 0.00% |
| wm stock dividend | WM | DIVIDEND | `/stocks/WM/dividend-history` | `/stocks/WM/dividend-history` | **CORRECT** | 2 / 2 | 100.00% | 0 | 0 | 66.00 | 0.00% |
| alphabet googl shares outstanding 2025 | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 7.00 | 0.00% |
| alphabet shares outstanding | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 26.00 | 0.00% |
| annual revenue coca cola | KO | REVENUE | `/stocks/KO/revenue` | `/stocks/KO/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 50.00 | 0.00% |
| apple shares outstanding 2011 | AAPL | SHARES | `/stocks/AAPL/shares-outstanding` | `/stocks/AAPL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 66.00 | 0.00% |
| arr dividend | ARR | DIVIDEND | `/stocks/ARR/dividend-history` | `/stocks/ARR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 41.00 | 0.00% |
| boeing earnings per share | BA | EPS | `/stocks/BA/eps` | `/stocks/BA/eps` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 27.00 | 0.00% |
| carvana shares outstanding 2025 | CVNA | SHARES | `/stocks/CVNA/shares-outstanding` | `/stocks/CVNA/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 67.00 | 0.00% |
| cheesecake factory annual revenue | CAKE | REVENUE | `/stocks/CAKE/revenue` | `/stocks/CAKE/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 45.00 | 0.00% |
| clearway energy stock dividend | CWEN | DIVIDEND | `/stocks/CWEN/dividend-history` | `/stocks/CWEN/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 53.00 | 0.00% |
| coca-cola revenue | KO | REVENUE | `/stocks/KO/revenue` | `/stocks/KO/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 62.00 | 0.00% |
| comcast annual revenue | CMCSA | REVENUE | `/stocks/CMCSA/revenue` | `/stocks/CMCSA/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 53.00 | 0.00% |
| comcast revenue 2024 | CMCSA | REVENUE | `/stocks/CMCSA/revenue` | `/stocks/CMCSA/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 58.00 | 0.00% |
| comcast yearly revenue | CMCSA | REVENUE | `/stocks/CMCSA/revenue` | `/stocks/CMCSA/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 51.00 | 0.00% |
| dell shares outstanding | DELL | SHARES | `/stocks/DELL/shares-outstanding` | `/stocks/DELL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 14.00 | 0.00% |
| disney revenue breakdown | DIS | REVENUE | `/stocks/DIS/revenue` | `/stocks/DIS/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 56.00 | 0.00% |
| doc dividend history | DOC | DIVIDEND | `/stocks/DOC/dividend-history` | `/stocks/DOC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 34.00 | 0.00% |
| does crowdstrike offer dividend payments? | CRWD | DIVIDEND | `/stocks/CRWD/dividend-history` | `/stocks/CRWD/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 46.00 | 0.00% |
| eix stock dividend history | EIX | DIVIDEND | `/stocks/EIX/dividend-history` | `/stocks/EIX/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 28.00 | 0.00% |
| entegris revenue | ENTG | REVENUE | `/stocks/ENTG/revenue` | `/stocks/ENTG/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 70.00 | 0.00% |
| eps history | IP | EPS | `/stocks/IP/eps` | `/stocks/IP/eps` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 68.00 | 0.00% |
| etd stock dividend | ETD | DIVIDEND | `/stocks/ETD/dividend-history` | `/stocks/ETD/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 40.00 | 0.00% |
| fortive 2023 annual report revenue | FTV | REVENUE | `/stocks/FTV/revenue` | `/stocks/FTV/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 67.00 | 0.00% |
| fortive 2023 annual revenue | FTV | REVENUE | `/stocks/FTV/revenue` | `/stocks/FTV/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 70.00 | 0.00% |
| fortive 2023 revenue | FTV | REVENUE | `/stocks/FTV/revenue` | `/stocks/FTV/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 73.00 | 0.00% |
| fortive full year 2023 revenue | FTV | REVENUE | `/stocks/FTV/revenue` | `/stocks/FTV/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 67.00 | 0.00% |
| ge healthcare annual revenue | GEHC | REVENUE | `/stocks/GEHC/revenue` | `/stocks/GEHC/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 47.00 | 0.00% |
| goog shares outstanding | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 13.00 | 0.00% |
| google earnings per share | GOOGL | EPS | `/stocks/GOOGL/eps` | `/stocks/GOOGL/eps` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 48.00 | 0.00% |
| google eps | GOOGL | EPS | `/stocks/GOOGL/eps` | `/stocks/GOOGL/eps` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 56.00 | 0.00% |
| google net income 2022 | GOOGL | NET_INCOME | `/stocks/GOOGL/net-income` | `/stocks/GOOGL/net-income` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 47.00 | 0.00% |
| google net income 2023 | GOOGL | NET_INCOME | `/stocks/GOOGL/net-income` | `/stocks/GOOGL/net-income` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 45.00 | 0.00% |
| google net profit | GOOGL | NET_INCOME | `/stocks/GOOGL/net-income` | `/stocks/GOOGL/net-income` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 64.00 | 0.00% |
| google net profit 2025 | GOOG | NET_INCOME | `/stocks/GOOG/net-income` | `/stocks/GOOG/net-income` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 58.00 | 0.00% |
| google outstanding shares | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 61.00 | 0.00% |
| hban dividend | HBAN | DIVIDEND | `/stocks/HBAN/dividend-history` | `/stocks/HBAN/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 65.00 | 0.00% |
| hban dividend date | HBAN | DIVIDEND | `/stocks/HBAN/dividend-history` | `/stocks/HBAN/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 63.00 | 0.00% |
| hss revenue | JBSS | REVENUE | `/stocks/JBSS/revenue` | `/stocks/JBSS/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 69.00 | 0.00% |
| huntington bank stock dividend | HBAN | DIVIDEND | `/stocks/HBAN/dividend-history` | `/stocks/HBAN/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 75.00 | 0.00% |
| insw dividend history | INSW | DIVIDEND | `/stocks/INSW/dividend-history` | `/stocks/INSW/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 34.00 | 0.00% |
| investors.delltechnologies.com shares outstanding dell technologies | DELL | SHARES | `/stocks/DELL/shares-outstanding` | `/stocks/DELL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 11.00 | 0.00% |
| kkr annual revenue | KKR | REVENUE | `/stocks/KKR/revenue` | `/stocks/KKR/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 57.00 | 0.00% |
| kkr dividend date | KKR | DIVIDEND | `/stocks/KKR/dividend-history` | `/stocks/KKR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 62.00 | 0.00% |
| kkr ex dividend date | KKR | DIVIDEND | `/stocks/KKR/dividend-history` | `/stocks/KKR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 60.00 | 0.00% |
| kla annual revenue | KLAC | REVENUE | `/stocks/KLAC/revenue` | `/stocks/KLAC/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 56.00 | 0.00% |
| krc dividend | KRC | DIVIDEND | `/stocks/KRC/dividend-history` | `/stocks/KRC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 46.00 | 0.00% |
| krc dividend history | KRC | DIVIDEND | `/stocks/KRC/dividend-history` | `/stocks/KRC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 34.00 | 0.00% |
| lamb weston annual revenue | LW | REVENUE | `/stocks/LW/revenue` | `/stocks/LW/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 44.00 | 0.00% |
| lxp dividend history | LXP | DIVIDEND | `/stocks/LXP/dividend-history` | `/stocks/LXP/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 79.00 | 0.00% |
| lyft revenue | LYFT | REVENUE | `/stocks/LYFT/revenue` | `/stocks/LYFT/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 53.00 | 0.00% |
| marathon petroleum stock dividend | MPC | DIVIDEND | `/stocks/MPC/dividend-history` | `/stocks/MPC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 59.00 | 0.00% |
| moh stock dividend | MOH | DIVIDEND | `/stocks/MOH/dividend-history` | `/stocks/MOH/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 33.00 | 0.00% |
| motorola solutions annual revenue | MSI | REVENUE | `/stocks/MSI/revenue` | `/stocks/MSI/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 35.00 | 0.00% |
| mrk dividend | MRK | DIVIDEND | `/stocks/MRK/dividend-history` | `/stocks/MRK/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 65.00 | 0.00% |
| mrk next dividend date | MRK | DIVIDEND | `/stocks/MRK/dividend-history` | `/stocks/MRK/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 69.00 | 0.00% |
| ms dividend history | MS | DIVIDEND | `/stocks/MS/dividend-history` | `/stocks/MS/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 29.00 | 0.00% |
| net income of google | GOOG | NET_INCOME | `/stocks/GOOG/net-income` | `/stocks/GOOG/net-income` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 79.00 | 0.00% |
| netflix annual revenue | NFLX | REVENUE | `/stocks/NFLX/revenue` | `/stocks/NFLX/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 60.00 | 0.00% |
| netflix revenue per year | NFLX | REVENUE | `/stocks/NFLX/revenue` | `/stocks/NFLX/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 71.00 | 0.00% |
| nflx revenue | NFLX | REVENUE | `/stocks/NFLX/revenue` | `/stocks/NFLX/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 39.00 | 0.00% |
| nvidia outstanding shares | NVDA | SHARES | `/stocks/NVDA/shares-outstanding` | `/stocks/NVDA/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 24.00 | 0.00% |
| nyse dlr dividend | DLR | DIVIDEND | `/stocks/DLR/dividend-history` | `/stocks/DLR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 88.00 | 0.00% |
| nyse wfc dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 52.00 | 0.00% |
| organon stock dividend | OGN | DIVIDEND | `/stocks/OGN/dividend-history` | `/stocks/OGN/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 51.00 | 0.00% |
| outstanding shares of google | GOOGL | SHARES | `/stocks/GOOGL/shares-outstanding` | `/stocks/GOOGL/shares-outstanding` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 53.00 | 0.00% |
| palantir dividend | PLTR | DIVIDEND | `/stocks/PLTR/dividend-history` | `/stocks/PLTR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 64.00 | 0.00% |
| palantir stock dividend | PLTR | DIVIDEND | `/stocks/PLTR/dividend-history` | `/stocks/PLTR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 55.00 | 0.00% |
| revenue of genpact | G | REVENUE | `/stocks/G/revenue` | `/stocks/G/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 73.00 | 0.00% |
| sm dividend history | SM | DIVIDEND | `/stocks/SM/dividend-history` | `/stocks/SM/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 28.00 | 0.00% |
| stwd dividend history | STWD | DIVIDEND | `/stocks/STWD/dividend-history` | `/stocks/STWD/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 39.00 | 0.00% |
| stwd next dividend date | STWD | DIVIDEND | `/stocks/STWD/dividend-history` | `/stocks/STWD/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 58.00 | 0.00% |
| stwd stock dividend | STWD | DIVIDEND | `/stocks/STWD/dividend-history` | `/stocks/STWD/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 56.00 | 0.00% |
| syy dividend history | SYY | DIVIDEND | `/stocks/SYY/dividend-history` | `/stocks/SYY/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 24.00 | 0.00% |
| tootsie roll dividend | TR | DIVIDEND | `/stocks/TR/dividend-history` | `/stocks/TR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 46.00 | 0.00% |
| tootsie roll stock dividend | TR | DIVIDEND | `/stocks/TR/dividend-history` | `/stocks/TR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 46.00 | 0.00% |
| tr dividend history | TR | DIVIDEND | `/stocks/TR/dividend-history` | `/stocks/TR/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 28.00 | 0.00% |
| tripadvisor revenue | TRIP | REVENUE | `/stocks/TRIP/revenue` | `/stocks/TRIP/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 69.00 | 0.00% |
| veeva annual revenue | VEEV | REVENUE | `/stocks/VEEV/revenue` | `/stocks/VEEV/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 36.00 | 0.00% |
| verizon annual revenue | VZ | REVENUE | `/stocks/VZ/revenue` | `/stocks/VZ/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 28.00 | 0.00% |
| verizon revenue | VZ | REVENUE | `/stocks/VZ/revenue` | `/stocks/VZ/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 75.00 | 0.00% |
| verizon revenue 2023 | VZ | REVENUE | `/stocks/VZ/revenue` | `/stocks/VZ/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 81.00 | 0.00% |
| verizon wireless annual revenue | VZ | REVENUE | `/stocks/VZ/revenue` | `/stocks/VZ/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 82.00 | 0.00% |
| w.w. grainger revenue | GWW | REVENUE | `/stocks/GWW/revenue` | `/stocks/GWW/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 56.00 | 0.00% |
| walt disney company revenue | DIS | REVENUE | `/stocks/DIS/revenue` | `/stocks/DIS/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 52.00 | 0.00% |
| warner bros revenue | WBD | REVENUE | `/stocks/WBD/revenue` | `/stocks/WBD/revenue` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 59.00 | 0.00% |
| wells fargo dividend date | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 86.00 | 0.00% |
| wells fargo dividend pay date | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 88.00 | 0.00% |
| wells fargo dividend schedule | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 76.00 | 0.00% |
| wells fargo dividend stock | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 57.00 | 0.00% |
| wells fargo stock dividend history | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 73.00 | 0.00% |
| wellsfargo dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 80.00 | 0.00% |
| welltower dividend | WELL | DIVIDEND | `/stocks/WELL/dividend-history` | `/stocks/WELL/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 83.00 | 0.00% |
| wf dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 81.00 | 0.00% |
| wfc ex dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 81.00 | 0.00% |
| wfc ex dividend date | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 79.00 | 0.00% |
| wfc stock dividend | WFC | DIVIDEND | `/stocks/WFC/dividend-history` | `/stocks/WFC/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 56.00 | 0.00% |
| yum ex dividend date | YUM | DIVIDEND | `/stocks/YUM/dividend-history` | `/stocks/YUM/dividend-history` | **CORRECT** | 1 / 1 | 100.00% | 0 | 0 | 54.00 | 0.00% |

## Interpretation guardrails

- Ownership rate is intended-route impressions divided by impressions across relevant metric routes for the same query; it is not a site-wide CTR or ranking metric.
- A trivial secondary URL is reported but is not material cannibalization by itself. Use the existing evidence-floor/material rule in `scripts/analyze-gsc-seo.py` before changing templates.
- Query and page dimensions are non-additive. Do not sum this report into a Search Console property total.

Full machine-readable output: `/home/hardoker77/Downloads/new/prod-main/docs/seo/query-page-ownership.csv`.
