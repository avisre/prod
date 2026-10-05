# Financial data foundation — 5 October 2026

The dated exchange audit identifies 5,607 common-share/ADR/REIT listings and
5,522 SEC-identified issuers. Eleven listings lack a confirmed CIK. Funds and
legacy units/rights are separate; the 6,099 retained public-directory records
are not the stock denominator.

The complete issuer reconciliation increased four consecutive revenue/net-income
quarter histories to 3,376. Every exchange row has a classification outcome and
every in-scope listing has a coverage record. Field, period, industry and cadence
coverage are separate. This release does not claim every financial metric exists.

One core extraction failure retains dated last-good evidence. Original-document
retrieval still has 45 failed issuers after retry, and 76 documents need supported
extraction. Custom KPIs and some foreign interim formats need reviewed mappings.

The full backend suite passed 1,294 of 1,299 tests. Five failures are the previously
reproduced production-main failures listed in `release.json`. The release's
targeted, dataset, rendering and resource gates must pass separately.

Live Yahoo checks retrieved AMD, TSM and BBAI history without model calls. TSM
retained TWD. Local desktop/mobile browser checks passed without overflow or
script errors. Authenticated production rendering remains unmet because the
login page returned HTTP 403. API verification does not substitute for it.

Production Mongo bounds and shared SEC allocation passed workflow 37262137896.
The previous production SHA 264b32aa and its matching dataset remain the rollback
point. The longer Ask-report release remains separate. Zero model calls were used.
