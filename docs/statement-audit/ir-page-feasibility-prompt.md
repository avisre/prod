# Task: Can investor-relations pages fill our missing financial-data cells?

You are researching a data-coverage problem for a stock-analysis web app. Answer
with analysis, evidence, and a recommendation. Research only — do not contact
companies (no emails, web forms, or sign-ups), do not push code, do not modify
the production data.

## Background (facts from the 2026-11-01 audit — treat as given)

The app's "Stocks & funds" page renders income / balance / cash-flow statements
for 5 annual and 8 quarterly periods per stock. Data flows from SEC XBRL
(companyfacts + extracted statement lines) into per-CIK JSON files.

Audit of 5,560 stocks found 167,026 missing annual cells:

| Bucket (why blank) | Cells | Meaning |
|---|---|---|
| `not_reported` | 105,086 | Company does not file this line to the SEC at all |
| `sec_has_alt_tag` | 20,843 | Filed, but under an XBRL tag our extractor does not read |
| `no_statement_rows` | 24,407 | SEC file exists but zero statement rows were extracted (288 stocks) |
| `missing_unchecked` | 13,970 | Tier-2 stock, no XBRL facts in the bulk zip to check against |
| `sec_has_mapped_tag` | 1,440 | Filed under a tag we DO read, but extraction dropped the value |
| `no_sec_file` | 1,280 | No SEC filing on record (19 stocks) |

Additionally every stock has some blank quarterly cells, and 307 stocks have
completely blank statements. Worst offenders include EML (63 fillable gaps),
BTBD (44), FUL (40), GIFT (33), FLYX (31), BLBD (29).

## The question

**Could the blanks be filled by pulling figures directly from each company's
investor relations (IR) page — earnings press releases, IR-site financial
tables, PDF/Excel supplements — instead of (or in addition to) SEC XBRL?**

Investigate:

1. **Per bucket, is IR data actually a solution?**
   - `sec_has_alt_tag` / `sec_has_mapped_tag`: the value exists in the SEC
     filing. Does the IR page usually repeat it? Is it cheaper to just fix
     XBRL tag extraction instead?
   - `not_reported`: if the company does not report the line to the SEC, does
     the IR page sometimes still publish it (segment detail, non-GAAP
     reconciliations, investor decks)? Which lines are realistically
     recoverable this way and which are not (e.g., banks' COGS)?
   - `no_statement_rows` / `no_sec_file`: can IR pages act as a primary source
     where SEC XBRL yields nothing (recent IPOs, foreign filers, trusts)?

2. **Formats and parsing effort.** What do IR pages actually contain — HTML
   tables, PDF press releases (scanned vs. text), XLSX supplements, embedded
   charts? Estimate parsing effort and reliability per format.

3. **Symbol → IR URL discovery.** Can the IR page be found automatically
   (company website + /investors, SEC companyfacts website field, Yahoo
   profile, EDGAR index)? How stable are the URLs? Would a maintained
   mapping table be required?

4. **Spot-check evidence.** Pick ~10 stocks from the offender list (e.g., EML,
   BTBD, FUL, GIFT, FLYX, BLBD, INFQ, ZURA, AIB, HSCS) and actually visit
   their IR pages. For each, report: the IR URL, which audit buckets its
   published data would fill, and whether the missing values actually appear
   there.

5. **Constraints.** robots.txt / ToS / rate limits per site; whether storing
   and displaying financial facts raises legal issues; update cadence (data
   must refresh at least quarterly, ideally on earnings day).

6. **Cost vs. alternative.** Compare building an IR scraper against fixing the
   XBRL extraction (mapped-tag + alt-tag buckets are extraction bugs — the
   value is already in our SEC cache). Estimate effort for both.

## Required output

1. Decision table: bucket → IR-fillable? (yes / no / partial) → evidence →
   effort → risk.
2. Spot-check results for the 10 stocks named above (IR URL + what it fills).
3. Recommendation: build the IR scraper, or fix XBRL extraction first, or a
   hybrid (e.g., XBRL for filings, IR only for `no_statement_rows` stocks)?
   Include a phased plan if positive.
4. A short "what data would we be missing forever" list — lines where neither
   SEC nor IR publishes a figure, so the blank is correct by design.

## Acceptance criteria

Every bucket must have a clear yes/no/partial answer backed by at least one
concrete example you actually fetched. The recommendation must be actionable
(e.g., "fix these N extractor functions first; IR scraping is only worth it for
stocks in the `no_statement_rows` bucket").
