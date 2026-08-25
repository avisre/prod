# StockPortfolio.pro bulk data corpus — licence terms

*Plain English. One page. If something here is unclear, ask before you buy.*

## What you get

A one-off bulk export, delivered as CSV **and** JSON:

| File | What's in it |
|---|---|
| `companies` | Company identity as filed: ticker, CIK, exchange, reporting currency, sector, industry. |
| `fundamentals-panel` | Income statement, balance sheet and cash flow line items **as filed** — one row per company per fiscal period, annual and quarterly. |
| `filing-changes` | Period-over-period changes drawn from our cached filing-change reports: the metric, both periods' values, the direction, and a materiality score. |
| `manifest.json` | Generation timestamp, row counts, and the exclusion list below. |

**Every row carries a `sourceUrl`** pointing at the filer's own SEC EDGAR record. Nothing in this corpus is unsourced, and you can verify any figure against the original filing.

## What you don't get, and why

- **No personal or user data of any kind.** No customers, no accounts, no usage, no email addresses. The export process never reads a collection containing a user reference.
- **No written analysis.** Our report summaries, narrative headlines, change commentary and pulled quotes are excluded. You're licensing filed facts and the deterministic differences between them, not our editorial.
- **No market data.** Price series, market caps, P/E, PEG, analyst targets, 52-week ranges and other quote-derived figures come from a third-party market-data source. We don't have redistribution rights to those, so they're not in the corpus — and you should be suspicious of anyone who does include them at this price.
- **No live feed.** This is a snapshot at a point in time, not an API and not a subscription.

## What you may do

- Use it internally: research, backtesting, model training, product development.
- Publish derived results, charts and findings.
- Keep it indefinitely. There's no expiry on the licence for the data you received.

## What you may not do

- **Resell or redistribute the corpus**, in whole or in substantial part, whether as-is, reformatted, or as a dataset inside another product.
- **Republish it as a competing dataset or data API.**
- Share your download link or the files with anyone outside your organisation.

The line is straightforward: build things with it, don't hand it on.

## Price

**$500 – $2,000, one-off**, depending on scope (how many companies, how far back, and whether the filing-changes table is included). There's no recurring fee and no seat count. Ask for a quote with your intended scope and we'll give you a fixed number.

## Delivery

1. You pay the invoice.
2. We generate your export and put it on S3.
3. You get a **signed URL that expires** — 7 days by default, longer on request.

The link is single-purpose and not self-serve: a person generates each one after the payment clears. If your link expires before you've downloaded it, email us and we'll issue another.

## Warranty

The figures are taken from public SEC filings and are provided as-is. We don't warrant that a filer's own numbers are correct, and nothing in this corpus is investment advice. Verify anything you're going to rely on against the `sourceUrl` in the row.

## Contact

support@stockportfolio.pro
