# Google Search Console exports

## Property and access

- Property used: `sc-domain:stockportfolio.pro` (the domain property for `stockportfolio.pro`; it covers protocol and subdomain variants).
- Permission confirmed: `siteFullUser` for the existing read-only service account.
- Acquisition method: Google Search Console Search Analytics API using the service-account file already stored outside the repository at `/home/hardoker77/.local/share/secrets/gsc_service_account.json`. No browser cookies, OAuth tokens, passwords or keys were copied into this repository.
- Retrieved at: 2026-08-10 07:39:58 UTC.

## Date ranges and files

Search Console data is delayed, so both reports end on 2026-08-07.

| Window | Start | End | Query rows | Page rows | Query + page rows |
|---|---|---|---:|---:|---:|
| Last 3 months | 2026-05-10 | 2026-08-07 | 632 | 1,697 | 981 |
| Last 12 months | 2025-08-08 | 2026-08-07 | 632 | 1,697 | 981 |

Files are UTF-8 CSV with `clicks`, `impressions`, `ctr` (decimal), and `position`:

- `queries-3m.csv`, `pages-3m.csv`, `query-page-3m.csv`
- `queries-12m.csv`, `pages-12m.csv`, `query-page-12m.csv`
- A fresh fetch also requests `query-country-*`, `query-device-*` and
  `query-date-*` rows for outlier and comparison breakdowns; those files are
  absent when the existing export was created without those dimensions.
- `acquisition.json` contains non-secret retrieval metadata and row counts.

The query+page report was retrieved directly with both Search Analytics dimensions. No query/page relationships were inferred by joining separate exports. The identical row counts across windows mean the property has no older sampled data available through this account/API window; the 3-month report is therefore the strongest current signal.

## Limitations

- Search Console omits some low-volume rows and applies privacy thresholds.
- Metrics are aggregates for the selected window and are not a real-time visitor count.
- Search Console positions are averages, not guarantees for an individual search.
- The service-account identity and property permission are recorded for auditability only; credentials remain outside Git.

`python3 scripts/analyze-gsc-seo.py --analyze-only` writes the position,
outlier, comparison-quality, revenue-quality, family-selection and pilot
reports under `seo-data/`. The pilot report keeps `SEO_ACTIVATION_PILOT` dark;
the generated eligibility manifest is based only on observed query/page rows.
