# Statement completeness audit (2026-10-17)

Read-only measurement of what each US stock's company page shows in the income, balance sheet and
cash-flow tables, row by row, including every row inside the dropdowns. Source of truth for the
rows is `frontend-v2/assets/company.js`; source of truth for "does SEC have it" is the SEC
`companyfacts` bulk file (downloaded to the scratchpad, not the repo).

Method: latest 5 annual and 8 quarterly periods per stock. A row is **filled** when every period
has a value, **gappy** when some do, **hidden** when none do (the page drops hidden rows).
Rows that cannot exist for the industry (e.g. gross profit for a bank) are excluded.

## After the fill (re-audit, 2026-10-17)

Same method, re-run on the re-extracted data (`SEC_BULK_DIR` set, so every blank is checked against SEC).
Everything below the next heading is the baseline taken before the work.

| Tier 1 (4,193 regular US reporters) | Before | After |
|---|---|---|
| Applicable annual rows filled for all 5 years | 126,939 of 287,536 (44.1%) | **176,942 of 295,442 (59.9%)** |
| Stocks with >= 70% of applicable rows filled | 0 | **1,486** |
| Stocks with no filled row at all | 33 | 31 |
| Stocks with every applicable row filled | 0 | 0 |

By industry: software 52% -> 71%, consumer 51 -> 70, industrial 50 -> 68, semis/hardware 49 -> 65,
utility 44 -> 64, energy 42 -> 59, capital markets 44 -> 58, pharma/biotech 42 -> 58, insurer 41 -> 55,
bank 42 -> 54, REIT 36 -> 50, generic 36 -> 48.

Stocks (annual rows filled / applicable): AAPL 44/69 -> 63/71, MSFT 41/70 -> 57/72, AMZN 37/69 -> 53/71,
XOM 36/70 -> 51/72, O 23/64 -> 33/66, JPM 26/64 -> 35/64, PGR 21/60 -> 27/60. (The applicable count
rose by two because the page gained the Accounts payable, Debt issued and Debt repaid rows.)

Why Tier 1 annual rows are still blank:

| Reason | Before | After |
|---|---|---|
| `unmapped_sec_has_it` | 49,595 | **0** (every page row now reads SEC) |
| `computed_line_not_built` | 8,134 | **0** (EBIT and EBITDA are built) |
| `sec_has_mapped_tag` | 3,318 | 1,187 |
| `sec_has_alt_tag` | 23,968 | 23,135 |
| `not_reported` (+ `unmapped_not_reported` before) | 69,514 | 87,993 |

`not_reported` grew because rows that used to be counted as unmapped are now checked against SEC
and found absent. `sec_has_alt_tag` is mostly lines that are not the page row: for example
`GeneralAndAdministrativeExpense` under "Other operating expenses", which is a part of operating
expenses, not that line. These stay blank rather than being filled with a near-match.

What filled them:
- **New SEC tags** for 24 page rows (see the plan's mapping table). Every new tag only fills a period
  the company already reports; it never adds a year or quarter.
- **Total debt from the balance sheet's own presentation** (`sec-facts.presentedDebt`). SEC's
  statement files (FSDS `pre.txt`) say which debt lines each 10-K/10-Q balance sheet shows. When
  every presented line is a figure we hold from that same filing, total debt is their sum
  (`sum_presented_lines`, checked again by `sec-coverage.verifiedField`). It refuses when a held
  debt figure is not on the face (Amazon carries current debt inside accrued expenses) and keeps
  a filed total unless it is smaller than one of its own lines. 1,400 issuers, 17,668 rows.
  Verified: CHEF FY2025 = 720.333M + 28.197M = 748.53M (SEC companyfacts).
- **A double count found and corrected:** the old `shortTermDebt` sum added `ShortTermBorrowings`
  and `LongTermDebtCurrent` when a company files one line under both tags (AMD: 874 + 874 = 1,748).
  Where the presentation is known it is now counted once (226 rows). Ball's filed
  `DebtLongtermAndShorttermCombinedAmount` of $2M (against $7.0bn of presented debt) is replaced by
  the presented sum, $7,012M.
- **FDIC call reports** for bank holding companies with no SEC statement rows, and **HTML
  statements** for filers without XBRL. Both are shown in the page's separately attributed
  supplemental panel and given to Ask as supplemental, never as SEC-verified rows.

Stocks with fewer filled rows than before (7, each checked):
- **WOLF cash flow 7 -> 0, ADVB income 7 -> 6:** a new 10-K adds a year that is partly blank. For
  WOLF, after the Chapter 11 fresh start SEC has only predecessor (2025-06-30 to 09-29) and successor
  (09-30 to 2026-06-28) operating cash flow, with no full year.
- **BBOT, BEAG, GSRF, UCFI cash flow:** these are SPAC-type filers. The new cash-flow net income and
  accounts-payable rows add an earlier year in which SEC has those two lines and no operating cash
  flow (BBOT FY2023: `NetIncomeLoss` -41,692 and nothing tagged operating). Other rows are then blank
  for that year, so they no longer count as filled in every period.
- **BTBD cash flow:** the company's own filings give FY2023 two end dates (2023-12-31 in its 2024 10-K,
  2023-12-29 in its 2025 10-K). The income statement already showed both columns before this work,
  and the new cash-flow rows now fill the second as well. Merging the dates would invent a period,
  so both are left as filed.

## Ask (AI research) gaps, every stock, before -> after

Every Ask company tool was called offline for all 5,603 stocks. The counts are stocks where the
model gets a blank:

| Gap | Before | After |
|---|---|---|
| `get_ratios_history` debt-to-equity | 4,534 | 3,781 |
| Health check "More cash than total debt" | 4,377 | 3,544 |
| Income interest expense (annual / quarterly) | 4,368 / 3,979 | 2,559 / 2,348 |
| Cash-flow D&A | 2,720 | 1,546 |
| Cash-flow stock-based compensation | 1,377 | 1,125 |
| Peer context: no peers | 5,603 (baseline run broken) | 1,244 (the stocks with no sector) |

Ask also gets the new rows (accounts payable, working-capital changes, debt issued and repaid, share
counts) with their filing. Bank holding companies with only FDIC data get those figures within the
requested period window. Before, a 3-year request returned every year (44KB).

## Headline (baseline, before the fill)

| | Tier 1 (4,191 regular US reporters) | Tier 2 (1,412 other stocks) |
|---|---|---|
| Stocks with every applicable annual row filled for 5 years | **0** | **0** |
| Stocks with no filled row at all | 33 | not measured |
| Stocks with >= 70% of applicable rows filled | **0** | not measured |

Tier 1 average of applicable rows filled for all 5 years, by industry: software 52%, consumer 51%,
industrial 50%, semis/hardware 49%, capital markets 44%, utility 44%, bank 42%, pharma/biotech 42%,
energy 42%, insurer 41%, generic 36%, REIT 35%. Examples: AAPL 44/69 rows, MSFT 41/70, JPM 26/64,
PGR 21/60, O 23/64, XOM 36/70.

## Why Tier 1 annual rows are blank

| Reason | Rows | What it means |
|---|---|---|
| `not_reported` | 50,829 | SEC has no such line for that company and year. Legitimately blank. |
| `unmapped_sec_has_it` | 49,595 | **We never read this line from SEC, and SEC has it.** Fixable by mapping. |
| `sec_has_alt_tag` | 23,968 | We read a line for this field, but this company files it under a different tag. Fixable. |
| `not_applicable` | 20,331 | Industry does not have this row. Excluded from counts. |
| `unmapped_not_reported` | 18,685 | Unmapped, and SEC does not have it either. |
| `computed_line_not_built` | 8,134 | EBIT and EBITDA: the page expects them, nothing computes them. Fixable. |
| `no_statement_rows` | 6,068 | The statement has no rows for that stock (124 stocks have no income statement, 33 no balance sheet). |
| `sec_has_mapped_tag` | 3,318 | We map the tag and SEC has it, yet the cell is blank. Needs investigation (validation or period alignment). |
| `formula_blank_by_design` | 1,823 | Derived row whose inputs are present. |
| `per_share_withheld` | 444 | Per-share values withheld by the share-count check. |

About **77,000 blank annual rows (49,595 + 23,968 + 3,318) are fixable**, against about 69,500 that SEC genuinely does not report (50,829 + 18,685).

## Rows to fix first (Tier 1, blank for every stock, SEC has the number)

All of these are filled for **0 of 4,191** stocks today:

| Statement | Row | Stocks where SEC has it | Tag to read |
|---|---|---|---|
| Cash flow | Net income | 4,065 | `NetIncomeLoss` / `ProfitLoss` |
| Cash flow | Net change in cash | 4,055 | `CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect` |
| Income | Depreciation & amortization | 3,758 | `DepreciationDepletionAndAmortization`, `Depreciation` |
| Income | Shares outstanding | 3,739 | `WeightedAverageNumberOfSharesOutstandingBasic` |
| Balance | Common stock | 3,519 | `CommonStockValue` |
| Cash flow | Change in operating liabilities | 3,389 | `IncreaseDecreaseInAccountsPayable`, `...OperatingLiabilities` |
| Balance | Accounts payable | 3,270 | `AccountsPayableCurrent` |
| Balance | Other current assets | 3,064 | `PrepaidExpenseAndOtherAssetsCurrent`, `OtherAssetsCurrent` |
| Income | Other non-operating income | 3,012 | `NonoperatingIncomeExpense`, `OtherNonoperatingIncomeExpense` |
| Cash flow | Stock issued | 2,943 | `ProceedsFromIssuanceOfCommonStock` |
| Cash flow | Change in operating assets | 2,946 | `IncreaseDecreaseInPrepaidDeferredExpenseAndOtherAssets` |
| Cash flow | Change in receivables | 2,764 | `IncreaseDecreaseInAccountsReceivable` |
| Balance | Other non-current liabilities | 2,389 | `OtherLiabilitiesNoncurrent` |
| Cash flow | Change in inventory | 1,949 | `IncreaseDecreaseInInventories` |
| Balance | Treasury stock | 1,654 | `TreasuryStockValue` |
| Cash flow | Debt issued / repaid, net | 1,683 | `ProceedsFromIssuanceOfLongTermDebt` |
| Balance | Cash & short-term investments | 1,206 + 868 via other tags | `CashCashEquivalentsAndShortTermInvestments`, else cash + short-term investments |

Next group: filled for a minority only. Interest expense (636 filled, 2,184 more via
`InterestExpenseNonoperating`), Other operating expenses (101 filled, 2,428+521 more), Short-term debt
(302 filled, 1,659 more), Dividends paid (579 filled, 1,116 more via `PaymentsOfDividendsCommonStock`).

## Page-side bugs (not data)

- **EBIT and EBITDA are never computed** (4,067 stocks): the rows exist and nothing builds them.
- **Loans** row is filled for 0 banks although 266 report a tag for it.
- **Cash-flow "Net income"** child is never filled, and income-statement "Shares outstanding" is never filled.
- **Stock-based compensation** sits under financing instead of operating (found while reading `company.js`).
- **Cash & short-term investments** is blank for 2,067 stocks that have no separate short-term
  investments; it should fall back to cash alone.

## Verified by hand

- AAPL accounts payable: SEC `AccountsPayableCurrent` = $69.86B (FY2025-09-27) and $68.96B (FY2024); our payload has no value. Audit says `unmapped_sec_has_it`. Correct.
- AAPL net income FY2024: SEC `NetIncomeLoss` = $93.736B; our cash-flow payload has none. Correct.
- Row labels match the page: `backend/test/audit-statement-rows.test.js` (4 tests, passing).
- Counts agree with `financial-coverage-summary.json` (e.g. Revenue 4,751 audit vs 4,733 summary; the audit
  counts listings and only the latest 5 years, so small differences either way are expected).
- Every unmapped row has 0 filled stocks, as it should.

## Not done

- Opening `/company.html?symbol=X` in a browser for the 10 spot-check stocks. The audit builds the same
  payload the route serves, but the rendered pages have not been compared.
- Tier 2 beyond the reason counts above (1,540 blank rows had no SEC file; per-stock Tier 2 completeness was not computed).
- Funds (no statements; separate audit).

## Files

- `by-stock.csv` (10 MB): one row per stock with filled/gappy counts and each missing row's reason.
- `by-row.csv`: row x reason counts and the SEC tags that would fill them. This is the fix list.
- `frontend/data/statement-completeness.json`: compact per-symbol counts for the search dropdown.
