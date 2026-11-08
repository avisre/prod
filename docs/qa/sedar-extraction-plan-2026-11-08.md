# Plan: SEDAR+ extraction for TSX-only Canadian companies — 2026-11-08

Owner direction: get TSX-only Canadian data from the *actual Canadian SEC
equivalent* (SEDAR+, sedarplus.ca, run by the CSA), not from Yahoo. This
replaces Phase C of `docs/qa/canadian-extraction-plan-2026-11-08.md`.

## Feasibility findings (measured 2026-11-08, this machine)

- `https://www.sedarplus.ca/` redirects plain-HTTP clients to
  `validate.perfdrive.com` → **ShieldSquare bot protection** on the whole site,
  including its JSON API (`/csa-party/...document/search` 302s).
- Implication: no datacenter automation. Retrieval needs a real browser
  (Playwright, headed first-run), a residential connection, human-in-the-loop
  for the challenge, and a low request rate. Not runnable in CI.
- SEDAR+ documents are **mostly PDF** (Canada has no broad XBRL mandate), so
  "filing-verified" here means statement tables extracted *from the filed PDFs*
  under the same validation bar as `scripts/extract-html-statements.js`:
  printed dates, stated scale and currency, balance-sheet identity must hold,
  every value keeps a receipt (page, row label, cell text).
- Terms-of-use for automated retrieval are unreviewed → owner reviews before
  any automated run; if they prohibit it, fall back to small-scale manual
  downloads (public filings, human-driven).

## Pipeline

### S0 — Pilot, 5 companies, manual-first (proves quality before any scale)

Targets: the three TSX names already requested by buyers (Bird Construction,
Coveo, Covalon) + two clean-table controls (Constellation Software, Couche-Tard).

1. Owner/machine opens SEDAR+ in a browser, passes the human check once.
2. Locate each issuer profile, find annual FS + latest interim FS PDFs,
   download ~10 files manually or semi-manually.
3. Build `scripts/extract-sedar-statements.js` (PDF port of the HTML rules):
   - table detection in filed PDFs (pdftotext/poppler or pdf.js — measure
     which survives real Canadian layouts: IFRS, two-statement format, CAD/USD)
   - same rejection behavior: any failed identity rejects the whole statement,
     reason logged, nothing estimated
4. Success metric: ≥4/5 pilot companies yield a full statement set (IS, BS, CF)
   with verification receipts. If PDF quality fails this, stop and report —
   do not lower the validation bar.

**Status 2026-11-09:** steps 1–3 done for the first two issuers. Filed PDFs for
Bird Construction (annual + Q1/Q2 2026 interim) and Coveo (FY2026 annual + Q2
FY2027 interim) extract to verified BS/IS/CF via
`scripts/extract-sedar-statements.js`; 5/5 documents verified, 2/5 issuers done.
Receipts and the extraction rules: `docs/qa/sedar-pilot-2026-11-09.md`. Covalon,
Constellation and Couche-Tard are still to retrieve (owner browser session).

### S1 — Index of filings (after S0 passes)

- Per issuer, record: SEDAR+ issuer number, document list (type, period, link).
- Bounded browser session (Playwright on the owner's profile, watch-mode), a
  few requests per minute, one issuer at a time. Store index as
  `frontend/data/sedar-index.json`-style committed file with `checkedAt`.

### S2 — Extraction store

- SEDAR+ issuers have no SEC CIK → parallel committed store keyed by SEDAR+
  issuer number + ticker (`BDT.TO`): same shape as `supplemental-financials`,
  `sourceType: 'issuer_filing'`, document URL + filing date + page receipts,
  reportingCurrency from the statement itself (CAD or USD — many TSX issuers
  report USD).
- Annual + interim cadence: FS (annual, audited) and IFS (quarterly, usually
  unaudited). Interims feed the quarter-run fields that SEC Canadians lack.

### S3 — Refresh cadence and scope growth

- Manual/quarterly refresh trigger first; only automate further after several
  clean runs, and only if ToS allows.
- Grow from the pilot 5 → the requested list → top-~50 TSX by market cap, one
  batch at a time, success-rate gate per batch.

### Out of scope (separate decisions)

- Product pages for TSX tickers (a product change; data lands in committed
  stores/docs first).
- SEC-listed Canadians (Phase B of the main plan already handles those via
  SEC filings).
- Prices/quotes for TSX (can stay Yahoo-based; this plan is about
  filing-verified fundamentals).

## Risks / what would stop it

| Risk | Handling |
|---|---|
| ShieldSquare blocks browser session | manual one-filing-at-a-time downloads; owner performs challenge |
| SEDAR+ ToS prohibit automated retrieval | stop automation, manual-only, document decision |
| Scanned/image PDFs (tables unreadable) | measure in pilot; skip those issuers rather than estimate |
| Currency/scale ambiguity in PDF | extractor's existing rule: currency must be stated, else reject |

## Gates

1. Owner OK to run the pilot (S0) — manual-ish, 5 companies.
2. Owner reviews ToS outcome before any automation (S1+).
3. No push/deploy without explicit instruction; data commits carry no
   skip marker.

**First action on approval:** S0 step 1–3 for Bird Construction only (one
issuer end-to-end, smallest unit of proof), then report the extraction
receipts before doing the other four. Done 2026-11-09 (Bird and Coveo verified);
the next retrieval is Covalon, then Constellation and Couche-Tard.
