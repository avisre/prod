# SEDAR+ pilot (S0) — extraction receipts, 2026-11-09

Companion to `docs/qa/sedar-extraction-plan-2026-11-08.md`. This is the S0
report the plan asks for before scaling: what was retrieved, what the new PDF
extractor proves, and what is still open.

**No product data was written.** Everything here is local: the filed PDFs and
the `pdftotext -layout` text live in `.cache/sedar/` (gitignored), receipts in
`.cache/sedar/receipts/<file>.json`, and the extractor is
`scripts/extract-sedar-statements.js` with `backend/test/sedar-statements.test.js`.

## Retrieved so far — 2 of the 5 pilot issuers

| Issuer | Ticker | SEDAR+ issuer | Documents | Statements |
|---|---|---|---|---|
| Bird Construction Inc. | BDT.TO | 000030894 | FY2025 audited annual (W3352), Q1 2026 interim (W3281), Q2 2026 interim (W3210) | BS, IS, CF each |
| Coveo Solutions Inc. | CVO.TO | not recorded | FY2026 audited annual (W9282), Q2 FY2027 interim (W9921) | BS, IS, CF each |

Not yet retrieved: Covalon (COV.V), Constellation Software (CSU.TO),
Couche-Tard (ATD.TO). Those need the owner's browser session (ShieldSquare);
nothing about them is claimed here.

## Result: 5/5 retrieved documents yield a full, verified statement set

Every statement below was accepted only after its printed identities held in
every printed column; a failed check rejects the whole statement.
| document | page | statement | currency/scale | columns | checks | verified |
|---|---|---|---|---|---|---|
| BDT_2026Q1_interim_sedar-W3281.pdf | 2 | balance_sheet | CAD / ×1000 | 2026-03-31; 2025-12-31 | assets = liabilities + equity: passed; assets = total liabilities and equity: passed; current + non-current assets = total assets: passed | yes |
| BDT_2026Q1_interim_sedar-W3281.pdf | 3 | income_statement | CAD / ×1000 | 2026-03-31 (3m); 2025-03-31 (3m) | revenue - cost = gross profit: passed; pre-tax - tax = net income: passed | yes |
| BDT_2026Q1_interim_sedar-W3281.pdf | 6 | cash_flow | CAD / ×1000 | 2026-03-31 (3m); 2025-03-31 (3m) | beginning + net change = end: passed; cash-flow net income = income-statement net income: passed; cash-flow net income = income statement net income (same period): passed | yes |
| BDT_2026Q2_interim_sedar-W3210.pdf | 2 | balance_sheet | CAD / ×1000 | 2026-06-30; 2025-12-31 | assets = liabilities + equity: passed; assets = total liabilities and equity: passed; current + non-current assets = total assets: passed | yes |
| BDT_2026Q2_interim_sedar-W3210.pdf | 3 | income_statement | CAD / ×1000 | 2026-06-30 (3m); 2025-06-30 (3m); 2026-06-30 (6m); 2025-06-30 (6m) | revenue - cost = gross profit: passed; pre-tax - tax = net income: passed | yes |
| BDT_2026Q2_interim_sedar-W3210.pdf | 6 | cash_flow | CAD / ×1000 | 2026-06-30 (3m); 2025-06-30 (3m); 2026-06-30 (6m); 2025-06-30 (6m) | cash-flow net income = income-statement net income: passed; cash-flow net income = income statement net income (same period): passed | yes |
| BDT_FY2025_annual_audited_sedar-W3352.pdf | 8 | balance_sheet | CAD / ×1000 | 2025-12-31; 2024-12-31 | assets = liabilities + equity: passed; assets = total liabilities and equity: passed; current + non-current assets = total assets: passed | yes |
| BDT_FY2025_annual_audited_sedar-W3352.pdf | 9 | income_statement | CAD / ×1000 | 2025-12-31 (12m); 2024-12-31 (12m) | revenue - cost = gross profit: passed; pre-tax - tax = net income: passed | yes |
| BDT_FY2025_annual_audited_sedar-W3352.pdf | 12 | cash_flow | CAD / ×1000 | 2025-12-31 (12m); 2024-12-31 (12m) | beginning + net change = end: passed; cash-flow net income = income-statement net income: passed; cash-flow net income = income statement net income (same period): passed | yes |
| CVO_FY2026_annual_audited_sedar-W9282.pdf | 8 | balance_sheet | USD / ×1000 | 2026-03-31; 2025-03-31 | assets = liabilities + equity: passed; assets = total liabilities and equity: passed | yes |
| CVO_FY2026_annual_audited_sedar-W9282.pdf | 10 | income_statement | USD / ×1000 | 2026-03-31 (12m); 2025-03-31 (12m) | revenue - cost = gross profit: passed; pre-tax - tax = net income: passed | yes |
| CVO_FY2026_annual_audited_sedar-W9282.pdf | 11 | cash_flow | USD / ×1000 | 2026-03-31 (12m); 2025-03-31 (12m) | beginning + net change = end: passed; cash-flow net income = income-statement net income: passed; cash + cash equivalents = end of period: passed; cash-flow net income = income statement net income (same period): passed | yes |
| CVO_Q2FY27_interim_sedar-W9921.pdf | 2 | balance_sheet | USD / ×1000 | 2026-09-30; 2026-03-31 | assets = liabilities + equity: passed; assets = total liabilities and equity: passed | yes |
| CVO_Q2FY27_interim_sedar-W9921.pdf | 4 | income_statement | USD / ×1000 | 2026-09-30 (3m); 2025-09-30 (3m); 2026-09-30 (6m); 2025-09-30 (6m) | revenue - cost = gross profit: passed; pre-tax - tax = net income: passed | yes |
| CVO_Q2FY27_interim_sedar-W9921.pdf | 5 | cash_flow | USD / ×1000 | 2026-09-30 (6m); 2025-09-30 (6m) | beginning + net change = end: passed; cash-flow net income = income-statement net income: passed; cash + cash equivalents = end of period: passed; cash-flow net income = income statement net income (same period): passed | yes |

## What the extractor does (and refuses to do)

Reads the `pdftotext -layout` text of a filed PDF — no model, no OCR, no
estimation. Rules, in the order they are enforced:

1. **Title on the page, issuer name above it.** Only the balance sheet, the
   income/loss statement and the cash-flow statement are extracted; the
   statement of changes in equity and the notes are deliberately skipped.
2. **Scale and currency as printed** — `(in thousands of Canadian dollars)`,
   `(expressed in thousands of US dollars)`. A bare `$`, a missing currency or
   two conflicting currencies rejects the statement. Values are stored × the
   printed scale; every value keeps its printed cell text.
3. **Columns from printed geometry.** Amounts are right-aligned; the extractor
   clusters their right edges (allowing the 1–2 character jitter pdftotext
   prints) and sets aside the note-reference column by its `Note(s)` header or
   by the fact that it holds only one- and two-digit integers.
4. **Every kept column needs a printed period**: a date for a point-in-time
   balance sheet, a date *and* a duration (3/6/9/12 months) for a flow. A bare
   year is resolved from the printed subtitle (`For the years ended December
   31, 2025 and 2024`); when no duration is printed anywhere, the statement is
   rejected rather than guessed.
5. **Printed identities must hold in every column**: total assets = total
   liabilities + total equity (and = "total liabilities and equity" when that
   line is printed), current + non-current assets = total assets, revenue − cost
   = gross profit, pre-tax − tax = net income, cash at end = cash at beginning +
   net change (with or without the printed FX line — issuers differ on whether
   that line is already inside the printed change, and both conventions are
   recorded), cash + cash equivalents = cash at end, and the cash-flow net
   income equals the income statement's for the same printed period.
6. **Receipts.** Each receipt records the PDF's SHA-256 and page count, the PDF
   page of each statement, the currency and scale as printed, the date/duration
   of each column and where it was resolved from, every row as printed, the
   dropped note column, and pass/fail/skip for each check.

Rows that the issuer prints as a subtotal without a label are kept, labelled
`(unlabelled)` and flagged — never merged into a neighbour. Repeated printed
labels (`SaaS subscription` under revenue and again under cost of revenue) are
kept in printed order, not de-duplicated, so a later mapping step has to use
position and section, not just the label.

## Known limits of this step

- **Two issuers, not five.** The pilot's success bar (≥4/5) is not met yet; it
  needs the other three filings, which need a browser session.
- **Only annual + interim primary statements.** No equity statement, no notes,
  no segments, no per-share detail beyond the printed row, and no XBRL-style
  tagging.
- **Layout-shaped, not universal.** The rules were proven on IFRS filings from
  two issuers (one CAD reporter, one USD reporter). An issuer that prints two
  statements side by side, or columns that are not right-aligned, will be
  rejected — that is the intended failure mode, and a rejection is reported with
  its reason rather than a partial statement.
- **SEDAR+ retrieval is still manual.** Nothing here automates the website; the
  PDFs arrive by the owner's session, and the plan's ToS question (S1) is still
  open.

## Next actions

1. Retrieve the remaining three pilot filings (Covalon, Constellation,
   Couche-Tard: annual + latest interim) and run
   `node scripts/extract-sedar-statements.js` again — the bar is 4/5 issuers with
   a complete, verified statement set.
2. If that passes, decide the shape of the S2 store (SEDAR+ issuer number +
   ticker key, `sourceType: 'issuer_filing'`, page receipts) before writing
   anything into `frontend/data/`.
3. Still open from the plan: SEDAR+ ToS review before any automation, and the
   product decision on whether TSX tickers get pages at all.
