# Plan: extract all Canadian companies — 2026-11-08

Companion to `docs/qa/canadian-companies-audit-2026-11-08.md`. Staged, each phase
measurable, no writes/pushes without owner approval per CLAUDE.md.

## Scope split

- **A. Enumerate** — one authoritative Canadian universe (today: no country field anywhere, floor estimate ~158).
- **B. Fix extraction quality** for the ~85 SEC-covered Canadians (stale quarters, missing 4-quarter runs, currency labels).
- **C. Extend the universe** to TSX-only Canadians (currently zero; gated decision).

---

## Phase A — Authoritative enumeration (1–2 h, read-only + one committed extract)

1. **Country source.** SEC company submissions carry business/incorporation country. Pull once via `backend/sec-throttle` (or the SEC bulk submissions zip) for the ~5.5k coverage CIKs; tag `country === 'Canada'` from `addresses.business.country` with `stateOfIncorporationDescription` as fallback.
2. **Triangulate** with the two existing signals: fundamentals `overview.Country === 'Canada'` (86) and `screen-index` rows with `financialCurrency === 'CAD'` (75). Investigate every disagreement explicitly (expected: USD-reporting Canadians like most miners, plus mislabeled ENB/RY/HOVR).
3. **Write the extract** (the deliverable): `frontend/data/canadian-companies.json` + `docs/data/canadian-companies.csv` with per-company: symbol, CIK, name, exchange, sector, reportingCurrency, cadence, coverage status, latestAnnual, latestInterim, latestQuarterEnd, fourConsecutiveIncomeQuarters, marketCap.
4. **Persist country upstream:** add `country` to `scripts/build-financial-coverage.js` records so Canada becomes queryable without this sidecar. Guard test that every Canadian symbol resolves to a coverage record.

**Exit criteria:** single count, reproducible; three sources reconcile or each diff is explained in the CSV's notes column.

## Phase B — Extraction quality for covered Canadians (the real backlog)

1. **Measure per-ticker failure mode** with `scripts/audit-page-gaps.js` filtered to the Canada list (it already emitted 25 Canada rows on 2026-10-31). Classify each:
   - *No XBRL at all* (AYA `no_facts`, OGC no annual) → existing `scripts/extract-html-statements.js` path (built exactly for issuers "whose only financial document is a prospectus or a 6-K"; 266 supplemental stores already committed).
   - *Annual OK, interims stale* (the 18 from the audit: AEM, IAG, GROY, POET, B, BN, BEP, FNV, WPM, TRI, DSGX, RY, AQN, DCBO, ELVA, TFPM, TRX, USAS) → 6-K interim extraction gap.
2. **6-K interim extraction.** 40-F filers report quarters in 6-K exhibits, not 10-Qs.
   - Discover: `node scripts/extract-html-statements.js --discover`, intersect with Canada list.
   - Extend the HTML statement rules where needed for 6-K interim exhibits (condensed interim statements, IFRS, no review opinion). Keep the validation bar: printed dates, stated scale/currency, balance-sheet identity must hold.
   - Extract per-ticker with explicit symbol arguments first (no `--all`), review a sample, then batch.
3. **Currency reconciliation.** Record `financialCurrency` into coverage records from extraction units; fix page display where a CAD filer's US listing shows USD TTM figures (ENB, RY, HOVR first, then spot-check the other 72 CAD filers).
4. **Regenerate + validate:** `build-financial-coverage.js` → `build-public-stock-index.js` → `validate-stock-coverage.js`; rerun the audit query.

**KPIs (Canada set):** stale-quarter rate 23% → ≤6% (universe parity); `fourConsecutiveIncomeQuarters` 19% → ≥60%; zero `unavailable`; OBAWU documented as intentionally excluded (SPAC unit, matches instrument-type policy).

## Phase C — TSX-only Canadians (DECISION GATE — needs owner yes/no)

Today they are out of scope by definition (universe = US exchange-listed equities), and the
global snapshot of 50 famous non-SEC companies has zero Canadians — while buyer requests for
TSX names (Bird/BDT.TO, Coveo/CVO.TO, Covalon) have already failed with COMPANY_NOT_FOUND.

If approved:

1. Add a Canada section to `COMPANIES` in `scripts/global-companies-snapshot.js` — top ~30–60 TSX names by market cap plus the specifically requested ones; `filingSource = 'SEDAR+'`, source link `https://www.sedarplus.ca/`.
2. Run the snapshot (Yahoo via the site's own field mapping + `fx-conversion.js`, CAD→USD). Values are **not filing-verified** — same documented caveat as the European entries.
3. Store under `docs/global-companies/` (data-only commit). Decide separately whether these ever get product pages; that is a product change, not part of this plan.
4. Estimated cost: one bounded Yahoo batch run, well inside the existing snapshot's footprint.

If declined: record the decision in the audit doc and answer future TSX ticker requests with the known-gap line.

**Owner decision (2026-11-08): source from SEDAR+, the actual Canadian filing
system, not Yahoo.** Implementation is `docs/qa/sedar-extraction-plan-2026-11-08.md`;
pilot status and the PDF extractor's receipts are in
`docs/qa/sedar-pilot-2026-11-09.md` (2 of 5 pilot issuers verified end-to-end as
of 2026-11-09).

## Phase D — Ship gates (all repos rules apply)

- Tests via `node scripts/predeploy.js --list` on the changed set; coverage/screen-index source changes map to their audit suites automatically.
- Any `frontend/data/**` data commit **must not** carry the skip marker (deploys read it from the deployed filesystem).
- Commit locally, report, and **stop** — `git push` / `gh workflow run` only on the owner's explicit instruction in-conversation.

## Order & rough budget

| Phase | Effort | External calls | Writes |
|---|---|---|---|
| A | 1–2 h | SEC (throttled) or one bulk zip | 2 new data files + builder field |
| B | 1–2 d depending on 6-K rule extensions | SEC filings, throttled 8/s | supplemental-financials stores, coverage/index regenerations, pages |
| C | ~0.5 d if approved | one Yahoo batch | global-companies snapshot |
| D | per change | none | commits only; no push |

**First action when told to start:** Phase A step 1 (read-only SEC enumeration), producing the count and the three-way reconciliation before anything is written to the product data.
