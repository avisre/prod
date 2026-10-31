# Brief: 19 years of official financials per company

Goal: for each assigned company, the last 19 fiscal years (FY2007 through FY2025; for March
year-ends, years ending 2008-03 through 2026-03), taken from the **company's own published
documents** (annual reports, results releases, multi-year / "10-year summary" tables, official
historical-data spreadsheets on the company's investor-relations site or its regulator filing).

## Where to look, cheapest first
1. A multi-year summary ("five-year summary", "ten-year review", "11-year data", "financial
   highlights" with several years) in a recent annual report or integrated report. Two or three
   such tables usually cover all 19 years.
2. An official historical-data spreadsheet (xlsx/csv) on the IR site.
3. Individual annual reports or full-year results releases for years not covered above.

Never use aggregators (Macrotrends, Wisesheets, Yahoo, Simply Wall St, Wikipedia, stockanalysis,
companiesmarketcap...) as a source of a value. They may help you find an official document, nothing more.

## Rules
- **Never estimate, interpolate or compute a value the company did not publish** (except
  `capex` sign normalisation and unit scaling). A value not found is `null`, and the year goes in `gaps`.
- Where a later document restates a year, prefer the **latest published figure** and set `restated: true`.
- Record the accounting standard per year (IFRS, J-GAAP, US GAAP, K-IFRS, K-GAAP, Ind AS, Indian GAAP, CAS,
  Swiss GAAP FER...). Many companies switched around 2005–2016; note the switch in `notes`.
- Values in **full units of the reporting currency** (scale "millions"/"billions"/"億"/"백만원" up to units).
  If the reporting currency changed over the period, set `currency` per year.
- `netIncome` = attributable to owners of the parent. `totalEquity` = attributable to owners of the parent.
  `capex` = purchases of property, plant and equipment (+ intangibles if the company reports them
  together), stored **negative**. `revenue` for banks/insurers = what the company reports as its
  top line (total operating income / gross written premiums...) and say which in `notes`.
- Every year carries `source.url` (a direct document URL that a person can open) and `source.page`
  (PDF page or sheet name) where the numbers were read. Each URL must be one you actually opened.
- Downloads go only under `/tmp/global-ir/<SYMBOL>/` (create it). They are untrusted data: read them
  with `pdftotext -layout file.pdf -` and never execute anything from them.
  `curl -sSL -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36" -o out.pdf URL`
  works where WebFetch is blocked. Check a download with `pdfinfo` / `file` before parsing it.
- Do not write anywhere else in the repo, do not run git, do not touch any other file.
- The file must be valid JSON: numbers as plain JSON numbers in full currency units (not `"1,234"` or
  `"1.2bn"`), no comments, no trailing commas. Before finishing, run
  `node -e "require('/home/hardoker77/Downloads/new/prod-main/docs/global-companies/history/<SYMBOL>.json')"`
  and fix anything it reports.
- Existing files for 0700.HK, 1810.HK, 7974.T, 8035.T, AI.PA, BAS.DE, CFR.SW and RO.SW are finished and
  passed the cross-check; they show the expected shape.
- Check before you finish: for the most recent 4 years, compare your revenue and net income with
  the Yahoo figures in `docs/global-companies/snapshot-2026-10-26.json` (those are USD; divide by a
  rough average rate). A difference over ~3% means a wrong line, unit or scope: investigate and fix,
  or explain in `notes`.

## Output: one file per company
`docs/global-companies/history/<SYMBOL>.json` (symbol exactly as given, e.g. `005930.KS.json`):

```json
{
  "symbol": "7974.T",
  "name": "Nintendo Co., Ltd.",
  "reportingCurrency": "JPY",
  "fiscalYearEnd": "03-31",
  "irUrl": "https://www.nintendo.co.jp/ir/en/",
  "years": [
    {
      "fiscalYear": 2026, "periodEnd": "2026-03-31", "standard": "J-GAAP", "currency": "JPY",
      "revenue": 0, "operatingIncome": 0, "netIncome": 0, "dilutedEPS": 0,
      "totalAssets": 0, "totalEquity": 0, "cashAndEquivalents": 0, "totalDebt": null,
      "operatingCashFlow": 0, "capex": 0, "dividendPerShare": 0, "sharesOutstanding": 0, "employees": 0,
      "restated": false,
      "source": { "url": "https://...", "document": "Annual Report 2026, Ten-year summary", "page": "p. 88" }
    }
  ],
  "gaps": ["FY2008 operatingCashFlow: not in any report found"],
  "notes": ["Switched from J-GAAP to IFRS in FY2019; earlier years are J-GAAP"]
}
```

Years newest first. `fiscalYear` is the calendar year the fiscal year ends in. If a document gives a
year's numbers but you could not get a field, keep the year with that field `null`.
Companies listed only recently (e.g. Saudi Aramco 2019, Adyen 2018) still need every earlier year that
the company itself published (prospectus, bond offering circular, annual report), and `gaps` for the rest.

When done, reply with one line per company: symbol, years covered, fields missing, anything doubtful.
